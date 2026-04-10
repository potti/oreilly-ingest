# O'Reilly 自动化图书知识图谱及网盘上传 Agent SOP

本指南提供了一个基于 **OpenClaw Agent** 框架的标准作业程序 (SOP) 示例。该 Agent 的主要目标是自动完成从 O'Reilly 搜索特定技术书籍，下载，生成 Agent 知识，生成知识图谱 (Knowledge Graph)，并将最终的 PDF/EPUB 文件上传至百度网盘的全自动化流程。

## 1. Agent 任务定义与约束

- **触发条件**：定时任务（例如每天凌晨执行）或手动发送查询词触发。
- **依赖工具/系统**：
  - 本地运行的 `oreilly-ingest` 服务 (默认地址: `http://127.0.0.1:8000`)
  - 百度网盘 CLI / API 工具（假设系统中已配置并登录 `bypy` 或提供类似的 CLI 命令 `bypy upload <local_file> <remote_dir>`）。
  - Agent 自身的 LLM 模型能力（用于提取 Knowledge Graph）。

## 2. 标准作业程序 (SOP) 流程

Agent 需要严格按照以下顺序执行循环任务：

### 步骤 1: 按要求查找图书列表
- **Action**: 调用 `GET http://127.0.0.1:8000/api/oreilly/search?query=<USER_QUERY>&formats=book&include_facets=false&limit=20`。
- **Parse**: 解析返回结果，提取书籍列表，重点获取每本书的 `archive_id` 和 `title`。

### 步骤 2: 循环列表，选定一本并去重检查
- **Action**: 遍历上一步获取的书籍列表。对于每一本书，先调用 `GET http://127.0.0.1:8000/api/downloads` (或 `api/downloads/by-id`) 检查该书是否已被下载过。
- **Decision**: 如果已下载，则跳过处理下一本；如果未下载，进入步骤 3 开始处理。

### 步骤 3: 触发下载
- **Action**: 调用 `POST http://127.0.0.1:8000/api/download`
  - Body: `{"book_id": "<archive_id>", "format": "all"}` （选择 "all" 以同时生成 JSON、Markdown、EPUB 和 PDF）。
- **Wait/Poll**: 开始循环调用 `GET http://127.0.0.1:8000/api/progress`（建议每 3-5 秒一次），直到 `status` 变为 `"completed"`。如果状态为 `"error"` 或 `"cancelled"`，记录错误日志并跳过本书。

### 步骤 4: 生成 Agent Knowledge
- **Action**: 下载完成后，获取该书在输出目录中的文件夹名称（通常为 title 的 slug 形式，可从进度或 `/api/downloads/by-id` 接口获取）。
- **Call**: 调用 `POST http://127.0.0.1:8000/api/generate_knowledge`
  - Body: `{"book_name": "<folder_name>"}`
- **Wait/Poll**: 循环调用 `GET http://127.0.0.1:8000/api/progress`，直到 `status` 变为 `"knowledge_completed"`。如果状态为 `"knowledge_error"`，记录错误日志并跳过。

### 步骤 5: 检查生成进度与数据质量
- **Action**: 知识生成完成后，必须进行数据质量检查，以防生成失败或有内容缺失的章节。
- **Call**: 调用 `GET http://127.0.0.1:8000/api/kg/prompt?book_name=<folder_name>`
  - 系统内置了保护逻辑：如果 `agent_knowledge.json` 中存在错误或处理失败的章节，该接口会返回 HTTP 400 并在 `error` 字段中说明失败的章节数。
- **Decision**: 如果返回 HTTP 200 且拿到了 `prompt`，说明数据质量校验通过，继续步骤 6；如果返回 HTTP 400 错误，放弃本书后续步骤并记录“知识生成含有错误，跳过图谱生成”。

### 步骤 6: 生成 Knowledge Graph (KG)
- **Action**: 使用上一步 (`GET /api/kg/prompt`) 获取到的 `prompt`。
- **Call**: Agent 将此 `prompt` 发送给自身的 LLM 引擎，要求严格输出符合规范的 Property Graph JSON。
- **Save**: 调用 `POST http://127.0.0.1:8000/api/kg/save`
  - Body: `{"book_name": "<folder_name>", "graph": <LLM_JSON_OUTPUT>}`
- **Verify**: 检查保存是否返回 HTTP 200 成功。

### 步骤 7: 获取文件路径并上传至百度网盘
- **Action**: 获取生成的 PDF 和 EPUB 的本地绝对路径。
- **Call**: 调用 `GET http://127.0.0.1:8000/api/downloads/files?book_name=<folder_name>`。
  - 提取返回的 `pdf_files` 数组和 `epub_files` 数组中的第一个路径。
- **Upload Action**: 执行系统命令行工具将文件上传到百度网盘的 `books/<book_name>/` 目录下。
  - Example command: 
    ```bash
    bypy mkdir "books/<book_name>"
    bypy upload "<local_pdf_path>" "books/<book_name>/<pdf_filename>"
    bypy upload "<local_epub_path>" "books/<book_name>/<epub_filename>"
    ```
- **Complete**: 标记本书处理成功，返回步骤 2 处理下一本书。

---

## 3. Agent 提示词模板示例 (System Prompt)

```markdown
You are an autonomous OpenClaw Agent responsible for maintaining a technical book knowledge base.
Your job is to orchestrate the "oreilly-ingest" service to search, download, generate knowledge graphs, and backup books to Baidu Netdisk.

### Core Workflow (Follow Strictly for Each Target Book):
1. **Search**: Use `GET /api/oreilly/search?query=YOUR_TOPIC&formats=book&limit=10`.
2. **Deduplicate**: Before downloading, use `GET /api/downloads/by-id?book_id=<archive_id>` to ensure it hasn't been downloaded. If it exists, SKIP.
3. **Download**: Call `POST /api/download` with `{"book_id": "<archive_id>", "format": "all"}`.
4. **Wait for Download**: Poll `GET /api/progress` until `status` == "completed". Note the `title` or folder name.
5. **Generate Knowledge**: Call `POST /api/generate_knowledge` with `{"book_name": "<folder_name>"}`.
6. **Wait for Knowledge**: Poll `GET /api/progress` until `status` == "knowledge_completed".
7. **Quality Check & Get Prompt**: Call `GET /api/kg/prompt?book_name=<folder_name>`. 
   - *CRITICAL*: If this returns HTTP 400 (meaning there are errors in the generated knowledge), STOP processing this book immediately and move to the next book.
8. **Extract Graph**: If step 7 succeeds, take the returned `prompt`, use your internal LLM to generate the JSON graph.
9. **Save Graph**: Call `POST /api/kg/save` with `{"book_name": "<folder_name>", "graph": <YOUR_JSON>}`.
10. **Get File Paths**: Call `GET /api/downloads/files?book_name=<folder_name>` to retrieve the local paths of the PDF and EPUB files.
11. **Backup**: Execute shell commands to upload the files to Baidu Netdisk.
    - `bypy mkdir "books/<folder_name>"`
    - `bypy upload "<pdf_path>" "books/<folder_name>/"`
    - `bypy upload "<epub_path>" "books/<folder_name>/"`

You MUST handle errors gracefully. If any step times out or fails (HTTP 400/500), log the reason and safely proceed to the next book in the list. Do not get stuck in infinite polling loops; implement a reasonable timeout (e.g., max 15 minutes per book download).
```

## 4. 故障排查与恢复

- **API 无响应/鉴权失败**：如果 `GET /api/status` 返回非 200，说明 Cookie 可能过期。Agent 应暂停任务并发出警报要求人工更新 Cookie。
- **长时间挂起**：若下载或知识生成卡住（进度超过 10 分钟未更新），Agent 可以调用 `POST /api/cancel` 中断当前任务，并记录警告。
- **网盘上传失败**：通常是网络问题或 `bypy` 认证失效，Agent 可以在命令执行失败时实现 3 次指数退避重试，若仍失败则记录本地路径，留待后续手动处理。