# VSCode 插件化调研 — Token 用量统计 + Codex/Claude 配置接入

> 调研时间：2026-10-28。对象：本机 VSCode **1.143.1**（stable，`e6468682`）、`anthropic.claude-code@2.1.312`、`openai.chatgpt@26.1021.22027`、`codex-cli 0.164.0`、`claude 2.1.311`。
> 依据：本机 `vscode.d.ts`（`v1.143.1` tag 原始文件）+ 官方文档（`code.visualstudio.com`、`code.claude.com`、`developers.openai.com`）+ **本机真实数据文件**（`~/.dsh`、`~/.codex`、`~/.claude`、`~/.cc-switch`）。凡标 ✅ 的是本机实测，标 📄 的是文档，标 ❓ 的是未能证实。

## 0. 结论先行（八条）

1. **扩展宿主没有被文件沙箱限制** ✅。VSCode 文档里说的「sandbox」专指 **Copilot agent 跑终端命令**的沙箱（`chat.agent.sandbox.*`），与扩展宿主进程无关。扩展可以自由读 `~/.codex`、`~/.claude`、`~/.dsh`，也可以写 `~/.codex/config.toml`。这是本项目的**可行性前提**，不存在「需要 wider access 才能写 home」的问题。
2. **监听工作区外目录，官方 API 就够** ✅。`vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(<工作区外目录>), '**/*.jsonl'))` 是 `vscode.d.ts` 注释里**明文给出的用法**。不需要 chokidar，也不需要轮询兜底（但建议保留低频兜底）。
3. **`~/.codex` 与 `~/.claude` 的日志全是「追加式 JSONL」**，天然适合增量读取 ✅。Codex 是 `.jsonl[.zst]`（**后缀不固定**，见 §4.2），Claude 是纯 `.jsonl`。VSCode 扩展宿主实测是 **Node 24.21.0**，`node:zlib.zstdDecompressSync` 与 **`node:sqlite` 均可用** ✅ —— 前者用于解压，后者用于存增量事件（Codex 单文件可达 302 MB，JSON 全量重写不可行）。但 Web 扩展宿主里两者都不可用，故本项目不做 Web 版。
4. **Codex 的 `wire_api = "chat"` 是 fatal 错误，不是 deprecated** ✅。上游源码 `model-provider-info` 的 `WireApi` 枚举**只剩 `Responses` 一个变体**，本机实测写 `chat` 直接启动失败、退出码 1（`` `wire_api = "chat"` is no longer supported ``）。这直接决定「接入」的可行性边界：**中转站必须实现 OpenAI Responses API，否则 Codex 接不上**。这是本项目最大的外部风险。
5. **Claude 侧有官方「宿主托管供应商」机制** 📄：`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`。它由**嵌入 Claude Code 的宿主应用**设置，设置后 Claude Code 忽略 settings 里的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 等。我们的扩展**属于这类宿主**，语义上完全对得上；但该变量是给「用 SDK 内嵌 Claude Code」的应用设计的，我们没有内嵌 SDK —— 需要确认它能否仅靠 `env` 注入生效（❓，见 §5.4 的备选方案）。
6. **两个工具的配置都会被第三方改写，必须做「可回滚的局部写入」** ✅。本机 `cc-switch`（`CC Switch.app`）已经在管理 `~/.claude/settings.json` 和 `~/.codex/config.toml`，并且在 `127.0.0.1:15721` 跑本地代理。我们的插件若整文件覆盖，会**直接破坏 cc-switch 的当前供应商**。
7. **Claude 的会话日志有重复记录，直接累加会多算** ✅。实测：514 个唯一 `message.id`，却有 **535 条 usage 完全相同的重复**、**49 条 usage 不同的重复**（早期流式半成品 vs 最终记录）。去重规则必须按 `message.id` 取「`stop_reason` 非空者优先、否则取最大 usage」，否则统计口径直接错。
8. **Codex 的 token 事件是累计值，必须用 delta** ✅。每条 `token_count` 同时带 `total_token_usage`（累计）与 `last_token_usage`（本轮增量）。实测 312 条事件全部有 `last_token_usage`。**只能累加 `last_token_usage`**，累加 `total_token_usage` 会得到天文数字。

## 1. 运行时版本矩阵（本机实测）

| 组件 | 版本 | 路径 / 备注 |
| --- | --- | --- |
| VSCode | **1.143.1** stable | `/Applications/Visual Studio Code.app`；`code` CLI 位于 `Contents/Resources/app/bin/code` |
| VSCode 扩展宿主 | **Node 24.21.0 / Electron 43.7.7**（✅ 实测） | 用 `ELECTRON_RUN_AS_NODE=1 "Code Helper (Plugin)" -e ...` 验证；`node:sqlite` 与 `zlib.zstdDecompressSync` **均可用** |
| Claude Code VSCode 扩展 | `anthropic.claude-code` **2.1.312** | `~/.vscode/extensions/anthropic.claude-code-2.1.312-darwin-arm64` |
| Claude Code CLI | **2.1.311** | `~/.local/bin/claude` |
| Codex VSCode 扩展 | `openai.chatgpt` **26.1021.22027** | 自带 `codex-cli 0.164.0-alpha.11.1` 二进制（`bin/macos-aarch64/codex`） |
| Codex CLI | **0.164.0** | `/opt/homebrew/bin/codex` |
| DSH 现有插件 | `dsh-token-metrics` **0.3.6** | 本仓库；Host 3734 行 + Client 8674 行 |
| 第三方配置管理器 | **CC Switch** `4.0.21` | `~/.cc-switch/`，SQLite（`cc-switch.db`），本地代理 `127.0.0.1:15721` |

> 注意：`engines.vscode` 不能照抄本机 1.143。参考两个真实扩展：Claude 用 `^1.94.0`，Codex 用 `^1.96.2`。本项目建议 `^1.96.0`（覆盖 Cursor/Windsurf 的常见基线），要用新 API 再上抬。

## 2. 扩展宿主：沙箱、拓扑与数据可达性

### 2.1 沙箱结论（关键，且与直觉相反）

`code.visualstudio.com/docs/agents/run/agent-sandboxing` 原文：「Sandboxing applies to **terminal commands and their child processes**. When configured, it also applies to MCP and language servers started or managed for the session.」

即：**沙箱的边界是 Copilot agent 通过终端拉起的进程**，不是扩展宿主。扩展宿主自身以用户身份运行，读写 `$HOME` 不受该机制约束。
**对本项目的直接影响：** 不需要申请任何特殊权限、不需要 `sandbox_permissions`、不需要「受信任工作区白名单」就能读写用户主目录下的 dotfiles。

### 2.2 `extensionKind` 与远程开发 📄

| 场景 | 扩展跑在哪 | 读谁的 `~/.claude` |
| --- | --- | --- |
| 本地 VSCode 桌面版 | local extension host | 本机 ✅ |
| SSH / Dev Container / WSL / Codespace | **remote** extension host（默认） | 远端机器的 `~/.claude` |
| vscode.dev | web extension host | 无 Node，读不到 |

声明 `"extensionKind": ["ui", "workspace"]` 可以让扩展**优先在本地 UI 侧跑**（这样能读本地 dotfiles），代价是读不到远程工作区的文件。
**建议：** 本项目的核心资产（dotfiles、日志）在「用户本机」，因此 **`extensionKind: ["ui"]`** 更符合语义；同时用 `vscode.env.remoteName` 检测远程场景并降级提示（「当前为远程窗口，统计的是宿主本机数据」）。
反例参考：Claude 官方扩展声明了 `capabilities.untrustedWorkspaces.supported: false`，即它**不支持**不受信任的工作区 —— 因为它要执行 CLI。

### 2.3 数据可达性实测

| 目标 | 是否可达 | 证据 |
| --- | --- | --- |
| `~/.dsh/token-metrics/usage.json` | ✅ | 924 KB，插件自己的聚合账本 |
| `~/.dsh/sessions/**/session.v4.jsonl.zstd` | ✅ | 169 个文件 / 57 MB |
| `~/.codex/config.toml` | ✅ | 可读可写（见 §5 风险） |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` | ✅ | **两种后缀并存**：7 天内是未压缩 `.jsonl`，7 天以上被后台任务压缩为 `.jsonl.zst`（本机实测 605 zst / 8 plain，按 mtime 完美分层） |
| `~/.claude/settings.json` | ✅ | 已被 cc-switch 改写，含自定义 `env` 块 |
| `~/.claude/projects/<slug>/*.jsonl` | ✅ | 22 个文件 / 18 MB |

## 3. VSCode API 事实清单

### 3.1 监听工作区外文件的官方姿势（重要）

`vscode.d.ts` 中 `createFileSystemWatcher` 的注释直接给出：

```ts
// 监听工作区外的某个目录
vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(vscode.Uri.file('/Users/x/.claude/projects'), '**/*.jsonl')
)
```

`RelativePattern` 的构造函数签名（`vscode.d.ts:2321`）：`constructor(base: WorkspaceFolder | Uri | string, pattern: string)`。
**结论：** 无需第三方库即可增量监听 `~/.claude/projects`、`~/.codex/sessions`。
**注意：** 递归 `**` 在 macOS/Win/Linux 上由 VSCode 的 watcher 服务实现（不是 `fs.watch`），跨平台一致；但**网络盘 / 超大目录**可能漏事件，因此要配合「启动全量 + 定期兜底扫描」。

### 3.2 Webview（看板页）

| 能力 | 事实 | 建议 |
| --- | --- | --- |
| `retainContextWhenHidden` | 保留 DOM 状态，但**内存开销大**，官方明确不建议滥用 | 用 `getState/setState` + 重建，而不是常驻 |
| 资源加载 | 必须走 `webview.asWebviewUri`，并设置 CSP | 用 esbuild 把 React 打成单文件 `dist/webview.js` |
| 主题 | `--vscode-*` CSS 变量可直接用，能自动跟随明暗主题 | 现有 DSH 插件的配色（亮/暗两套）可直接映射 |
| 通信 | `webview.postMessage` ↔ `onDidReceiveMessage`，只能传 JSON 可序列化值 | 聚合结果体量要控制（见 §4.4） |

**性能底线（来自现有插件的实测经验）：** `snapshot()` 遍历全部桶约 3 ms，DSH 侧还能缓存 3 s。VSCode 侧 Webview 重建成本更高，应**服务端算好再推**，前端只画。

### 3.3 其余 API 的稳定状态

| API | 状态 | 用途 |
| --- | --- | --- |
| `ExtensionContext.globalState` / `Memento` | 稳定 | 存窗口状态、上次扫描位点 |
| `context.secrets`（`SecretStorage`） | 稳定 | **存供应商 API Key 的唯一正确位置** |
| `context.globalStorageUri` / `logUri` | 稳定 | 自有缓存与日志目录 |
| `window.createStatusBarItem` | 稳定 | 状态栏「今日 $x.xx / 1.2M tok」 |
| `window.registerTreeDataProvider` / `viewsContainers` | 稳定 | 侧边栏明细树 |
| `window.createTerminal` + `TerminalProfileProvider` | 稳定 | 「用插件配置的供应商启动 codex/claude」 |
| `window.createOutputChannel` | 稳定 | 后台扫描日志 |
| `vscode.workspace.getConfiguration` | 稳定 | 扩展设置 |
| `window.registerUriHandler` | 稳定 | 从 DSH 页面跳回 VSCode |
| **`createUtilityProcess`** | **稳定 API 中不存在** ❓ | 长耗时解析不能开子进程 → 只能 worker_threads（Node 内置）或分行异步解析 |
| `lm.registerLanguageModelChatProvider` | **稳定**（1.143 的 `vscode.d.ts` 有） | 见 §3.4 |
| `languageModelPricing` / `chatProvider` | **proposed** | `product.json` 的 `extensionEnabledApiProposals` 里存在，**发布版扩展不可用** |

### 3.4 `vscode.lm` 与「能不能顺手计量 Copilot」

稳定 API 有 `LanguageModelChatProvider`（`registerLanguageModelChatProvider(vendor, provider)`），实现 `provideLanguageModelChatInformation` / `provideLanguageModelChatResponse` / `provideTokenCount`。**它只面向「让 Copilot Chat 使用你提供的模型」**，`LanguageModelChatInformation` 里没有任何 usage/cost 字段，**也没有任何 API 能读到别的工具（Copilot/Codex 扩展）的 token 消耗**。

> 结论：**不可能通过 VSCode 官方 API 统计 Copilot 的用量。** 本项目要统计的 Harness/Codex/Claude 用量，只能走各自的日志/OTel/自建代理。`vscode.lm` 对本项目的价值是另一件事：**让插件的供应商出现在 Copilot 的模型选择器里**（可作为后续功能，且需要 `languageModelPricing` 等 proposed API 才有成本信息，发布版不可用）。

## 4. 三家数据源的实测结构

### 4.1 DSH（Harness）

- 聚合账本：`$DSH_HOME/token-metrics/usage.json`（本机 924 KB）。顶层键：`version`、`total`、`byDay`、`byHour`、`byProvider`、`byModel`、`byModelName`、`byProject`、`byOrigin`、`bySession`、`performance`、`seen`、`scanned`、`failedAttempts` 等。
- 会话日志：`$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`（**zstd**）。
- **已有的 HTTP 接口**：`GET /api/dsh-token-metrics/summary` 在本机 `http://127.0.0.1:50115` **实测可用** ✅，返回 `{generatedAt, today, totals, ...}`。
- **端口发现是个坑** ❓：DSH 端口随宿主启动而变（`127.0.0.1:50115` 是本次会话的），仓库里没有稳定的「端口文件」，只有 `.workbuddy-host-heartbeat.json`（不含端口）。因此「HTTP 优先」必须自带端口探测（扫 `lsof`/尝试常用端口/读 DSH 配置），失败即回落直读磁盘。

### 4.2 OpenAI Codex（实测）

- 路径：`$CODEX_HOME` 或 `~/.codex`；日志 `sessions/YYYY/MM/DD/rollout-*.jsonl` 或 `.jsonl.zst`。
  **后缀不固定** ✅：压缩是启动时的后台任务，**只压 7 天以上**的文件（上游 `rollout/src/compression.rs` 的 `MIN_ROLLOUT_AGE = 7d`）。本机实测 605 个 `.zst` 全在 7 天外、8 个未压缩全在 7 天内。**解析器必须同时支持两种**，否则近期会话读不到。本机最大单文件 302 MB / 2247 行。
- 每行一个事件；`type` 取值实测：`session_meta`、`turn_context`、`event_msg`（`payload.type` 含 `token_count`、`task_started`、`item_completed`）、`response_item`、`world_state`。
- **`token_count` 结构**（原样摘录）：

```json
{"timestamp":"…","type":"event_msg","payload":{"type":"token_count","info":{
  "total_token_usage":{"input_tokens":38606623,"cached_input_tokens":31900928,
    "cache_write_input_tokens":0,"output_tokens":206184,
    "reasoning_output_tokens":101307,"total_tokens":38812807},
  "last_token_usage":{"input_tokens":236350,"cached_input_tokens":235520,
    "cache_write_input_tokens":0,"output_tokens":356,
    "reasoning_output_tokens":148,"total_tokens":236706},
  "model_context_window":258400}}}
```

- **去重/口径**：累加 `last_token_usage`；`total_token_usage` 仅用于校验（末值应等于累加和）。
- **模型归属**：在 `turn_context.payload.model`（每轮），不在 `token_count` 里。
- **项目归属**：`session_meta.payload.cwd` / `runtime_workspace_roots`。
- **来源归属**：`session_meta.payload.originator`（本机实测到 `Codex Desktop`、`codex_exec`、`codex-tui`、`source: vscode`）—— **这就是「按来源拆分」的天然字段**。

### 4.3 Anthropic Claude Code（实测）

- 路径：`$CLAUDE_CONFIG_DIR` 或 `~/.claude`；日志 `projects/<cwd-slug>/<session-uuid>.jsonl`（**纯 JSONL**）。
- 每条 `type: "assistant"` 记录带 `message.usage`：

```json
{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,
 "output_tokens":99,"service_tier":"standard",
 "cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},
 "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},
 "inference_geo":"","iterations":[],"speed":"standard"}
```

- **模型在记录级**：实测 `modelInMsg: 1098 / modelAtRecord: 0` → 用 `o.message.model`。
- **去重是最大陷阱** ✅：`uniqueMsgIds: 514` 但 `dupSameUsage: 535`、`dupDiffUsage: 49`。重复记录形态是「先写 `output_tokens:0` 且无 `stop_reason`，后写完整记录」。**规则：按 `message.id` 取 `stop_reason` 非空者；否则取 usage 最大者。**
- **`<synthetic>` 消息**（36 条）不计费，需跳过。
- **`cwd` / `gitBranch` 在记录级**，可据此恢复项目路径 —— **不要反解目录 slug 名**（分隔符替换是有损的）。
- 完整口径实测结果：`input 5,603,645 / output 272,924 / cacheRead 36,768,934 / cacheWrite 7,755,135 / 478 calls`（22 文件、18 MB、约 0.2 s 完成解析）。

### 4.4 三源统一后的量级评估

DSH 本机账本：`calls 11724`、`totalTokens 3,590,254,844`（35.9 亿）。合并三源后，Webview 首屏**绝不能把全量明细传过去**。建议：
- Host 侧算聚合（totals / byDay / byModel / byProvider / bySource），只传结果；
- 明细表按需分页拉取（`postMessage` 带 `{view, page}`）；
- 原始事件永不进 Webview。

## 5. 「接入」：把插件里的供应商写进 Codex / Claude 配置

### 5.1 Codex 侧（官方 schema，`developers.openai.com/codex/config-reference`）📄

`[model_providers.<id>]` 现已确认的字段（节选，**全部来自官方 reference**）：

| 字段 | 类型 | 关键说明 |
| --- | --- | --- |
| `name` | string | 显示名 |
| `base_url` | string | **API base**（`.../v1`） |
| `model_catalog_url` | string | Codex 原生模型目录 URL（可省） |
| `env_key` | string | **推荐**：环境变量名，指向 API Key |
| `experimental_bearer_token` | string | 直接写 token，官方标注 discouraged |
| `requires_openai_auth` | boolean | 用 OpenAI 登录态 |
| `wire_api` | `responses` | **只支持 `responses`**；`chat` 是 fatal 错误 |
| `query_params` / `http_headers` / `env_http_headers` | map | 附加参数与头 |
| `request_max_retries` / `stream_max_retries` / `stream_idle_timeout_ms` | number | 默认 4 / 5 / 300000 |
| `supports_websockets` / `supports_standalone_web_search` | boolean | 能力声明 |
| `auth.command` / `.args` / `.timeout_ms` / `.refresh_interval_ms` / `.cwd` | — | **命令产出 bearer token**（与 `env_key` 互斥） |
| `openai_base_url`（顶层） | string | 改内置 openai 的 base，**不能**用 `[model_providers.openai]` 覆盖 |
| `model_catalog_json`（顶层） | path | **自定义模型的容量/推理档位靠它** |
| `model_context_window` / `model_auto_compact_token_limit` | number | 兜底声明窗口 |

**自定义模型没有目录条目时的正确做法**（决定 Codex 能否正确压缩上下文）：
```toml
model_provider = "mysite"
model = "deepseek-v4.1-flash"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
model_catalog_json = "/Users/xxx/.codex/my-catalog.json"

[model_providers.mysite]
name = "我的中转"
base_url = "https://api.example.com/v1"
env_key = "CODE_KEY_MYSITE"      # 凭据只留引用名
wire_api = "responses"
```
本机 `~/.codex/cc-switch-model-catalog.json` 证明目录格式为 `{ "models": [ { slug, display_name, context_window, auto_compact_token_limit, supported_reasoning_levels, … } ] }` ✅。

**OTel**：Codex 有 `[otel]` 段（`otel.exporter` / `otel.metrics_exporter` / `otel.trace_exporter` / `otel.environment` 等，`otlp-http|otlp-grpc|none`）📄。但它**没有文档化的 token 指标名** ❓，因此**不建议**把 OTel 作为 Codex 的主数据源 —— JSONL 才是权威且无损。

### 5.2 Claude 侧（官方 schema，来自本机扩展自带的 `claude-code-settings.schema.json`）✅

该文件是 **Anthropic 官方随扩展分发的** settings JSON Schema，约 200 个顶层键，比 schemastore 更新。与本项目相关的：

| 键 | 作用 | 备注 |
| --- | --- | --- |
| `env` | 任意环境变量字符串表 | **接入网关的主通道**：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_DEFAULT_*_MODEL` |
| `model` / `fallbackModel` | 默认与回退模型 | `ANTHROPIC_MODEL` 会覆盖 `model` |
| `modelPicker` | **自定义 `/model` 选择器**（`replaceBuiltInOptions` + `options[{model,label,description,behavesAs?}]`） | 只能来自 managed / `--settings` / **用户设置** |
| `availableModels` / `deniedModels` / `enforceAvailableModels` | 模型白/黑名单 | 主要面向 managed |
| `modelOverrides` | 把 Anthropic 模型 ID 映射到网关 ID | 解决「窗口识别」问题 |
| `modelPricing` | **自定义计价**：`multiplier` (0,10] + `overrides{input,output,cacheRead,cacheWrite}`（四项必填，单位 USD/Mtok） | 影响 `/cost`、statusLine、OTel cost |
| `statusLine` | `{type:"command", command, padding, refreshInterval}` | 可作**实时用量回传通道** |
| `apiKeyHelper` / `otelHeadersHelper` | 脚本产出凭据/OTel 头 | 避免明文密钥 |
| `sandbox` / `hooks` / `cleanupPeriodDays` | 沙箱、钩子、清理 | 与本项目弱相关 |

**`modelPricing` 的作用域限制（原文摘录）**：「Only honored from managed settings (server-managed, MDM / OS policy, or managed-settings.json), or — when none of those sets it — when supplied by a **host application that manages the model provider**; ignored in user, project, local and `--settings` sources.」
→ 这意味着**我们在用户设置里写 `modelPricing` 大概率不生效**。要自定义成本，只能：① 走 managed 源（不适合个人用户）；② 自己算成本（本项目现有 `src/pricing.js` 已经能做，且支持峰谷计价），**不依赖 Claude 自己的 cost 字段**。

**环境变量优先级（官方原文）**：「Environment variables aren't a level in this stack…`ANTHROPIC_MODEL` exported in your shell applies over the `model` key from any file.」→ **shell 环境变量会压过 settings 里的同名配置**。写配置时必须提示用户「已存在的 shell 导出会覆盖插件设置」。

**`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`** 📄：由嵌入 Claude Code 的宿主设置；置位后 Claude Code **忽略 settings 里的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`CLAUDE_CODE_USE_BEDROCK`**。语义正是「宿主托管供应商」，但它是给**通过 SDK 内嵌**的应用用的。我们的扩展只能通过「启动终端时注入 env」来设置它 —— 是否能仅靠 env 生效 ❓，需做一次 C 端实验；若不生效，退回 §5.3 的方案。

### 5.3 写入策略（两个文件都已被 cc-switch 接管 ✅）

本机事实：`~/.claude/settings.json` 的 `env` 里已有 cc-switch 写入的 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721` 与一组 `ANTHROPIC_DEFAULT_*_MODEL`；`~/.codex/config.toml` 里已有 `[model_providers.custom]`。**整文件覆盖 = 与 cc-switch 互相踩踏。**

因此必须采用「**带标记的局部写入 + 快照回滚**」：

1. **只改自己的命名空间**：Codex 侧用独立 provider id（如 `[model_providers.dsh-token-metrics]`），并写 `model_provider`；Claude 侧只写 `env` 下白名单键，不动 `hooks`/`permissions`/`enabledPlugins`。
2. **保留原文件快照**：写到 `context.globalStorageUri/backup/<tool>/<timestamp>.bak`，并记录**我们改了哪些键、原值是什么**（JSON patch 语义），支持一键回滚。
3. **原子写**：写临时文件 + `rename`（两个工具都会**热重载**配置，见 §5.4；半截文件会被判定为 Settings Error）。
4. **冲突检测**：写入前比对「我们上次写入的指纹」，若文件被外部（cc-switch/用户）改动则提示而不是硬写。
5. **探测进程**：`ps` 里有无 `codex`/`claude` 在跑，提示「重启会话后生效」。
6. **不写明文密钥**：Codex 用 `env_key`（引用名），Claude 用 `ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper`；密钥本体进 `context.secrets`。
   ⚠️ 但 `env` 块只能放字符串 —— 若要 Claude 免 shell 导出就用密钥，必须落盘明文或改用 `apiKeyHelper` 脚本。**这是必须向用户明示的安全取舍点。**

### 5.4 运行期行为（决定实现细节）📄

- **Claude Code 会监听 settings 文件并热重载**（官方原文：「Claude Code watches your settings files and reloads them when they change」），对 `permissions`、`hooks`、`apiKeyHelper` 等即时生效。
- Claude 的 settings 是**严格 JSON**：「a `//` comment or a trailing comma is a syntax error」，坏文件会在下次启动报 Settings Error。→ **必须校验后再写，且写入必须原子**。
- Codex 侧是否为启动时读取 ❓（未在文档中找到「热重载」表述）；保守假设**需重启会话**。

## 6. 打包、发布、测试

| 项 | 结论 |
| --- | --- |
| 入口 | `main: "./dist/extension.js"`（esbuild 打包，`external: ['vscode']`） |
| Web 扩展 | 需要 `browser` 入口 + 纯 WebWorker 运行时（**没有 `node:zlib`、没有 `fs`**）→ 本项目**不做 Web 扩展**，只做桌面 |
| 最小版本 | `engines.vscode: "^1.96.0"`（参考 Claude `^1.94.0`、Codex `^1.96.2`） |
| 测试 | `@vscode/test-electron`（跑真实宿主）+ 纯 Node 单测（解析/去重/计价，**可完全脱离 VSCode**） |
| 打包 | `@vscode/vsce package` → `.vsix`；`vsce publish` 上 Marketplace |
| Open VSX | **必发**（Cursor/Windsurf 走 Open VSX）→ `ovsx publish`，需在 open-vsx.org 建命名空间 |
| 自更新 | **不能**像 npm 包那样自更新；桌面端只能靠 Marketplace/Open VSX 或手动装 `.vsix`（现有 DSH 插件的 `PluginUpdater` 经验**不能直接搬**） |
| 体积 | 注意不要打包 zstd 原生依赖 —— 用 `node:zlib` 内置实现（✅ 宿主 Node 24.21 已验证） |
| 沙箱/签名 | VSIX 签名对 Marketplace 发布是可选项；Open VSX 不要求 |

## 7. 与本项目的直接冲突/风险清单（按严重度）

| # | 风险 | 严重度 | 处置 |
| --- | --- | --- | --- |
| 1 | **Codex 只支持 `responses` 协议**，大量中转站只有 `chat/completions` | 🔴 高 | 接入前先探测供应商的 `/v1/responses` 可用性；不可用时明确告知「Codex 无法接入该站」，不静默失败 |
| 2 | 与 **cc-switch 抢写**同一批配置文件 | 🔴 高 | 局部写入 + 指纹校验 + 快照回滚（§5.3） |
| 3 | Claude 日志重复记录导致**多计费** | 🔴 高 | `message.id` + `stop_reason` 去重（§4.3） |
| 4 | Codex **累计 vs 增量** token 字段 | 🔴 高 | 只用 `last_token_usage`（§4.2） |
| 5 | **DSH 端口不稳定**，HTTP 优先策略易失败 | 🟡 中 | 端口探测 + 直读磁盘兜底（本机 summary 接口已验证可用） |
| 6 | 工作区外 watcher 在极端情况下漏事件 | 🟡 中 | 启动全量 + 低频兜底扫描 + `globalState` 存位点 |
| 7 | 大文件解析阻塞扩展宿主（302 MB zstd） | 🟡 中 | 分块/流式 + worker_threads；首屏先出聚合再补明细 |
| 8 | 远程/Web 场景语义错位 | 🟡 中 | `extensionKind: ui` + `env.remoteName` 提示 |
| 9 | `modelPricing` 在用户设置不生效 | 🟢 低 | 自算成本，不依赖 Claude 的 cost 字段 |
| 10 | shell 环境变量压过 settings | 🟢 低 | 写入后提示 + 提供「检测冲突」按钮 |
| 11 | 发布到 Marketplace 需要 publisher 账号与 PAT | 🟡 中 | 需用户提供；Open VSX 需单独注册命名空间 |

## 8. 可复用资产盘点（本仓库）

| 模块 | 行数 | VSCode 侧可复用性 |
| --- | --- | --- |
| `src/pricing.js` | 623 | ✅ 纯逻辑，直接复用（峰谷计价、汇率、倍率、模型别名） |
| `src/balance.js` | 697 | ✅ 余额探测 + 34 个平台适配器，直接复用 |
| `src/providers.js` | 729 | ✅ 平台识别 / 模型目录，直接复用 |
| `src/sync.js` | 360 | 🟡 结构可参考，但目标是 DSH 配置 → 需新写 Codex/Claude 适配 |
| `src/push.js` | 450 | 🟡 SSE 通知 → VSCode 侧换成状态栏/通知 |
| `src/updater.js` / `reload.js` | ~1000 | ❌ VSCode 无自更新与热重载，基本不复用 |
| `index.js` 的解析/回扫/去重 | ~3700 | 🟡 思路复用，代码需按 Node 扩展宿主重写 |
| `client.js` | 8674 | 🟡 图表/明细/筛选的**交互与配色**可参考，DOM 层要重写为 Webview |

> 关键结论：**统计口径与成本核算逻辑是资产，Web 前端与宿主生命周期绑定部分是负债。** 建议把 `pricing/balance/providers` 提升为共享模块，VSCode 包与 DSH 包同时消费，避免两套口径漂移。

## 9. 待确认（需要一次实验或用户决策）

1. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 能否仅通过终端 env 注入生效（决定 Claude 接入是「干净托管」还是「写 settings」）。
2. Codex `/v1/responses` 在用户现有中转站上的实际可用率（决定接入功能的价值）。
3. 是否接受「Claude `env` 块内明文 `ANTHROPIC_AUTH_TOKEN`」这一安全取舍，还是统一走 `apiKeyHelper` 脚本。
4. 是否要在 VSCode 侧也做「余额/配额」页（复用 `balance.js` 成本很低）。
5. 发布主体：Marketplace publisher + Open VSX 命名空间由谁注册。

## 10. 参考

- VSCode Extension Host：https://code.visualstudio.com/api/advanced-topics/extension-host
- VSCode 沙箱（仅 agent 终端）：https://code.visualstudio.com/docs/agents/run/agent-sandboxing
- VSCode 类型定义（1.143.1）：https://raw.githubusercontent.com/microsoft/vscode/1.143.1/src/vscode-dts/vscode.d.ts
- Codex 配置参考：https://developers.openai.com/codex/config-reference
- Codex 高级配置：https://developers.openai.com/codex/config-advanced
- Claude Code 设置：https://code.claude.com/docs/en/settings
- Claude Code 环境变量：https://code.claude.com/docs/en/env-vars
- Claude Code 监控/Otel：https://code.claude.com/docs/en/monitoring-usage
- Claude Code 模型配置：https://code.claude.com/docs/en/model-config
- Claude Code statusLine：https://code.claude.com/docs/en/statusline
- 本机实测数据：`~/.dsh/token-metrics/usage.json`、`~/.codex/sessions/**`、`~/.claude/projects/**`、`~/.cc-switch/cc-switch.db`
