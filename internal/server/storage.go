package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// UserData holds all user-specific data for a project.
type UserData struct {
	Bookmarks json.RawMessage `json:"bookmarks"`
	Muted     json.RawMessage `json:"muted"`
	Views     json.RawMessage `json:"views"`
	Outline   bool            `json:"outline"`
	FontSize  int             `json:"fontSize,omitempty"`
	Theme     string          `json:"theme,omitempty"`
}

func storageDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".go-call-graph")
}

func (s *Server) storagePath() string {
	h := sha256.Sum256([]byte(s.analysis.Root))
	name := fmt.Sprintf("%x.json", h[:8])
	return filepath.Join(storageDir(), name)
}

func (s *Server) loadUserData() *UserData {
	data, err := os.ReadFile(s.storagePath())
	if err != nil {
		return &UserData{}
	}
	var ud UserData
	if err := json.Unmarshal(data, &ud); err != nil {
		return &UserData{}
	}
	return &ud
}

func (s *Server) saveUserData(ud *UserData) error {
	dir := storageDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(ud, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.storagePath(), data, 0644)
}

// ---- Theme management ----

func themesDir() string {
	return filepath.Join(storageDir(), "themes")
}

// EnsureBuiltinThemes writes the built-in dark and light theme files if they don't exist.
func EnsureBuiltinThemes() {
	dir := themesDir()
	os.MkdirAll(dir, 0755)

	dark := map[string]string{
		"bg-primary": "#1a1a1a", "bg-secondary": "#141414", "bg-surface": "#262626", "bg-hover": "#333333",
		"text-primary": "#e8e8e8", "text-secondary": "#b0b0b0", "text-dim": "#606060", "border": "#333333",
		"accent-blue": "#58a6ff", "accent-green": "#56d364", "accent-orange": "#f0883e", "accent-red": "#f85149",
		"accent-yellow": "#e3b341", "accent-purple": "#d2a8ff", "accent-teal": "#39d2c0",
		"highlight-caller": "#58a6ff", "highlight-current": "#f0883e", "highlight-callee": "#56d364",
		"code-keyword": "#d2a8ff", "code-string": "#56d364", "code-comment": "#606060",
		"code-func": "#58a6ff", "code-type": "#e3b341", "code-number": "#f0883e",
		"scrollbar-thumb": "#333333", "scrollbar-thumb-hover": "#505050",
	}
	light := map[string]string{
		"bg-primary": "#eff1f5", "bg-secondary": "#e6e9ef", "bg-surface": "#ccd0da", "bg-hover": "#bcc0cc",
		"text-primary": "#4c4f69", "text-secondary": "#5c5f77", "text-dim": "#9ca0b0", "border": "#bcc0cc",
		"accent-blue": "#1e66f5", "accent-green": "#40a02b", "accent-orange": "#fe640b", "accent-red": "#d20f39",
		"accent-yellow": "#df8e1d", "accent-purple": "#8839ef", "accent-teal": "#179299",
		"highlight-caller": "#1e66f5", "highlight-current": "#fe640b", "highlight-callee": "#40a02b",
		"code-keyword": "#8839ef", "code-string": "#40a02b", "code-comment": "#9ca0b0",
		"code-func": "#1e66f5", "code-type": "#df8e1d", "code-number": "#fe640b",
		"scrollbar-thumb": "#bcc0cc", "scrollbar-thumb-hover": "#9ca0b0",
	}

	writeThemeIfMissing(filepath.Join(dir, "dark.json"), dark)
	writeThemeIfMissing(filepath.Join(dir, "light.json"), light)
}

func writeThemeIfMissing(path string, data map[string]string) {
	if _, err := os.Stat(path); err == nil {
		return // already exists
	}
	b, _ := json.MarshalIndent(data, "", "  ")
	os.WriteFile(path, b, 0644)
}

func handleThemes(w http.ResponseWriter, r *http.Request) {
	dir := themesDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeJSON(w, []string{})
		return
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			names = append(names, strings.TrimSuffix(e.Name(), ".json"))
		}
	}
	writeJSON(w, names)
}

func handleThemeGet(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "missing name", http.StatusBadRequest)
		return
	}
	// Sanitize: only allow alphanumeric, dash, underscore
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			http.Error(w, "invalid name", http.StatusBadRequest)
			return
		}
	}
	data, err := os.ReadFile(filepath.Join(themesDir(), name+".json"))
	if err != nil {
		http.Error(w, "theme not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (s *Server) handleLoadUserData(w http.ResponseWriter, r *http.Request) {
	ud := s.loadUserData()
	writeJSON(w, ud)
}

func (s *Server) handleSaveUserData(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var ud UserData
	if err := json.NewDecoder(r.Body).Decode(&ud); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.saveUserData(&ud); err != nil {
		http.Error(w, "save failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}
