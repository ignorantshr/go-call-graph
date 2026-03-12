package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/", HandleRequest)
	log.Println("Starting server on :8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}

// HandleRequest is the main HTTP handler.
func HandleRequest(w http.ResponseWriter, r *http.Request) {
	log.Printf("Request: %s %s", r.Method, r.URL.Path)
	user := GetUser(r)
	data := FetchData(user)
	if err := Render(w, data); err != nil {
		log.Printf("render error: %v", err)
		http.Error(w, "Internal Server Error", 500)
		return
	}
}

// GetUser extracts the user from the request.
func GetUser(r *http.Request) string {
	user := r.Header.Get("X-User")
	if user == "" {
		user = "anonymous"
	}
	log.Printf("User: %s", user)
	return user
}

// FetchData retrieves data for the given user.
func FetchData(user string) string {
	log.Printf("Fetching data for user: %s", user)
	result := QueryDB(user)
	return ProcessResult(result)
}

// QueryDB simulates a database query.
func QueryDB(user string) string {
	defer log.Println("QueryDB complete")
	return fmt.Sprintf("data for %s", user)
}

// ProcessResult processes the raw query result.
func ProcessResult(raw string) string {
	return fmt.Sprintf("processed: %s", raw)
}

// Render writes the response.
func Render(w http.ResponseWriter, data string) error {
	_, err := fmt.Fprintf(w, "<html><body>%s</body></html>", data)
	if err != nil {
		return fmt.Errorf("render failed: %w", err)
	}
	return nil
}
