# go-call-graph

Interactive Go source code call graph analyzer. Parses a Go project via static analysis (VTA), builds a full call graph, and serves an interactive web UI for exploration.

## Features

- **Hierarchical call graph** — dagre-based directed graph with pan, zoom, drag, node highlighting
- **Code viewer** — syntax-highlighted source with call-link navigation
- **Call chain highlighting** — click a node to see its callers (blue) and callees (green)
- **File-internal search** — find text within the current file, with match navigation
- **Global text search** — search across all project files for code content
- **Line bookmarks** — click any line number to add a labeled bookmark
- **Function bookmarks** — bookmark functions with chain mode (show paths between bookmarks)
- **Mute system** — hide stdlib, specific packages, or functions from the graph
- **Locate mode** — toggle to click code and focus the corresponding graph node
- **Auto-folding** — long comments (>2 lines) are collapsed by default

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
| `callgraph` | `default_depth` | Default expansion depth for subgraph queries (default: 2) |
| `classifier` | `log_packages` | Package paths whose calls are classified as "log" |
| `classifier` | `log_func_prefixes` | Function name prefixes used to detect log calls |

**How statement classification works:** During analysis, each statement is categorized (call, log, error_check, defer, etc.). Statements classified as `log` are rendered as foldable in the code viewer, visually de-emphasized so you can focus on core logic. The classifier identifies log calls by checking if the target package is in `log_packages`, or if the function name matches a prefix in `log_func_prefixes` and the package path contains "log" or "zap". Calls to `fmt.Print`/`Fprint`/`Sprint` are always treated as log. If your project uses a custom logging library, add its package path to `log_packages`.

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
internal/
  config/config.go           Configuration loading and defaults
  analyzer/
    analyzer.go              Go package loading and function extraction
    classifier.go            Statement classification and complexity
    callgraph.go             SSA + VTA call graph construction
  model/types.go             Core data structures
  server/
    server.go                HTTP server with embedded frontend
    handlers.go              API endpoints
    web/                     Frontend (HTML/CSS/JS)
```

## How It Works

1. Loads Go packages using `golang.org/x/tools/go/packages`
2. Builds SSA representation and constructs a call graph via VTA (Variable Type Analysis)
3. Classifies statements (calls, error checks, log, defer, etc.)
4. Serves results through a JSON API
5. Frontend renders an interactive hierarchical graph (dagre) with a code viewer panel

## License

MIT
