package analyzer

import (
	"go/token"
	"go/types"
	"strings"

	"github.com/ignorantshr/go-call-graph/internal/model"
	"golang.org/x/tools/go/callgraph/vta"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
)

// BuildCallGraph constructs a VTA call graph from the loaded packages and returns
// a serializable CallGraphData along with position info for SSA functions.
func BuildCallGraph(pkgs []*packages.Package, fset *token.FileSet) (*model.CallGraphData, map[string]token.Position) {
	// Build SSA program
	prog, _ := ssautil.AllPackages(pkgs, ssa.InstantiateGenerics)
	prog.Build()

	// Run VTA analysis (more precise than CHA for interface method calls)
	cg := vta.CallGraph(ssautil.AllFunctions(prog), nil)

	result := &model.CallGraphData{
		Nodes: make(map[string]*model.CallGraphNode),
	}
	positions := make(map[string]token.Position)

	// Iterate all nodes in the call graph
	for fn, node := range cg.Nodes {
		if fn == nil {
			continue
		}
		funcID := ssaFuncID(fn)
		if funcID == "" {
			continue
		}

		// Record position
		if fn.Pos().IsValid() {
			positions[funcID] = prog.Fset.Position(fn.Pos())
		}

		// Get or create node
		cgNode := getOrCreateNode(result, funcID)

		// Process outgoing edges (callees)
		for _, edge := range node.Out {
			if edge.Callee == nil || edge.Callee.Func == nil {
				continue
			}
			calleeID := ssaFuncID(edge.Callee.Func)
			if calleeID == "" {
				continue
			}
			cgNode.Callees = appendUnique(cgNode.Callees, calleeID)

			// Also add this function as a caller of the callee
			calleeNode := getOrCreateNode(result, calleeID)
			calleeNode.Callers = appendUnique(calleeNode.Callers, funcID)
		}
	}

	return result, positions
}

// FindChain finds all shortest paths between the given set of node IDs,
// excluding muted functions. Returns a subgraph containing only the relevant nodes and edges.
func FindChain(cg *model.CallGraphData, nodeIDs []string, muted map[string]bool) *model.CallGraphData {
	result := &model.CallGraphData{
		Nodes: make(map[string]*model.CallGraphNode),
	}

	// For each pair of nodes, find shortest path using BFS
	for i := 0; i < len(nodeIDs); i++ {
		for j := i + 1; j < len(nodeIDs); j++ {
			// BFS in both directions (caller→callee and callee→caller)
			path := bfsPath(cg, nodeIDs[i], nodeIDs[j], muted)
			if path == nil {
				path = bfsPath(cg, nodeIDs[j], nodeIDs[i], muted)
			}
			if path != nil {
				addPathToResult(result, cg, path)
			}
		}
	}

	return result
}

// GetSubgraph returns a subgraph centered on funcID, expanding to the given depth
// in both caller and callee directions, excluding muted functions.
func GetSubgraph(cg *model.CallGraphData, funcID string, depth int, muted map[string]bool) *model.CallGraphData {
	result := &model.CallGraphData{
		Nodes: make(map[string]*model.CallGraphNode),
	}

	if _, ok := cg.Nodes[funcID]; !ok {
		return result
	}

	// BFS outward from funcID in callee direction
	bfsExpand(cg, result, funcID, depth, muted, true)
	// BFS outward from funcID in caller direction
	bfsExpand(cg, result, funcID, depth, muted, false)

	return result
}

func bfsExpand(cg, result *model.CallGraphData, startID string, depth int, muted map[string]bool, forward bool) {
	type item struct {
		id    string
		depth int
	}
	visited := map[string]bool{startID: true}
	queue := []item{{startID, 0}}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]

		node, ok := cg.Nodes[cur.id]
		if !ok {
			continue
		}

		// Add to result
		resultNode := getOrCreateNode(result, cur.id)

		if cur.depth >= depth {
			continue
		}

		// Don't expand into stdlib/external internals — treat them as leaf nodes
		if cur.id != startID && isStdLib(funcIDToPkgPath(cur.id)) {
			continue
		}

		var neighbors []string
		if forward {
			neighbors = node.Callees
		} else {
			neighbors = node.Callers
		}

		for _, neighborID := range neighbors {
			if muted[neighborID] || visited[neighborID] {
				continue
			}
			visited[neighborID] = true

			// Add edge to result
			if forward {
				resultNode.Callees = appendUnique(resultNode.Callees, neighborID)
				neighborNode := getOrCreateNode(result, neighborID)
				neighborNode.Callers = appendUnique(neighborNode.Callers, cur.id)
			} else {
				resultNode.Callers = appendUnique(resultNode.Callers, neighborID)
				neighborNode := getOrCreateNode(result, neighborID)
				neighborNode.Callees = appendUnique(neighborNode.Callees, cur.id)
			}

			queue = append(queue, item{neighborID, cur.depth + 1})
		}
	}
}

func bfsPath(cg *model.CallGraphData, fromID, toID string, muted map[string]bool) []string {
	if fromID == toID {
		return []string{fromID}
	}

	visited := map[string]bool{fromID: true}
	parent := map[string]string{fromID: ""}
	queue := []string{fromID}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]

		node, ok := cg.Nodes[cur]
		if !ok {
			continue
		}

		for _, calleeID := range node.Callees {
			if muted[calleeID] || visited[calleeID] {
				continue
			}
			visited[calleeID] = true
			parent[calleeID] = cur

			if calleeID == toID {
				// Reconstruct path
				var path []string
				for id := toID; id != ""; id = parent[id] {
					path = append([]string{id}, path...)
				}
				return path
			}

			queue = append(queue, calleeID)
		}
	}

	return nil
}

func addPathToResult(result *model.CallGraphData, cg *model.CallGraphData, path []string) {
	for i, id := range path {
		node := getOrCreateNode(result, id)
		if i > 0 {
			node.Callers = appendUnique(node.Callers, path[i-1])
		}
		if i < len(path)-1 {
			node.Callees = appendUnique(node.Callees, path[i+1])
		}
	}
}

func ssaFuncID(fn *ssa.Function) string {
	if fn.Pkg == nil || fn.Pkg.Pkg == nil {
		// Built-in or synthetic function
		if fn.Object() != nil {
			return fn.RelString(nil)
		}
		return ""
	}

	pkg := fn.Pkg.Pkg
	pkgPath := pkg.Path()

	// For methods, include the receiver type
	sig := fn.Signature
	recv := sig.Recv()
	if recv != nil {
		recvType := recv.Type()
		// Strip pointer
		if ptr, ok := recvType.(*types.Pointer); ok {
			recvType = ptr.Elem()
		}
		named, ok := recvType.(*types.Named)
		if ok {
			return pkgPath + ".(" + named.Obj().Name() + ")." + fn.Name()
		}
	}

	return pkgPath + "." + fn.Name()
}

func getOrCreateNode(cg *model.CallGraphData, funcID string) *model.CallGraphNode {
	if node, ok := cg.Nodes[funcID]; ok {
		return node
	}
	node := &model.CallGraphNode{FuncID: funcID}
	cg.Nodes[funcID] = node
	return node
}

// funcIDToPkgPath extracts the package path from a function ID.
// e.g. "fmt.Println" → "fmt", "net/http.Error" → "net/http",
// "pkg/path.(Type).Method" → "pkg/path"
func funcIDToPkgPath(funcID string) string {
	// Method: "pkg/path.(Type).Method" → find ".("
	if idx := strings.Index(funcID, ".("); idx != -1 {
		return funcID[:idx]
	}
	// Plain function: "pkg/path.FuncName" → find last "."
	if idx := strings.LastIndex(funcID, "."); idx != -1 {
		return funcID[:idx]
	}
	return funcID
}

func appendUnique(slice []string, val string) []string {
	for _, s := range slice {
		if s == val {
			return slice
		}
	}
	return append(slice, val)
}
