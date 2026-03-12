package server

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/haoran-shi/go-call-graph/internal/analyzer"
	"github.com/haoran-shi/go-call-graph/internal/model"
)

// TreeNode represents a node in the file/package tree.
type TreeNode struct {
	Name     string      `json:"name"`
	Type     string      `json:"type"` // "package", "file"
	Path     string      `json:"path,omitempty"`
	Children []*TreeNode `json:"children,omitempty"`
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	root := &TreeNode{
		Name: filepath.Base(s.analysis.Root),
		Type: "package",
	}

	// Group files by directory
	dirs := make(map[string][]*model.FileAnalysis)
	for _, fa := range s.analysis.Files {
		dir := filepath.Dir(fa.Path)
		dirs[dir] = append(dirs[dir], fa)
	}

	// Sort directory paths for consistent output
	var sortedDirs []string
	for d := range dirs {
		sortedDirs = append(sortedDirs, d)
	}
	sort.Strings(sortedDirs)

	for _, dir := range sortedDirs {
		files := dirs[dir]
		// Compute relative path from project root
		relDir, err := filepath.Rel(s.analysis.Root, dir)
		if err != nil {
			relDir = dir
		}

		// Sort files by name
		sort.Slice(files, func(i, j int) bool {
			return filepath.Base(files[i].Path) < filepath.Base(files[j].Path)
		})

		dirNode := findOrCreateDir(root, relDir)
		for _, fa := range files {
			dirNode.Children = append(dirNode.Children, &TreeNode{
				Name: filepath.Base(fa.Path),
				Type: "file",
				Path: fa.Path,
			})
		}
	}

	sortTreeChildren(root)
	writeJSON(w, root)
}

func findOrCreateDir(root *TreeNode, relPath string) *TreeNode {
	if relPath == "." || relPath == "" {
		return root
	}
	parts := strings.Split(relPath, string(filepath.Separator))
	current := root
	for _, part := range parts {
		found := false
		for _, child := range current.Children {
			if child.Name == part && child.Type == "package" {
				current = child
				found = true
				break
			}
		}
		if !found {
			newNode := &TreeNode{Name: part, Type: "package"}
			current.Children = append(current.Children, newNode)
			current = newNode
		}
	}
	return current
}

// sortTreeChildren sorts children of each node: packages first (alphabetical), then files (alphabetical).
func sortTreeChildren(node *TreeNode) {
	if len(node.Children) == 0 {
		return
	}
	sort.Slice(node.Children, func(i, j int) bool {
		ci, cj := node.Children[i], node.Children[j]
		if ci.Type != cj.Type {
			return ci.Type == "package" // packages before files
		}
		return ci.Name < cj.Name
	})
	for _, child := range node.Children {
		sortTreeChildren(child)
	}
}

// FileResponse is the response for /api/file.
type FileResponse struct {
	Path      string            `json:"path"`
	Package   string            `json:"package"`
	Source    string            `json:"source"`
	Functions []*model.FuncBlock `json:"functions"`
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "missing path parameter", http.StatusBadRequest)
		return
	}

	fa, ok := s.analysis.Files[path]
	if !ok {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}

	src, ok2 := s.fileCache[path]
	if !ok2 {
		http.Error(w, "failed to read file", http.StatusInternalServerError)
		return
	}

	resp := FileResponse{
		Path:      fa.Path,
		Package:   fa.Package,
		Source:    src,
		Functions: fa.Functions,
	}
	writeJSON(w, resp)
}

// FuncResponse is the response for /api/func.
type FuncResponse struct {
	*model.FuncBlock
	Callers []string `json:"callers"`
	Callees []string `json:"callees"`
}

func (s *Server) handleFunc(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "missing id parameter", http.StatusBadRequest)
		return
	}

	fn, ok := s.analysis.Functions[id]
	if !ok {
		http.Error(w, "function not found", http.StatusNotFound)
		return
	}

	resp := FuncResponse{FuncBlock: fn}
	if node, ok := s.analysis.CallGraph.Nodes[id]; ok {
		resp.Callers = node.Callers
		resp.Callees = node.Callees
	}
	writeJSON(w, resp)
}

// GraphResponse is the response for /api/callgraph and /api/chain.
type GraphResponse struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// GraphNode is a node in the graph visualization.
type GraphNode struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Package    string `json:"package"`
	IsExported bool   `json:"isExported"`
	IsStdLib   bool   `json:"isStdLib"`
	Complexity int    `json:"complexity"`
}

// GraphEdge is an edge in the graph visualization.
type GraphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (s *Server) handleCallGraph(w http.ResponseWriter, r *http.Request) {
	funcID := r.URL.Query().Get("func")
	if funcID == "" {
		http.Error(w, "missing func parameter", http.StatusBadRequest)
		return
	}

	depth := s.defaultDepth
	if d := r.URL.Query().Get("depth"); d != "" {
		if parsed, err := strconv.Atoi(d); err == nil && parsed > 0 {
			depth = parsed
		}
	}

	muted := parseMuted(r.URL.Query().Get("muted"))
	subgraph := analyzer.GetSubgraph(s.analysis.CallGraph, funcID, depth, muted)
	writeJSON(w, s.toGraphResponse(subgraph))
}

func (s *Server) handleChain(w http.ResponseWriter, r *http.Request) {
	nodesParam := r.URL.Query().Get("nodes")
	if nodesParam == "" {
		http.Error(w, "missing nodes parameter", http.StatusBadRequest)
		return
	}

	nodeIDs := strings.Split(nodesParam, ",")
	muted := parseMuted(r.URL.Query().Get("muted"))
	chain := analyzer.FindChain(s.analysis.CallGraph, nodeIDs, muted)
	writeJSON(w, s.toGraphResponse(chain))
}

// SearchResult represents a search result item.
type SearchResult struct {
	Type     string `json:"type"` // "function", "file", "text"
	ID       string `json:"id"`
	Name     string `json:"name"`
	Package  string `json:"package"`
	FilePath string `json:"filePath"`
	Line     int    `json:"line,omitempty"`
	Context  string `json:"context,omitempty"`
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, []SearchResult{})
		return
	}

	var results []SearchResult

	// Search functions
	for _, fn := range s.analysis.Functions {
		if strings.Contains(strings.ToLower(fn.Name), q) ||
			strings.Contains(strings.ToLower(fn.ID), q) {
			results = append(results, SearchResult{
				Type:     "function",
				ID:       fn.ID,
				Name:     fn.Name,
				Package:  strings.TrimSuffix(fn.ID, "."+fn.Name),
				FilePath: fn.FilePath,
				Line:     fn.StartLine,
			})
		}
	}

	// Search files
	for path, fa := range s.analysis.Files {
		if strings.Contains(strings.ToLower(filepath.Base(path)), q) {
			results = append(results, SearchResult{
				Type:     "file",
				ID:       path,
				Name:     filepath.Base(path),
				Package:  fa.Package,
				FilePath: path,
			})
		}
	}

	// Search file contents (full text)
	const maxTextResults = 30
	textCount := 0
	for path := range s.analysis.Files {
		if textCount >= maxTextResults {
			break
		}
		src, ok := s.fileCache[path]
		if !ok {
			continue
		}
		lines := strings.Split(src, "\n")
		for i, line := range lines {
			if textCount >= maxTextResults {
				break
			}
			if strings.Contains(strings.ToLower(line), q) {
				ctx := strings.TrimSpace(line)
				if len(ctx) > 100 {
					ctx = ctx[:100] + "..."
				}
				results = append(results, SearchResult{
					Type:     "text",
					ID:       path + ":" + strconv.Itoa(i+1),
					Name:     filepath.Base(path) + ":" + strconv.Itoa(i+1),
					FilePath: path,
					Line:     i + 1,
					Context:  ctx,
				})
				textCount++
			}
		}
	}

	writeJSON(w, results)
}

func parseMuted(param string) map[string]bool {
	muted := make(map[string]bool)
	if param == "" {
		return muted
	}
	for _, id := range strings.Split(param, ",") {
		id = strings.TrimSpace(id)
		if id != "" {
			muted[id] = true
		}
	}
	return muted
}

func (s *Server) toGraphResponse(cg *model.CallGraphData) GraphResponse {
	resp := GraphResponse{}
	for id, node := range cg.Nodes {
		label, pkg := extractLabelAndPkg(id)
		gn := GraphNode{
			ID:      id,
			Label:   label,
			Package: pkg,
		}
		// Enrich with function metadata if available
		if fn, ok := s.analysis.Functions[id]; ok {
			gn.IsExported = fn.IsExported
			gn.Complexity = fn.Complexity
		}
		// Detect stdlib: not a project package and not external
		_, isProjectFunc := s.analysis.Functions[id]
		gn.IsStdLib = !isProjectFunc
		resp.Nodes = append(resp.Nodes, gn)

		for _, calleeID := range node.Callees {
			if _, exists := cg.Nodes[calleeID]; exists {
				resp.Edges = append(resp.Edges, GraphEdge{
					From: id,
					To:   calleeID,
				})
			}
		}
	}
	return resp
}

func (s *Server) handleProjectGraph(w http.ResponseWriter, r *http.Request) {
	result := &model.CallGraphData{
		Nodes: make(map[string]*model.CallGraphNode),
	}

	// Add all project functions
	for id := range s.analysis.Functions {
		if node, ok := s.analysis.CallGraph.Nodes[id]; ok {
			resultNode := &model.CallGraphNode{
				FuncID: id,
			}
			// Add edges only to/from project functions or direct stdlib callees
			for _, calleeID := range node.Callees {
				if _, isProject := s.analysis.Functions[calleeID]; isProject {
					resultNode.Callees = append(resultNode.Callees, calleeID)
				} else {
					// Add stdlib/external as leaf nodes
					if _, exists := result.Nodes[calleeID]; !exists {
						result.Nodes[calleeID] = &model.CallGraphNode{FuncID: calleeID}
					}
					resultNode.Callees = append(resultNode.Callees, calleeID)
				}
			}
			for _, callerID := range node.Callers {
				if _, isProject := s.analysis.Functions[callerID]; isProject {
					resultNode.Callers = append(resultNode.Callers, callerID)
				}
			}
			result.Nodes[id] = resultNode
		}
	}

	writeJSON(w, s.toGraphResponse(result))
}

func extractLabelAndPkg(id string) (label, pkg string) {
	// Handle method IDs like "pkg/path.(Type).Method"
	if idx := strings.LastIndex(id, ".("); idx != -1 {
		pkg = id[:idx]
		label = id[idx+1:] // "(Type).Method"
		return
	}
	// Handle plain function IDs like "pkg/path.FuncName"
	if idx := strings.LastIndex(id, "."); idx != -1 {
		pkg = id[:idx]
		label = id[idx+1:]
		return
	}
	return id, ""
}

func writeJSON(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}
