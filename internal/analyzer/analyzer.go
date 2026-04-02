package analyzer

import (
	"fmt"
	"go/ast"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ignorantshr/go-call-graph/internal/config"
	"github.com/ignorantshr/go-call-graph/internal/model"
	"golang.org/x/tools/go/packages"
)

// Analyze loads and analyzes the Go project at the given directory.
func Analyze(appCfg *config.Config) (*model.ProjectAnalysis, error) {
	// Resolve to absolute path for consistent file references
	absDir, err := filepath.Abs(appCfg.Dir)
	if err != nil {
		return nil, fmt.Errorf("resolving directory: %w", err)
	}
	dir := absDir

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

	// Build exclude dirs set (absolute paths)
	excludeDirs := make([]string, 0, len(appCfg.Exclude))
	for _, excl := range appCfg.Exclude {
		abs := filepath.Join(dir, excl)
		excludeDirs = append(excludeDirs, abs+string(filepath.Separator))
	}

	// Build log packages map from config
	logPkgs := make(map[string]bool, len(appCfg.Classifier.LogPackages))
	for _, p := range appCfg.Classifier.LogPackages {
		logPkgs[p] = true
	}
	logPrefixes := appCfg.Classifier.LogFuncPrefixes

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
			// Skip files in excluded directories
			excluded := false
			for _, exclDir := range excludeDirs {
				if strings.HasPrefix(filePath, exclDir) {
					excluded = true
					break
				}
			}
			if excluded {
				continue
			}
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

				block := buildFuncBlock(fset, fn, pkg, src, logPkgs, logPrefixes)
				fa.Functions = append(fa.Functions, block)
				result.Functions[block.ID] = block

				// Extract anonymous functions (FuncLit) from the function body
				if fn.Body != nil {
					parentID := block.ID
					extractFuncLits(fset, fn.Body, parentID, pkg, src, logPkgs, logPrefixes, fa, result)
				}
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

func buildFuncBlock(fset *token.FileSet, fn *ast.FuncDecl, pkg *packages.Package, src []byte, logPkgs map[string]bool, logPrefixes []string) *model.FuncBlock {
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
	block.Statements = ClassifyStatements(fset, fn, pkg.TypesInfo, src, logPkgs, logPrefixes)

	// Inline anonymous function body statements into parent function,
	// so call targets inside closures are visible at the parent level.
	if fn.Body != nil {
		var extraStmts []model.Statement
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			lit, ok := n.(*ast.FuncLit)
			if !ok {
				return true
			}
			if lit.Body != nil {
				extraStmts = append(extraStmts, ClassifyBlockStatements(fset, lit.Body, pkg.TypesInfo, src, logPkgs, logPrefixes)...)
			}
			return false // don't recurse into nested FuncLits (handled by their own parent)
		})
		if len(extraStmts) > 0 {
			block.Statements = append(block.Statements, extraStmts...)
			sort.Slice(block.Statements, func(i, j int) bool {
				return block.Statements[i].StartLine < block.Statements[j].StartLine
			})
		}
	}

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
				// Determine stdlib/external based on project packages
				if isProjectPackage(result.Packages, stmt.CallTarget.Package) {
					// Project package — override any false positive from isStdLib heuristic
					fn.Statements[i].CallTarget.IsStdLib = false
					fn.Statements[i].CallTarget.IsExternal = false
				} else if !stmt.CallTarget.IsStdLib {
					fn.Statements[i].CallTarget.IsExternal = true
				}
			}
		}
	}
}

// extractFuncLits walks a block statement looking for anonymous functions (*ast.FuncLit),
// creates FuncBlocks for them with IDs matching SSA's parentFunc$N convention,
// and recursively handles nested anonymous functions.
func extractFuncLits(fset *token.FileSet, body *ast.BlockStmt, parentID string, pkg *packages.Package, src []byte, logPkgs map[string]bool, logPrefixes []string, fa *model.FileAnalysis, result *model.ProjectAnalysis) {
	counter := 0
	ast.Inspect(body, func(n ast.Node) bool {
		lit, ok := n.(*ast.FuncLit)
		if !ok {
			return true
		}
		counter++
		litID := fmt.Sprintf("%s$%d", parentID, counter)

		block := buildFuncLitBlock(fset, lit, pkg, src, litID, logPkgs, logPrefixes)
		fa.Functions = append(fa.Functions, block)
		result.Functions[block.ID] = block

		// Recursively extract nested anonymous functions
		if lit.Body != nil {
			extractFuncLits(fset, lit.Body, litID, pkg, src, logPkgs, logPrefixes, fa, result)
		}

		return false // don't recurse into this FuncLit's children (handled above)
	})
}

func buildFuncLitBlock(fset *token.FileSet, lit *ast.FuncLit, pkg *packages.Package, src []byte, funcID string, logPkgs map[string]bool, logPrefixes []string) *model.FuncBlock {
	startPos := fset.Position(lit.Pos())
	endPos := fset.Position(lit.End())

	// Extract short name from funcID: e.g. "pkg/path.main$1" → "main$1"
	name := funcID
	if idx := strings.LastIndex(funcID, "."); idx != -1 {
		name = funcID[idx+1:]
	}

	block := &model.FuncBlock{
		ID:       funcID,
		Name:     name,
		FilePath: startPos.Filename,
		StartLine: startPos.Line,
		EndLine:   endPos.Line,
	}

	// Extract signature: from "func" keyword to opening brace
	start := fset.Position(lit.Pos()).Offset
	var end int
	if lit.Body != nil {
		end = fset.Position(lit.Body.Lbrace).Offset
	} else {
		end = fset.Position(lit.End()).Offset
	}
	if start >= 0 && end >= 0 && start < len(src) && end <= len(src) {
		block.Signature = strings.TrimSpace(string(src[start:end]))
	} else {
		block.Signature = "func()"
	}

	// Classify statements in the body
	if lit.Body != nil {
		block.Statements = ClassifyBlockStatements(fset, lit.Body, pkg.TypesInfo, src, logPkgs, logPrefixes)
	}

	// Compute complexity
	block.Complexity = ComputeBlockComplexity(lit.Body)

	return block
}

func isProjectPackage(projectPkgs []string, pkgPath string) bool {
	for _, p := range projectPkgs {
		if p == pkgPath || strings.HasPrefix(pkgPath, p+"/") {
			return true
		}
	}
	return false
}
