# go-call-graph

交互式 Go 源码调用图分析工具。通过静态分析（VTA）解析 Go 项目，构建完整的函数调用图，并提供可交互的 Web 界面进行探索。

## 功能特性

- **代码链视图** — 点击函数加载其调用链，以浮动文件框展示，代码块可展开/折叠，箭头连接调用行与被调用函数
- **文件框** — 可拖拽、可调整大小的文件容器；dagre 树状自动布局（调用者在上，被调用者在下），支持自由拖拽调整位置
- **代码查看器** — 右侧面板展示语法高亮的源码，支持调用链接跳转
- **函数引用识别** — 不仅检测直接调用（`foo()`），还识别函数值引用（map 字面量、函数参数等）和嵌套调用
- **调用箭头** — 箭头从调用行精确出发，指向被调用函数的签名行
- **文件内搜索** — 在当前文件中搜索文本，支持匹配项导航
- **全局文本搜索** — 跨项目所有文件搜索代码内容
- **行级书签** — 双击行号添加带标签的书签
- **函数书签** — 支持链路模式（展示书签间的调用路径）
- **静音系统** — 通过配置文件或界面操作隐藏标准库、特定包或函数
- **画布文本标注** — 在画布上添加可编辑的文本注释，支持拖拽和调整大小
- **Pin 模式** — 深度降低时保持当前画布视图不变
- **定位模式** — 开启后点击代码可聚焦对应的调用链节点
- **自动折叠** — 超过两行的注释默认折叠显示
- **CORS 支持** — API 接口支持跨域调用，可供其它项目集成
- **泛型支持** — 正确处理 Go 泛型函数和泛型类型方法的调用图

## 安装

```bash
go install github.com/ignorantshr/go-call-graph/cmd/main.go@latest
```

## 构建

```bash
go build -o go-call-graph ./cmd/main.go
```

## 使用方法

```bash
go-call-graph --dir /path/to/go/project --port 8080
```

然后在浏览器中打开 `http://localhost:8080`。

### 命令行参数

| 参数 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--config` | `-c` | | YAML 配置文件路径 |
| `--dir` | `-d` | `.` | 目标 Go 项目目录 |
| `--port` | `-p` | `8080` | Web 服务端口 |
| `--dev` | | `false` | 从文件系统加载前端资源（开发模式） |

### 配置文件

使用 `--config` 从 YAML 文件加载配置。命令行参数优先级高于配置文件。

```bash
go-call-graph --config go-call-graph.yaml
go-call-graph --config go-call-graph.yaml --port 9090  # 命令行参数覆盖配置
```

可用配置项（完整注释示例见 `go-call-graph.example.yaml`）：

| 分组 | 配置项 | 说明 |
|------|--------|------|
| *(顶层)* | `dir`, `port`, `dev` | 与命令行参数一致 |
| *(顶层)* | `exclude` | 排除目录列表（相对于 dir） |
| `callgraph` | `default_depth` | 子图查询的默认展开深度（默认 2） |
| `mute` | *(列表)* | 默认静音规则，每次启动加载到前端 |

**静音规则类型：**

| 类型 | 说明 | 示例 |
|------|------|------|
| `stdlib` | 静音所有标准库函数 | `- type: stdlib` |
| `package` | 静音指定包路径 | `- type: package`<br>`  pattern: "github.com/foo/bar"` |
| `func` | 静音指定函数 | `- type: func`<br>`  pattern: "pkg.FuncName"` |
| `pattern` | 通配符匹配 | `- type: pattern`<br>`  pattern: "middleware.*"` |

### 快捷键

| 按键 | 功能 |
|------|------|
| `/` 或 `Ctrl+F` | 聚焦全局搜索框 |
| `Alt+Left` | 后退导航 |
| `Alt+Right` | 前进导航 |
| `b` | 切换选中函数的书签 |
| `m` | 静音选中函数 |
| `Escape` | 清除高亮 / 关闭菜单 |

## 项目结构

```
cmd/main.go                  命令行入口
go-call-graph.example.yaml   示例配置文件
API.md                       API 接口文档
internal/
  config/config.go           配置加载与默认值
  analyzer/
    analyzer.go              Go 包加载与函数提取
    classifier.go            语句分类、函数引用检测与复杂度分析
    callgraph.go             SSA + VTA 调用图构建
  model/types.go             核心数据结构
  server/
    server.go                HTTP 服务、CORS 中间件与前端资源嵌入
    handlers.go              API 接口
    storage.go               用户数据持久化与主题管理
    web/                     前端（HTML/CSS/JS）
```

## 工作原理

1. 使用 `golang.org/x/tools/go/packages` 加载 Go 包
2. 构建 SSA 中间表示，通过 VTA（变量类型分析）生成调用图
3. 对语句进行分类（函数调用、错误检查、日志、defer 等），检测函数值引用和嵌套调用
4. 从 go.mod 读取模块路径，准确区分项目/标准库/外部包
5. 通过 JSON API 提供分析结果（支持 CORS 跨域）
6. 前端渲染代码链画布，dagre 树状布局展示文件框、可展开的函数块和调用行箭头

## 许可证

[MIT](LICENSE)
