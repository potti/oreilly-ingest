# O'Reilly Ingest 项目代码 Wiki

## 1. 项目概述

`oreilly-ingest` 是一个旨在将 O'Reilly 学习平台上的技术图书导出为多种格式（如 Markdown, PDF, EPUB, JSON 以及适用于 LLM 的纯文本/Chunks）的工具。本项目核心采用了基于插件的微内核架构（Plugin-based microkernel design），并内建了一个提供 Web UI 界面的 HTTP 服务，使用户可以轻松地搜索、预览、选择章节并下载电子书。

## 2. 项目整体架构

项目整体分为后端和前端两个部分。后端由 Python 编写，采用自定义的微内核模式；前端由 React + TypeScript + Vite 构建。

### 核心架构：微内核与插件化
系统以 `Kernel` 为总线中心，所有业务逻辑组件（如认证、图书元数据获取、章节下载、格式转换等）均抽象为独立的插件（Plugin），在系统启动时注册到 Kernel 中。组件之间通过 Kernel 获取彼此的引用，实现高度解耦和可扩展性。

### 目录结构
```text
oreilly-ingest/
├── cli/            # CLI 命令行入口
├── core/           # 核心层：包含微内核实现、HTTP 客户端、LLM Agent处理器等
├── plugins/        # 插件层：具体的业务逻辑和输出格式生成器
├── scripts/        # 运维及启动脚本
├── utils/          # 通用工具函数
├── web/            # Web 层：包含 Python HTTP 服务器和前端 React UI
│   └── ui/         # 前端 React 源码目录
├── config.py       # 全局配置，如目录、URL及请求头设置
├── main.py         # 项目主入口文件
└── Dockerfile / docker-compose.yml # 容器化部署配置
```

## 3. 主要模块职责

### 3.1 `core/` (核心层)
- **`kernel.py`**: 定义了 `Kernel` 类，负责注册和管理所有插件。提供 `create_default_kernel()` 函数，用于在系统启动时挂载所有内置插件。
- **`http_client.py`**: 封装了 `requests.Session`，负责处理 Cookie 鉴权、速率限制（Rate limiting）和重试等，提供与 O'Reilly API 的基础交互。
- **`agent_grain_processor.py`**: 集成 LLM (如 Ollama) 的处理逻辑。核心能力包括分析抓取的书籍章节并生成供 Agent 消费的结构化 JSON（包含要点、可执行操作等），以及生成知识图谱（Knowledge Graph）结构。

### 3.2 `plugins/` (插件层)
业务处理与格式导出的主要场所。所有的类都继承自 `plugins.base.Plugin`。
- **核心业务插件**:
  - `auth.py`: 处理 O'Reilly 的登录鉴权及 Cookie 的读取验证。
  - `book.py`: 搜索书籍、获取图书元数据。
  - `chapters.py`: 获取章节列表及章节 HTML 内容。
  - `assets.py`: 下载书籍依赖的静态资源（图片、CSS 样式等）。
  - `html_processor.py`: 清洗、转换章节 HTML（移除无关标签、处理图片链接、转为 XHTML 等）。
- **导出格式插件**:
  - `epub.py`, `markdown.py`, `pdf.py`, `plaintext.py`, `json_export.py`: 负责将清洗后的内容转换为目标格式。
  - `chunking.py`: 为 LLM 的上下文窗口优化，提供分块（Chunking）文本输出。
- **流程调度插件**:
  - `downloader.py`: 核心调度器，编排元数据获取 -> 资源下载 -> 格式生成的完整工作流。

### 3.3 `web/` (Web 服务层)
- **`server.py`**: 实现了一个多线程的 HTTP 服务器（继承自 `http.server.SimpleHTTPRequestHandler`）。
  - 提供 RESTful API (如 `/api/search`, `/api/download`, `/api/progress` 等) 供前端调用。
  - 托管 `web/ui/dist` 中的静态前端页面。
  - 内部利用锁 (`threading.Lock`) 和后台线程来异步执行下载任务和 LLM 知识抽取任务。
- **`web/ui/`**: Vite + React 项目，提供了友好的图形界面，方便用户配置 Cookie、搜索书籍及查看下载进度。

## 4. 关键类与函数说明

- **`core.kernel.Kernel`**
  - **职责**: 插件注册表。
  - **关键方法**: `register(name, plugin)` 注册插件；`get(name)` 或 `__getitem__(name)` 获取插件实例。

- **`core.http_client.HttpClient`**
  - **职责**: 统一的网络请求客户端。
  - **关键机制**: 初始化时自动加载 `cookies.json`；内部实现了 `_rate_limit` 控制请求频率。

- **`plugins.downloader.DownloaderPlugin`**
  - **职责**: 下载任务的总体编排者。
  - **关键方法 `download(...)`**: 接收目标格式、选定章节等参数，串联调用 `book`, `chapters`, `assets`, `html_processor` 插件完成资源拉取，再按需调用对应的输出插件生成文件。它还通过 `progress_callback` 将进度实时汇报给 Web 层。

- **`web.server.DownloaderHandler`**
  - **职责**: 路由处理与后台任务派发。
  - **关键方法 `_handle_download(...)`**: 接收前端发来的下载请求，启动守护线程（`threading.Thread`）调用 `DownloaderPlugin.download`，并维护下载状态字典以供轮询。

- **`core.agent_grain_processor.generate_agent_knowledge`**
  - **职责**: 将书籍章节喂给本地或远程 LLM，生成具有结构化关键点（Key Points）和可执行操作（Actionable）的 Agent Knowledge JSON。

## 5. 依赖关系

### 后端核心依赖 (`requirements.txt`)
- **网页解析与清洗**: `beautifulsoup4`, `lxml`, `soupsieve`
- **网络通信**: `requests`, `urllib3`, `certifi`
- **格式生成**:
  - `ebooklib`: 用于生成 EPUB 电子书。
  - `weasyprint`: 基于 HTML 生成高质量 PDF。
  - `markdownify`: 将 HTML 转换为 Markdown。
- **LLM/文本处理**: `tiktoken` (Token 计算)

### 前端依赖 (`web/ui/package.json`)
- **核心库**: `react`, `react-dom`, `typescript`
- **构建工具**: `vite`, `tailwindcss`, `postcss`

## 6. 项目运行方式

本项目支持本地 Python 环境运行和 Docker 容器化运行。运行前需要有效的 O'Reilly 订阅账户，并通过 Web UI 配置对应的 Cookie。

### 方式一：使用 Docker (推荐)
通过 Docker Compose 可以一键拉起后端服务与预编译好的前端页面。
```bash
git clone https://github.com/potti/oreilly-ingest.git
cd oreilly-ingest
docker compose up -d
```
启动后访问 `http://localhost:8000`。

### 方式二：本地 Python 运行
适合开发与调试。需安装 Python 3.10+。
```bash
git clone https://github.com/potti/oreilly-ingest.git
cd oreilly-ingest

# 1. 创建并激活虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 2. 安装后端依赖
pip install -r requirements.txt

# 3. 启动主程序
python main.py
```
终端会输出服务启动日志，浏览器访问 `http://localhost:8000`。

> **提示**: 如果要修改前端代码，需要进入 `web/ui` 目录，执行 `npm install` 与 `npm run build`，将构建产物输出到 `web/static`（由于当前项目使用 SimpleHTTPRequestHandler 直接伺服静态资源，具体构建命令需参考 `web/ui/package.json`）。
