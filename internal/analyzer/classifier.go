package analyzer

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"strings"

	"github.com/ignorantshr/go-call-graph/internal/model"
)

// ClassifyStatements extracts and classifies statements from a function body.
// logPkgs and logPrefixes control which calls are classified as "log".
func ClassifyStatements(fset *token.FileSet, fn *ast.FuncDecl, info *types.Info, src []byte, logPkgs map[string]bool, logPrefixes []string) []model.Statement {
	if fn.Body == nil {
		return nil
	}

	var stmts []model.Statement
	for _, s := range fn.Body.List {
		stmts = append(stmts, classifyStmt(fset, s, info, src, logPkgs, logPrefixes)...)
	}
	return stmts
}

// ComputeComplexity calculates cyclomatic complexity of a function.
func ComputeComplexity(fn *ast.FuncDecl) int {
	if fn.Body == nil {
		return 1
	}
	complexity := 1
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		switch n.(type) {
		case *ast.IfStmt:
			complexity++
		case *ast.ForStmt, *ast.RangeStmt:
			complexity++
		case *ast.CaseClause:
			complexity++
		case *ast.CommClause:
			complexity++
		case *ast.BinaryExpr:
			bin := n.(*ast.BinaryExpr)
			if bin.Op == token.LAND || bin.Op == token.LOR {
				complexity++
			}
		}
		return true
	})
	return complexity
}

func classifyStmt(fset *token.FileSet, stmt ast.Stmt, info *types.Info, src []byte, logPkgs map[string]bool, logPrefixes []string) []model.Statement {
	startPos := fset.Position(stmt.Pos())
	endPos := fset.Position(stmt.End())
	code := extractCode(src, stmt.Pos(), stmt.End(), fset)

	base := model.Statement{
		StartLine: startPos.Line,
		EndLine:   endPos.Line,
		Code:      code,
		Category:  model.CategoryOther,
	}

	switch s := stmt.(type) {
	case *ast.ExprStmt:
		if call, ok := s.X.(*ast.CallExpr); ok {
			return []model.Statement{classifyCall(base, call, info, logPkgs, logPrefixes)}
		}

	case *ast.DeferStmt:
		base.Category = model.CategoryDefer
		base.Foldable = true
		if target := resolveCallTarget(s.Call, info); target != nil {
			base.CallTarget = target
		}
		return []model.Statement{base}

	case *ast.AssignStmt:
		// Check if RHS contains a call expression
		for _, rhs := range s.Rhs {
			if call, ok := rhs.(*ast.CallExpr); ok {
				classified := classifyCall(base, call, info, logPkgs, logPrefixes)
				if classified.Category == model.CategoryLog {
					return []model.Statement{classified}
				}
				// For non-log calls, keep as "call" but with assignment context
				if classified.CallTarget != nil {
					base.Category = model.CategoryCall
					base.CallTarget = classified.CallTarget
					return []model.Statement{base}
				}
			}
		}
		base.Category = model.CategoryAssign
		return []model.Statement{base}

	case *ast.ReturnStmt:
		base.Category = model.CategoryReturn
		return []model.Statement{base}

	case *ast.IfStmt:
		if isErrCheck(s) {
			base.Category = model.CategoryErrorCheck
			base.Foldable = true
			return []model.Statement{base}
		}
		base.Category = model.CategoryControl
		return []model.Statement{base}

	case *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt:
		base.Category = model.CategoryControl
		return []model.Statement{base}

	case *ast.GoStmt:
		base.Category = model.CategoryCall
		if target := resolveCallTarget(s.Call, info); target != nil {
			base.CallTarget = target
		}
		return []model.Statement{base}

	case *ast.BlockStmt:
		var result []model.Statement
		for _, inner := range s.List {
			result = append(result, classifyStmt(fset, inner, info, src, logPkgs, logPrefixes)...)
		}
		return result
	}

	return []model.Statement{base}
}

func classifyCall(base model.Statement, call *ast.CallExpr, info *types.Info, logPkgs map[string]bool, logPrefixes []string) model.Statement {
	target := resolveCallTarget(call, info)
	if target != nil {
		base.CallTarget = target
		if isLogCall(target, logPkgs, logPrefixes) {
			base.Category = model.CategoryLog
			base.Foldable = true
			return base
		}
		base.Category = model.CategoryCall
		return base
	}
	base.Category = model.CategoryCall
	return base
}

func resolveCallTarget(call *ast.CallExpr, info *types.Info) *model.CallTarget {
	switch fn := call.Fun.(type) {
	case *ast.SelectorExpr:
		// pkg.Func() or obj.Method()
		sel, ok := info.Selections[fn]
		if ok {
			// Method call
			obj := sel.Obj()
			if obj == nil {
				return nil
			}
			pkg := obj.Pkg()
			pkgPath := ""
			if pkg != nil {
				pkgPath = pkg.Path()
			}
			recvType := sel.Recv().String()
			funcName := obj.Name()
			return &model.CallTarget{
				FuncID:   fmt.Sprintf("%s.(%s).%s", pkgPath, recvType, funcName),
				Package:  pkgPath,
				Function: funcName,
				IsStdLib: isStdLib(pkgPath),
			}
		}
		// Qualified identifier: pkg.Func()
		if obj := info.Uses[fn.Sel]; obj != nil {
			pkg := obj.Pkg()
			pkgPath := ""
			if pkg != nil {
				pkgPath = pkg.Path()
			}
			return &model.CallTarget{
				FuncID:   fmt.Sprintf("%s.%s", pkgPath, obj.Name()),
				Package:  pkgPath,
				Function: obj.Name(),
				IsStdLib: isStdLib(pkgPath),
			}
		}

	case *ast.Ident:
		// Local or imported function call
		if obj := info.Uses[fn]; obj != nil {
			pkg := obj.Pkg()
			pkgPath := ""
			if pkg != nil {
				pkgPath = pkg.Path()
			}
			return &model.CallTarget{
				FuncID:   fmt.Sprintf("%s.%s", pkgPath, obj.Name()),
				Package:  pkgPath,
				Function: obj.Name(),
				IsStdLib: isStdLib(pkgPath),
			}
		}
	}
	return nil
}

func isLogCall(target *model.CallTarget, logPkgs map[string]bool, logPrefixes []string) bool {
	if logPkgs[target.Package] {
		return true
	}
	// Check for common log method names on any package
	for _, prefix := range logPrefixes {
		if target.Function == prefix || strings.HasPrefix(target.Function, prefix) {
			// Only match if the package looks like a logger
			if strings.Contains(target.Package, "log") || strings.Contains(target.Package, "zap") {
				return true
			}
		}
	}
	// fmt.Print* family
	if target.Package == "fmt" {
		for _, prefix := range []string{"Print", "Fprint", "Sprint"} {
			if strings.HasPrefix(target.Function, prefix) {
				return true
			}
		}
	}
	return false
}

func isErrCheck(ifStmt *ast.IfStmt) bool {
	binExpr, ok := ifStmt.Cond.(*ast.BinaryExpr)
	if !ok {
		return false
	}
	if binExpr.Op != token.NEQ {
		return false
	}
	// Check for `err != nil` pattern
	xIdent, xOk := binExpr.X.(*ast.Ident)
	yIdent, yOk := binExpr.Y.(*ast.Ident)
	if xOk && yOk {
		return (xIdent.Name == "err" && yIdent.Name == "nil") ||
			(xIdent.Name == "nil" && yIdent.Name == "err")
	}
	return false
}

func isStdLib(pkgPath string) bool {
	if pkgPath == "" {
		return false
	}
	// Standard library packages don't contain a dot in the first path component
	return !strings.Contains(strings.Split(pkgPath, "/")[0], ".")
}

func extractCode(src []byte, start, end token.Pos, fset *token.FileSet) string {
	startOffset := fset.Position(start).Offset
	endOffset := fset.Position(end).Offset
	if startOffset < 0 || endOffset < 0 || startOffset >= len(src) || endOffset > len(src) {
		return ""
	}
	return string(src[startOffset:endOffset])
}
