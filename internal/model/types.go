package model

// ProjectAnalysis is the top-level analysis result for an entire Go project.
type ProjectAnalysis struct {
	Root       string                   `json:"root"`
	ModulePath string                   `json:"modulePath"` // Go module path from go.mod
	Packages   []string                 `json:"packages"`
	Files      map[string]*FileAnalysis `json:"files"`     // keyed by file path
	Functions  map[string]*FuncBlock    `json:"functions"`  // keyed by FuncID
	CallGraph  *CallGraphData           `json:"call_graph"`
}

// FileAnalysis holds analysis results for a single Go source file.
type FileAnalysis struct {
	Path      string      `json:"path"`
	Package   string      `json:"package"`
	Functions []*FuncBlock `json:"functions"`
}

// FuncBlock represents a function or method declaration with statement-level detail.
type FuncBlock struct {
	ID         string      `json:"id"`         // unique: "pkg/path.FuncName" or "pkg/path.(Type).Method"
	Name       string      `json:"name"`
	Signature  string      `json:"signature"`
	Doc        string      `json:"doc"`
	FilePath   string      `json:"filePath"`
	StartLine  int         `json:"startLine"`
	EndLine    int         `json:"endLine"`
	Complexity int         `json:"complexity"`
	Statements []Statement `json:"statements"`
	IsExported bool        `json:"isExported"`
	RecvType   string      `json:"recvType,omitempty"` // receiver type for methods
}

// Statement represents a single statement within a function body.
type Statement struct {
	StartLine  int         `json:"startLine"`
	EndLine    int         `json:"endLine"`
	Code       string      `json:"code"`
	Category   string      `json:"category"` // "call", "log", "error_check", "defer", "assign", "control", "return", "other"
	CallTarget *CallTarget `json:"callTarget,omitempty"`
	Foldable   bool        `json:"foldable"`
}

// CallTarget describes the target of a function call expression.
type CallTarget struct {
	FuncID     string `json:"funcId"`
	Package    string `json:"package"`
	Function   string `json:"function"`
	FilePath   string `json:"filePath,omitempty"`
	Line       int    `json:"line,omitempty"`
	IsStdLib   bool   `json:"isStdLib"`
	IsExternal bool   `json:"isExternal"`
}

// CallGraphData is a serializable representation of the call graph.
type CallGraphData struct {
	Nodes map[string]*CallGraphNode `json:"nodes"` // keyed by FuncID
}

// CallGraphNode holds the edges for a single function in the call graph.
type CallGraphNode struct {
	FuncID  string   `json:"funcId"`
	Callers []string `json:"callers"` // FuncIDs of callers
	Callees []string `json:"callees"` // FuncIDs of callees
}

// Statement categories.
const (
	CategoryCall       = "call"
	CategoryLog        = "log"
	CategoryErrorCheck = "error_check"
	CategoryDefer      = "defer"
	CategoryAssign     = "assign"
	CategoryControl    = "control"
	CategoryReturn     = "return"
	CategoryOther      = "other"
)
