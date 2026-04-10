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
	return ComputeBlockComplexity(fn.Body)
}

// ComputeBlockComplexity calculates cyclomatic complexity of a block statement.
func ComputeBlockComplexity(body *ast.BlockStmt) int {
	if body == nil {
		return 1
	}
	complexity := 1
	ast.Inspect(body, func(n ast.Node) bool {
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

func classifyBlock(body *ast.BlockStmt, fset *token.FileSet, info *types.Info, src []byte, logPkgs map[string]bool, logPrefixes []string) []model.Statement {
	if body == nil {
		return nil
	}
	return classifyStmtList(body.List, fset, info, src, logPkgs, logPrefixes)
}

func classifyStmtList(stmts []ast.Stmt, fset *token.FileSet, info *types.Info, src []byte, logPkgs map[string]bool, logPrefixes []string) []model.Statement {
	var result []model.Statement
	for _, s := range stmts {
		result = append(result, classifyStmt(fset, s, info, src, logPkgs, logPrefixes)...)
	}
	return result
}

// ClassifyBlockStatements extracts and classifies statements from a block statement.
func ClassifyBlockStatements(fset *token.FileSet, body *ast.BlockStmt, info *types.Info, src []byte, logPkgs map[string]bool, logPrefixes []string) []model.Statement {
	if body == nil {
		return nil
	}
	var stmts []model.Statement
	for _, s := range body.List {
		stmts = append(stmts, classifyStmt(fset, s, info, src, logPkgs, logPrefixes)...)
	}
	return stmts
}

func classifyStmt(fset *token.FileSet, stmt ast.Stmt, info *types.Info, src []byte, logPkgs map[string]bool, logPrefixes []string) []model.Statement {
	results := classifyStmtCore(fset, stmt, info, src, logPkgs, logPrefixes)

	// Extract function references (functions used as values, not called directly).
	// Skip statements that recurse into sub-blocks (control flow, case clauses)
	// since their children are processed separately.
	switch stmt.(type) {
	case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt,
		*ast.TypeSwitchStmt, *ast.SelectStmt, *ast.CaseClause, *ast.CommClause, *ast.BlockStmt:
		// Sub-statements are already recursed into; don't double-extract refs from them
	default:
		// Collect funcIDs already captured as call targets
		existing := map[string]bool{}
		for _, r := range results {
			if r.CallTarget != nil {
				existing[r.CallTarget.FuncID] = true
			}
		}
		stmtCode := extractCode(src, stmt.Pos(), stmt.End(), fset)

		// Extract nested call expressions (e.g. Greet("Go") inside fmt.Println(...))
		nestedCalls := extractAllCallTargets(stmt, info)
		for _, nc := range nestedCalls {
			if existing[nc.target.FuncID] {
				continue
			}
			existing[nc.target.FuncID] = true
			ncPos := fset.Position(nc.pos)
			classified := classifyCall(model.Statement{
				StartLine: ncPos.Line,
				EndLine:   ncPos.Line,
				Code:      stmtCode,
				Category:  model.CategoryOther,
			}, nc.call, info, logPkgs, logPrefixes)
			results = append(results, classified)
		}

		// Extract function references (functions used as values, not called directly)
		refs := extractFuncRefs(stmt, info)
		for _, ref := range refs {
			if existing[ref.target.FuncID] {
				continue
			}
			existing[ref.target.FuncID] = true
			refPos := fset.Position(ref.pos)
			results = append(results, model.Statement{
				StartLine:  refPos.Line,
				EndLine:    refPos.Line,
				Code:       stmtCode,
				Category:   model.CategoryCall,
				CallTarget: ref.target,
			})
		}
	}

	return results
}

func classifyStmtCore(fset *token.FileSet, stmt ast.Stmt, info *types.Info, src []byte, logPkgs map[string]bool, logPrefixes []string) []model.Statement {
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
		// Collect all call expressions from RHS
		var results []model.Statement
		for _, rhs := range s.Rhs {
			if call, ok := rhs.(*ast.CallExpr); ok {
				classified := classifyCall(base, call, info, logPkgs, logPrefixes)
				if classified.CallTarget != nil {
					results = append(results, classified)
				}
			}
		}
		if len(results) > 0 {
			return results
		}
		base.Category = model.CategoryAssign
		return []model.Statement{base}

	case *ast.ReturnStmt:
		// Collect all call expressions from return values
		var results []model.Statement
		for _, res := range s.Results {
			if call, ok := res.(*ast.CallExpr); ok {
				classified := classifyCall(base, call, info, logPkgs, logPrefixes)
				if classified.CallTarget != nil {
					results = append(results, classified)
				}
			}
		}
		if len(results) > 0 {
			return results
		}
		base.Category = model.CategoryReturn
		return []model.Statement{base}

	case *ast.IfStmt:
		if isErrCheck(s) {
			base.Category = model.CategoryErrorCheck
		} else {
			base.Category = model.CategoryControl
		}
		base.Foldable = true
		// Extract call from Init (e.g., if err := foo(); err != nil)
		if s.Init != nil {
			if assign, ok := s.Init.(*ast.AssignStmt); ok {
				for _, rhs := range assign.Rhs {
					if call, ok := rhs.(*ast.CallExpr); ok {
						if t := resolveCallTarget(call, info); t != nil {
							base.CallTarget = t
							break
						}
					}
				}
			}
		}
		// If no callTarget from Init, try Cond (e.g., if !conf.IsValidProject(proj))
		if base.CallTarget == nil && s.Cond != nil {
			base.CallTarget = extractFirstCallTarget(s.Cond, info)
		}
		result := []model.Statement{base}
		// Recurse into body and else
		if s.Body != nil {
			result = append(result, classifyBlock(s.Body, fset, info, src, logPkgs, logPrefixes)...)
		}
		if s.Else != nil {
			result = append(result, classifyStmt(fset, s.Else, info, src, logPkgs, logPrefixes)...)
		}
		return result

	case *ast.ForStmt:
		base.Category = model.CategoryControl
		if s.Cond != nil {
			base.CallTarget = extractFirstCallTarget(s.Cond, info)
		}
		result := []model.Statement{base}
		if s.Body != nil {
			result = append(result, classifyBlock(s.Body, fset, info, src, logPkgs, logPrefixes)...)
		}
		return result

	case *ast.RangeStmt:
		base.Category = model.CategoryControl
		if s.X != nil {
			base.CallTarget = extractFirstCallTarget(s.X, info)
		}
		result := []model.Statement{base}
		if s.Body != nil {
			result = append(result, classifyBlock(s.Body, fset, info, src, logPkgs, logPrefixes)...)
		}
		return result

	case *ast.SwitchStmt:
		base.Category = model.CategoryControl
		if s.Tag != nil {
			base.CallTarget = extractFirstCallTarget(s.Tag, info)
		}
		result := []model.Statement{base}
		if s.Body != nil {
			result = append(result, classifyBlock(s.Body, fset, info, src, logPkgs, logPrefixes)...)
		}
		return result

	case *ast.TypeSwitchStmt:
		base.Category = model.CategoryControl
		result := []model.Statement{base}
		if s.Body != nil {
			result = append(result, classifyBlock(s.Body, fset, info, src, logPkgs, logPrefixes)...)
		}
		return result

	case *ast.SelectStmt:
		base.Category = model.CategoryControl
		result := []model.Statement{base}
		if s.Body != nil {
			result = append(result, classifyBlock(s.Body, fset, info, src, logPkgs, logPrefixes)...)
		}
		return result

	case *ast.CaseClause:
		return classifyStmtList(s.Body, fset, info, src, logPkgs, logPrefixes)

	case *ast.CommClause:
		return classifyStmtList(s.Body, fset, info, src, logPkgs, logPrefixes)

	case *ast.GoStmt:
		base.Category = model.CategoryCall
		if target := resolveCallTarget(s.Call, info); target != nil {
			base.CallTarget = target
		}
		return []model.Statement{base}

	case *ast.SendStmt:
		// ch <- foo(): extract call target from the value expression
		if call, ok := s.Value.(*ast.CallExpr); ok {
			classified := classifyCall(base, call, info, logPkgs, logPrefixes)
			return []model.Statement{classified}
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
			// Extract bare receiver type name to match SSA FuncID format.
			// sel.Recv() returns the full qualified type (e.g. *pkg/path.Type),
			// but SSA uses just the type name (e.g. "Type").
			recvType := sel.Recv()
			if ptr, ok := recvType.(*types.Pointer); ok {
				recvType = ptr.Elem()
			}
			typeName := recvType.String()
			if named, ok := recvType.(*types.Named); ok {
				typeName = named.Obj().Name()
			}
			funcName := obj.Name()
			return &model.CallTarget{
				FuncID:   fmt.Sprintf("%s.(%s).%s", pkgPath, typeName, funcName),
				Package:  pkgPath,
				Function: funcName,
				IsStdLib: false, // set accurately in enrichWithCallGraphPositions
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
				IsStdLib: false, // set accurately in enrichWithCallGraphPositions
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
				IsStdLib: false, // set accurately in enrichWithCallGraphPositions
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

// extractFirstCallTarget walks an expression tree for the first resolvable call target.
func extractFirstCallTarget(expr ast.Expr, info *types.Info) *model.CallTarget {
	var target *model.CallTarget
	ast.Inspect(expr, func(n ast.Node) bool {
		if target != nil {
			return false
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if t := resolveCallTarget(call, info); t != nil {
			target = t
			return false
		}
		return true
	})
	return target
}

// nestedCall holds a call expression found nested inside a statement.
type nestedCall struct {
	target *model.CallTarget
	call   *ast.CallExpr
	pos    token.Pos
}

// extractAllCallTargets walks an AST node and finds ALL *ast.CallExpr nodes,
// resolving their call targets. This catches nested calls like Greet("Go")
// inside fmt.Println(Greet("Go"), Greet("World")).
func extractAllCallTargets(node ast.Node, info *types.Info) []nestedCall {
	var calls []nestedCall
	seen := map[string]bool{}

	ast.Inspect(node, func(n ast.Node) bool {
		// Skip FuncLit bodies
		if _, ok := n.(*ast.FuncLit); ok {
			return false
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if t := resolveCallTarget(call, info); t != nil {
			if !seen[t.FuncID] {
				seen[t.FuncID] = true
				calls = append(calls, nestedCall{
					target: t,
					call:   call,
					pos:    call.Pos(),
				})
			}
		}
		return true // continue into arguments to find deeper nested calls
	})

	return calls
}

// funcRef holds a function reference with its source position.
type funcRef struct {
	target *model.CallTarget
	pos    token.Pos // position of the identifier in source
}

// extractFuncRefs walks an AST node and finds function-typed identifiers that are
// NOT the Fun part of a call expression (i.e., function values passed as arguments,
// stored in maps/slices, etc.). Returns CallTarget entries with positions.
func extractFuncRefs(node ast.Node, info *types.Info) []funcRef {
	// Collect all call expression Fun nodes so we can skip them
	callFuns := map[ast.Node]bool{}
	ast.Inspect(node, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			callFuns[call.Fun] = true
		}
		return true
	})

	var refs []funcRef
	seen := map[string]bool{}

	ast.Inspect(node, func(n ast.Node) bool {
		if n == nil {
			return false
		}
		// Skip nodes that are the Fun part of a call expression
		if callFuns[n] {
			return false
		}
		// Skip the inside of FuncLit bodies (closures define new scopes)
		if _, ok := n.(*ast.FuncLit); ok {
			return false
		}

		var obj types.Object
		var identPos token.Pos
		switch e := n.(type) {
		case *ast.Ident:
			obj = info.Uses[e]
			identPos = e.Pos()
		case *ast.SelectorExpr:
			obj = info.Uses[e.Sel]
			identPos = e.Sel.Pos()
		default:
			return true
		}

		if obj == nil {
			return true
		}

		// Check if the object is a function (not a method call — those are handled by resolveCallTarget)
		fn, ok := obj.(*types.Func)
		if !ok {
			return true
		}

		pkg := fn.Pkg()
		pkgPath := ""
		if pkg != nil {
			pkgPath = pkg.Path()
		}

		funcID := fmt.Sprintf("%s.%s", pkgPath, fn.Name())
		// For methods, include receiver type
		sig := fn.Type().(*types.Signature)
		if recv := sig.Recv(); recv != nil {
			recvType := recv.Type()
			if ptr, ok := recvType.(*types.Pointer); ok {
				recvType = ptr.Elem()
			}
			if named, ok := recvType.(*types.Named); ok {
				funcID = fmt.Sprintf("%s.(%s).%s", pkgPath, named.Obj().Name(), fn.Name())
			}
		}

		if seen[funcID] {
			return true
		}
		seen[funcID] = true

		refs = append(refs, funcRef{
			target: &model.CallTarget{
				FuncID:   funcID,
				Package:  pkgPath,
				Function: fn.Name(),
			},
			pos: identPos,
		})
		return true
	})

	return refs
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
