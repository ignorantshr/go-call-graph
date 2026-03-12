# go-call-graph

交互式 Go 源码调用图分析工具。通过静态分析（VTA）解析 Go 项目，构建完整的函数调用图，并提供可交互的 Web 界面进行探索。

## 功能特性

- **层次化调用图** — 基于 dagre 的有向图布局，支持平移、缩放、拖拽、节点高亮
- **代码查看器** — 语法高亮的源码展示，支持调用链接跳转
- **调用链高亮** — 点击节点查看其调用者（蓝色）和被调用者（绿色）
- **文件内搜索** — 在当前文件中搜索文本，支持匹配项导航
- **全局文本搜索** — 跨项目所有文件搜索代码内容
- **行级书签** — 点击任意行号添加带标签的书签
- **函数书签** — 支持链路模式（展示书签间的调用路径）
- **静音系统** — 从图中隐藏标准库、特定包或函数
- **定位模式** — 开启后点击代码可聚焦对应的图节点
- **自动折叠** — 超过两行的注释默认折叠显示

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
| `callgraph` | `default_depth` | 子图查询的默认展开深度（默认 2） |
| `classifier` | `log_packages` | 被识别为"日志调用"的包路径列表 |
| `classifier` | `log_func_prefixes` | 用于检测日志调用的函数名前缀列表 |

**语句分类机制：** 分析代码时，每条语句会被分类为不同类别（call、log、error_check、defer 等）。被识别为 `log` 的调用在代码视图中会被标记为可折叠，视觉上弱化显示，帮助聚焦核心业务逻辑。识别规则为：调用目标的包路径在 `log_packages` 中，或函数名匹配 `log_func_prefixes` 前缀且包路径含 "log"/"zap"。`fmt.Print`/`Fprint`/`Sprint` 系列始终视为日志。如果项目使用了自定义日志库，请将其包路径添加到 `log_packages` 中。

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
internal/
  config/config.go           配置加载与默认值
  analyzer/
    analyzer.go              Go 包加载与函数提取
    classifier.go            语句分类与复杂度分析
    callgraph.go             SSA + VTA 调用图构建
  model/types.go             核心数据结构
  server/
    server.go                HTTP 服务与前端资源嵌入
    handlers.go              API 接口
    web/                     前端（HTML/CSS/JS）
```

## 工作原理

1. 使用 `golang.org/x/tools/go/packages` 加载 Go 包
2. 构建 SSA 中间表示，通过 VTA（变量类型分析）生成调用图
3. 对语句进行分类（函数调用、错误检查、日志、defer 等）
4. 通过 JSON API 提供分析结果
5. 前端渲染交互式层次化图（dagre）与代码查看面板

## 许可证

MIT
