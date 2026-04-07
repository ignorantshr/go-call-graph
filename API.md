# go-call-graph API

Base URL: `http://localhost:<port>`

All API endpoints return JSON with `Content-Type: application/json`. CORS is enabled for all `/api/` routes.

---

## GET /api/project

Project root path.

**Response:**

```json
{ "root": "/absolute/path/to/project" }
```

---

## GET /api/tree

File/package tree for the left panel.

**Response:**

```json
{
  "name": "project",
  "type": "package",
  "children": [
    {
      "name": "cmd",
      "type": "package",
      "children": [
        { "name": "main.go", "type": "file", "path": "/abs/path/cmd/main.go" }
      ]
    }
  ]
}
```

Each node has `type` = `"package"` (directory) or `"file"`. Only file nodes have `path`.

---

## GET /api/file

Source code and function list for a file.

| Param | Type   | Required | Description        |
|-------|--------|----------|--------------------|
| path  | string | yes      | Absolute file path |

**Response:**

```json
{
  "path": "/abs/path/main.go",
  "package": "main",
  "source": "package main\n...",
  "functions": [
    {
      "id": "pkg/path.FuncName",
      "name": "FuncName",
      "signature": "func FuncName(a int) error",
      "doc": "FuncName does something.",
      "filePath": "/abs/path/main.go",
      "startLine": 10,
      "endLine": 25,
      "complexity": 3,
      "isExported": true,
      "recvType": "",
      "statements": [ "..." ]
    }
  ]
}
```

---

## GET /api/func

Function detail with callers and callees.

| Param | Type   | Required | Description                                            |
|-------|--------|----------|--------------------------------------------------------|
| id    | string | yes      | Function ID, e.g. `pkg/path.FuncName` or `pkg/path.(Type).Method` |

**Response:**

```json
{
  "id": "pkg/path.FuncName",
  "name": "FuncName",
  "signature": "func FuncName(a int) error",
  "doc": "...",
  "filePath": "/abs/path/main.go",
  "startLine": 10,
  "endLine": 25,
  "complexity": 3,
  "isExported": true,
  "statements": [
    {
      "startLine": 12,
      "endLine": 12,
      "code": "result := helper(a)",
      "category": "call",
      "callTarget": {
        "funcId": "pkg/path.helper",
        "package": "pkg/path",
        "function": "helper",
        "filePath": "/abs/path/util.go",
        "line": 5,
        "isStdLib": false,
        "isExternal": false
      },
      "foldable": false
    }
  ],
  "callers": ["pkg/path.main"],
  "callees": ["pkg/path.helper", "fmt.Println"]
}
```

Statement categories: `call`, `log`, `error_check`, `defer`, `assign`, `control`, `return`, `other`.

---

## GET /api/callgraph

Subgraph centered on a function, expanded by BFS to the given depth.

| Param | Type   | Required | Default          | Description                             |
|-------|--------|----------|------------------|-----------------------------------------|
| func  | string | yes      |                  | Center function ID                      |
| depth | int    | no       | config default(2)| BFS expansion depth                     |
| muted | string | no       |                  | Comma-separated function IDs to exclude |

**Response:**

```json
{
  "nodes": [
    {
      "id": "pkg/path.FuncName",
      "label": "FuncName",
      "package": "pkg/path",
      "isExported": true,
      "isStdLib": false,
      "complexity": 3
    }
  ],
  "edges": [
    { "from": "pkg/path.main", "to": "pkg/path.FuncName" }
  ]
}
```

---

## GET /api/chain

Shortest call paths between bookmarked functions.

| Param | Type   | Required | Description                             |
|-------|--------|----------|-----------------------------------------|
| nodes | string | yes      | Comma-separated function IDs            |
| muted | string | no       | Comma-separated function IDs to exclude |

**Response:** Same format as `/api/callgraph`.

---

## GET /api/mute/defaults

Default mute rules from the config file. The frontend loads these on startup as builtin rules.

**Response:**

```json
[
  { "type": "stdlib", "pattern": "" },
  { "type": "external", "pattern": "" },
  { "type": "package", "pattern": "github.com/foo/bar" }
]
```

Rule types: `stdlib`, `package`, `func`, `pattern`.

---

## GET /api/graph/project

Whole-project call graph (project functions + direct stdlib callees).

**Response:** Same format as `/api/callgraph`.

---

## GET /api/search

Search functions, files, and file contents.

| Param | Type   | Required | Description  |
|-------|--------|----------|--------------|
| q     | string | yes      | Search query |

**Response:**

```json
[
  {
    "type": "function",
    "id": "pkg/path.FuncName",
    "name": "FuncName",
    "package": "pkg/path",
    "filePath": "/abs/path/main.go",
    "line": 10
  },
  {
    "type": "file",
    "id": "/abs/path/main.go",
    "name": "main.go",
    "package": "main",
    "filePath": "/abs/path/main.go"
  },
  {
    "type": "text",
    "id": "/abs/path/main.go:15",
    "name": "main.go:15",
    "filePath": "/abs/path/main.go",
    "line": 15,
    "context": "matched source line text..."
  }
]
```

Result types: `function`, `file`, `text`. Text results are capped at 30.

---

## GET /api/userdata

Load user preferences (bookmarks, muted rules, views, theme, etc.).

**Response:**

```json
{
  "bookmarks": {},
  "muted": [],
  "views": {},
  "outline": false,
  "fontSize": 12,
  "theme": "dark"
}
```

---

## POST /api/userdata/save

Save user preferences.

**Request body:** Same structure as the `/api/userdata` response.

**Response:**

```json
{ "status": "ok" }
```

---

## GET /api/themes

List available theme names.

**Response:**

```json
["dark", "light"]
```

---

## GET /api/theme

Get theme CSS variable values.

| Param | Type   | Required | Description                        |
|-------|--------|----------|------------------------------------|
| name  | string | yes      | Theme name (alphanumeric, `-`, `_`) |

**Response:**

```json
{
  "bg-primary": "#1e1e2e",
  "bg-secondary": "#181825",
  "text-primary": "#cdd6f4",
  "..."
}
```
