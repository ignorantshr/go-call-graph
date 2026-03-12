package server

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"

	"github.com/haoran-shi/go-call-graph/internal/model"
)

//go:embed all:web
var webFS embed.FS

// Server serves the analysis results over HTTP.
type Server struct {
	analysis *model.ProjectAnalysis
	port     int
	dev      bool // serve from filesystem instead of embed
	mux      *http.ServeMux
}

// New creates a new Server.
func New(analysis *model.ProjectAnalysis, port int, dev bool) *Server {
	s := &Server{
		analysis: analysis,
		port:     port,
		dev:      dev,
		mux:      http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

func (s *Server) registerRoutes() {
	// API routes
	s.mux.HandleFunc("/api/tree", s.handleTree)
	s.mux.HandleFunc("/api/file", s.handleFile)
	s.mux.HandleFunc("/api/func", s.handleFunc)
	s.mux.HandleFunc("/api/callgraph", s.handleCallGraph)
	s.mux.HandleFunc("/api/chain", s.handleChain)
	s.mux.HandleFunc("/api/search", s.handleSearch)
	s.mux.HandleFunc("/api/graph/project", s.handleProjectGraph)

	// Static files
	var fileServer http.Handler
	if s.dev {
		fileServer = http.FileServer(http.Dir("web"))
	} else {
		sub, err := fs.Sub(webFS, "web")
		if err != nil {
			log.Fatalf("failed to create sub filesystem: %v", err)
		}
		fileServer = http.FileServer(http.FS(sub))
	}
	s.mux.Handle("/", fileServer)
}

// Start begins serving HTTP requests.
func (s *Server) Start() error {
	addr := fmt.Sprintf(":%d", s.port)
	fmt.Printf("Server running at http://localhost%s\n", addr)
	return http.ListenAndServe(addr, s.mux)
}
