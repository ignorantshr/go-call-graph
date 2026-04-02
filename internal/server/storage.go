package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

// UserData holds all user-specific data for a project.
type UserData struct {
	Bookmarks json.RawMessage `json:"bookmarks"`
	Muted     json.RawMessage `json:"muted"`
	Views     json.RawMessage `json:"views"`
	Outline   bool            `json:"outline"`
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
