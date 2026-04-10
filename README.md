# go-call-graph

Interactive Go source code call graph analyzer. Parses a Go project via static analysis (VTA), builds a full call graph, and serves an interactive web UI for exploration.

## Features

- **Code Chain view** — click a function to load its call chain as floating file boxes with expandable code blocks and arrows connecting call sites to callees
- **File boxes** — draggable, resizable containers; dagre tree layout (callers above, callees below) with free repositioning
- **Code viewer** — syntax-highlighted source with call-link navigation in the right panel
- **Function reference detection** — detects not only direct calls (`foo()`) but also function value references (map literals, function arguments, etc.) and nested calls
- **Call chain arrows** — arrows originate from the exact call-site line and point to the callee's signature
- **File-internal search** — find text within the current file, with match navigation
- **Global text search** — search across all project files for code content
- **Line bookmarks** — double-click any line number to add a labeled bookmark
- **Function bookmarks** — bookmark functions with chain mode (show paths between bookmarks)
- **Mute system** — hide stdlib, specific packages, or functions via config file or UI
- **Canvas text annotations** — add editable text notes on the canvas, draggable and resizable
- **Pin mode** — keep current canvas view when decreasing depth
- **Locate mode** — toggle to click code and focus the corresponding chain node
- **Auto-folding** — long comments (>2 lines) are collapsed by default
- **CORS support** — API endpoints support cross-origin requests for integration with other projects
- **Generics support** — correctly handles Go generic functions and generic type methods in the call graph

## Install

```bash
go install github.com/ignorantshr/go-call-graph/cmd/main.go@latest
```

## Build

```bash
go build -o go-call-graph ./cmd/main.go
```

## Usage

```bash
go-call-graph --dir /path/to/go/project --port 8080
```

Then open `http://localhost:8080` in your browser.

### Flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--config` | `-c` | | Path to YAML config file |
| `--dir` | `-d` | `.` | Target Go project directory |
| `--port` | `-p` | `8080` | Web server port |
| `--dev` | | `false` | Serve frontend from filesystem (for development) |

### Configuration File

Use `--config` to load settings from a YAML file. CLI flags override config values.

```bash
go-call-graph --config go-call-graph.yaml
go-call-graph --config go-call-graph.yaml --port 9090  # CLI flag overrides
```

Available settings (see `go-call-graph.example.yaml` for a full annotated example):

| Section | Key | Description |
|---------|-----|-------------|
| *(top-level)* | `dir`, `port`, `dev` | Same as CLI flags |
| *(top-level)* | `exclude` | Directories to exclude from analysis (relative to dir) |
| `callgraph` | `default_depth` | Default expansion depth for subgraph queries (default: 2) |
| `mute` | *(list)* | Default mute rules, loaded to frontend on startup |

**Mute rule types:**

| Type | Description | Example |
|------|-------------|---------|
| `stdlib` | Mute all standard library functions | `- type: stdlib` |
| `package` | Mute a specific package path | `- type: package`<br>`  pattern: "github.com/foo/bar"` |
| `func` | Mute a specific function | `- type: func`<br>`  pattern: "pkg.FuncName"` |
| `pattern` | Wildcard pattern match | `- type: pattern`<br>`  pattern: "middleware.*"` |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` or `Ctrl+F` | Focus global search |
| `Alt+Left` | Navigate back |
| `Alt+Right` | Navigate forward |
| `b` | Toggle bookmark on selected function |
| `m` | Mute selected function |
| `Escape` | Clear highlights / close menus |

## Project Structure

```
cmd/main.go                  CLI entry point
go-call-graph.example.yaml   Example configuration file
API.md                       API documentation
internal/
  config/config.go           Configuration loading and defaults
  analyzer/
    analyzer.go              Go package loading and function extraction
    classifier.go            Statement classification, function reference detection, and complexity
    callgraph.go             SSA + VTA call graph construction
  model/types.go             Core data structures
  server/
    server.go                HTTP server, CORS middleware, and embedded frontend
    handlers.go              API endpoints
    storage.go               User data persistence and theme management
    web/                     Frontend (HTML/CSS/JS)
```

## How It Works

1. Loads Go packages using `golang.org/x/tools/go/packages`
2. Builds SSA representation and constructs a call graph via VTA (Variable Type Analysis)
3. Classifies statements (calls, error checks, log, defer, etc.), detects function value references and nested calls
4. Reads module path from go.mod to accurately distinguish project/stdlib/external packages
5. Serves results through a JSON API (with CORS support)
6. Frontend renders a code-chain canvas with dagre tree layout, file boxes, expandable function blocks, and call-site arrows

## License

[MIT](LICENSE)
