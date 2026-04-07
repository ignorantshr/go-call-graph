package server

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/ignorantshr/go-call-graph/internal/config"
	"github.com/ignorantshr/go-call-graph/internal/model"
)

//go:embed all:web
var webFS embed.FS

// Server serves the analysis results over HTTP.
type Server struct {
	analysis     *model.ProjectAnalysis
	port         int
	dev          bool // serve from filesystem instead of embed
	defaultDepth int
	muteDefaults []config.MuteRule
	mux          *http.ServeMux
	fileCache    map[string]string // preloaded file contents keyed by path
}

// New creates a new Server.
func New(analysis *model.ProjectAnalysis, cfg *config.Config) *Server {
	s := &Server{
		analysis:     analysis,
		port:         cfg.Port,
		dev:          cfg.Dev,
		defaultDepth: cfg.Callgraph.DefaultDepth,
		muteDefaults: cfg.Mute,
		mux:          http.NewServeMux(),
		fileCache:    make(map[string]string),
	}
	// Preload file contents into cache
	for path := range analysis.Files {
		if src, err := os.ReadFile(path); err == nil {
			s.fileCache[path] = string(src)
		}
	}
	EnsureBuiltinThemes()
	s.registerRoutes()
	return s
}

func (s *Server) registerRoutes() {
	// API routes
	s.mux.HandleFunc("/api/project", s.handleProject)
	s.mux.HandleFunc("/api/userdata", s.handleLoadUserData)
	s.mux.HandleFunc("/api/userdata/save", s.handleSaveUserData)
	s.mux.HandleFunc("/api/themes", handleThemes)
	s.mux.HandleFunc("/api/theme", handleThemeGet)
	s.mux.HandleFunc("/api/tree", s.handleTree)
	s.mux.HandleFunc("/api/file", s.handleFile)
	s.mux.HandleFunc("/api/func", s.handleFunc)
	s.mux.HandleFunc("/api/callgraph", s.handleCallGraph)
	s.mux.HandleFunc("/api/chain", s.handleChain)
	s.mux.HandleFunc("/api/search", s.handleSearch)
	s.mux.HandleFunc("/api/mute/defaults", s.handleMuteDefaults)
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

// cors wraps a handler to add CORS headers for /api/ requests.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// Start begins serving HTTP requests.
func (s *Server) Start() error {
	addr := fmt.Sprintf(":%d", s.port)
	fmt.Printf("Server running at http://localhost%s\n", addr)
	return http.ListenAndServe(addr, cors(s.mux))
}
