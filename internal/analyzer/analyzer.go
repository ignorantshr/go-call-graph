package analyzer

import (
	"fmt"
	"go/ast"
	"go/token"
	"os"
	"path/filepath"
	"strings"

	"github.com/haoran-shi/go-call-graph/internal/model"
	"golang.org/x/tools/go/packages"
)

// Analyze loads and analyzes the Go project at the given directory.
func Analyze(dir string) (*model.ProjectAnalysis, error) {
	// Resolve to absolute path for consistent file references
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolving directory: %w", err)
	}
	dir = absDir

	cfg := &packages.Config{
		Mode: packages.NeedName |
			packages.NeedFiles |
			packages.NeedSyntax |
			packages.NeedTypes |
			packages.NeedTypesInfo |
			packages.NeedDeps |
			packages.NeedImports,
		Dir: dir,
	}

	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil, fmt.Errorf("loading packages: %w", err)
	}

	if len(pkgs) == 0 {
		return nil, fmt.Errorf("no packages found in %s", dir)
	}

	// Check for loading errors
	var errs []string
	for _, pkg := range pkgs {
		for _, e := range pkg.Errors {
			errs = append(errs, e.Error())
		}
	}
	if len(errs) > 0 {
		fmt.Fprintf(os.Stderr, "Warning: %d package loading errors:\n", len(errs))
		for _, e := range errs {
			fmt.Fprintf(os.Stderr, "  %s\n", e)
		}
	}

	result := &model.ProjectAnalysis{
		Root:      dir,
		Files:     make(map[string]*model.FileAnalysis),
		Functions: make(map[string]*model.FuncBlock),
	}

	// Collect package names
	seen := make(map[string]bool)
	for _, pkg := range pkgs {
		if !seen[pkg.PkgPath] {
			result.Packages = append(result.Packages, pkg.PkgPath)
			seen[pkg.PkgPath] = true
		}
	}

	// Extract functions from AST
	fset := pkgs[0].Fset
	for _, pkg := range pkgs {
		if len(pkg.Syntax) == 0 || len(pkg.GoFiles) == 0 {
			continue
		}
		for i, file := range pkg.Syntax {
			if i >= len(pkg.GoFiles) {
				break
			}
			filePath := pkg.GoFiles[i]
			src, err := os.ReadFile(filePath)
			if err != nil {
				continue
			}

			fa := &model.FileAnalysis{
				Path:    filePath,
				Package: pkg.PkgPath,
			}

			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok {
					continue
				}

				block := buildFuncBlock(fset, fn, pkg, src)
				fa.Functions = append(fa.Functions, block)
				result.Functions[block.ID] = block
			}

			result.Files[filePath] = fa
		}
	}

	// Build call graph
	callGraph, positions := BuildCallGraph(pkgs, fset)
	result.CallGraph = callGraph

	// Enrich function blocks with position info from SSA
	enrichWithCallGraphPositions(result, positions)

	return result, nil
}

func buildFuncBlock(fset *token.FileSet, fn *ast.FuncDecl, pkg *packages.Package, src []byte) *model.FuncBlock {
	startPos := fset.Position(fn.Pos())
	endPos := fset.Position(fn.End())

	block := &model.FuncBlock{
		Name:       fn.Name.Name,
		FilePath:   startPos.Filename,
		StartLine:  startPos.Line,
		EndLine:    endPos.Line,
		IsExported: fn.Name.IsExported(),
		Complexity: ComputeComplexity(fn),
	}

	// Build function ID
	pkgPath := pkg.PkgPath
	if fn.Recv != nil && len(fn.Recv.List) > 0 {
		recvType := exprToString(fn.Recv.List[0].Type)
		block.RecvType = recvType
		block.ID = fmt.Sprintf("%s.(%s).%s", pkgPath, recvType, fn.Name.Name)
	} else {
		block.ID = fmt.Sprintf("%s.%s", pkgPath, fn.Name.Name)
	}

	// Extract signature
	block.Signature = extractSignature(fset, fn, src)

	// Extract doc comment
	if fn.Doc != nil {
		block.Doc = fn.Doc.Text()
	}

	// Classify statements
	block.Statements = ClassifyStatements(fset, fn, pkg.TypesInfo, src)

	return block
}

func extractSignature(fset *token.FileSet, fn *ast.FuncDecl, src []byte) string {
	// Extract from "func" to the opening brace
	start := fset.Position(fn.Pos()).Offset
	var end int
	if fn.Body != nil {
		end = fset.Position(fn.Body.Lbrace).Offset
	} else {
		end = fset.Position(fn.End()).Offset
	}
	if start < 0 || end < 0 || start >= len(src) || end > len(src) {
		return fn.Name.Name
	}
	sig := strings.TrimSpace(string(src[start:end]))
	return sig
}

func exprToString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return exprToString(t.X)
	case *ast.SelectorExpr:
		return exprToString(t.X) + "." + t.Sel.Name
	case *ast.IndexExpr:
		return exprToString(t.X)
	case *ast.IndexListExpr:
		return exprToString(t.X)
	default:
		return "unknown"
	}
}

func enrichWithCallGraphPositions(result *model.ProjectAnalysis, positions map[string]token.Position) {
	// For each function in the call graph, if we have a matching FuncBlock,
	// enrich the CallTarget entries in statements with file/line info.
	for _, fa := range result.Files {
		for _, fn := range fa.Functions {
			for i, stmt := range fn.Statements {
				if stmt.CallTarget == nil {
					continue
				}
				if pos, ok := positions[stmt.CallTarget.FuncID]; ok {
					fn.Statements[i].CallTarget.FilePath = pos.Filename
					fn.Statements[i].CallTarget.Line = pos.Line
				}
				// Determine if external (not in project packages)
				if !isProjectPackage(result.Packages, stmt.CallTarget.Package) {
					if stmt.CallTarget.IsStdLib {
						// already marked
					} else {
						fn.Statements[i].CallTarget.IsExternal = true
					}
				}
			}
		}
	}
}

func isProjectPackage(projectPkgs []string, pkgPath string) bool {
	for _, p := range projectPkgs {
		if p == pkgPath || strings.HasPrefix(pkgPath, p+"/") {
			return true
		}
	}
	return false
}
