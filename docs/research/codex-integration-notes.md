# Codex CLI 集成调研笔记（工程计划输入）

> 调研日期：2026-10-28
> 目标版本：`codex-cli 0.164.0`（本机 `/opt/homebrew/bin/codex`），VSCode 扩展自带 `0.164.0-alpha.11.1`
> 方法：优先读 **上游源码 + 上游生成的 JSON Schema + 官方 `.md` 文档**，其次读**本机真实文件与真实运行结果**。
> 所有结论都带来源。`web_search`/`web_fetch` 在本环境不可用，全部走 `curl`。
> 凡未能确认的一律标注 **UNVERIFIED**（文末有汇总清单）。
>
> **脱敏声明**：本机 `~/.codex/config.toml` 中的 `experimental_bearer_token`、`auth.json` 等密钥类值一律替换为 `<REDACTED>`。
> 其他例如 `base_url`、账号 id 等按「工程可见」处理，未做脱敏（如需可再收窄）。

## 0. 本次使用的证据源（可复现）

| 证据源 | 获取方式 | 用途 |
| --- | --- | --- |
| `https://learn.chatgpt.com/docs/config-file/config-reference.md` | `curl -sL` | 配置键权威清单（133 KB） |
| `https://learn.chatgpt.com/docs/config-file/config-advanced.md` | `curl -sL` | provider/profile/OTel 章节 |
| `https://learn.chatgpt.com/docs/config-file/config-basic.md` | `curl -sL` | 优先级顺序 |
| `https://learn.chatgpt.com/docs/model-catalogs.md` | `curl -sL` | 模型 catalog 规范 |
| `https://learn.chatgpt.com/docs/non-interactive-mode.md` | `curl -sL` | `codex exec` / `--json` / `--ephemeral` |
| `https://codeload.github.com/openai/codex/tar.gz/refs/heads/main` | `curl -sL`（19 MB，需重试） | **上游源码，最强证据** |
| `codex-rs/core/config.schema.json` | 源码内 | **机器可读的权威配置 schema** |
| `codex-rs/model-provider-info/src/lib.rs` | 源码内 | `ModelProviderInfo` 字段真值 + `wire_api` 反序列化 |
| `codex-rs/rollout/src/*.rs` | 源码内 | rollout 路径/命名/压缩规则 |
| `~/.codex/config.toml`、`cc.config.toml`、`cc-switch-model-catalog.json`、`sessions/**`、`archived_sessions/**`、`history.jsonl` | 本机只读 | 真实落地形态 |
| `~/.vscode/extensions/openai.chatgpt-26.1021.22027-darwin-arm64/` | 本机只读 | IDE 扩展行为 |

实测辅助：把 `~/.codex/config.toml` 与 catalog **复制**到 `/tmp/codexverify/home`，用 `CODEX_HOME` 指向副本跑 `codex exec`，**全程未修改 `~/.codex` 任何文件**（原文件 md5 前后一致：`b8bfe631217822c3e2a2f0764badbe4b`）。

---

## 1. 配置布局与优先级

### 1.1 位置

- 用户级：`~/.codex/config.toml`。官方原文：「Codex stores user-level configuration at `~/.codex/config.toml`」— `md/config-file_config-basic.md`
- `CODEX_HOME` 覆盖整个状态根：「Sets the root for Codex state, including config, auth, logs, sessions, skills... **If you set it, the directory must already exist.**」— `md/config-file_environment-variables.md`
  - 该"目录必须已存在"在本机**实测成立**：`CODEX_HOME=/tmp/codexverify`（不存在的目录）→ `Error: No such file or directory (os error 2)`，退出码 1。
- 项目级：`<repo>/.codex/config.toml`，从项目根向下逐层加载到 cwd，**最近的优先**；且**仅在项目被信任时加载** — `md/config-file_config-advanced.md`

### 1.2 官方优先级（高 → 低）

`md/config-file_config-basic.md` 原文列出 7 层：

1. CLI flags 与 `--config` 覆盖
2. 项目配置 `.codex/config.toml`（根 → cwd，最近者胜；仅可信项目）
3. `--profile <name>` 选中的 profile 文件 `~/.codex/<name>.config.toml`
4. 用户配置 `~/.codex/config.toml`
5. 云端下发的 `config.toml` 默认值（登录工作区时）
6. 系统配置 `/etc/codex/config.toml`（Unix）
7. 内置默认值

### 1.3 ⚠️ Profiles 已变更为「一文件一 profile」（0.134.0 起）

这是**最容易踩坑的一条**，因为网上大量旧教程仍写 `[profiles.x]`。

官方原文（`md/config-file_config-advanced.md#profiles`）：

> In Codex 0.134.0 and later, `--profile` no longer reads `[profiles.profile-name]` from `config.toml`, and the top-level `profile = "profile-name"` selector is no longer supported. Move legacy profile settings into `~/.codex/profile-name.config.toml`, then remove the matching `[profiles.profile-name]` table and `profile = "profile-name"` selector from `config.toml`.

**本机 0.164.0 实测**（`/tmp/codextest`，`config.toml` 内含 `[profiles.fast]`，命令行 `--profile fast`）：

```
Error loading config.toml: --profile `fast` cannot be used while /private/tmp/codextest/config.toml
contains legacy `profile = "fast"` or `[profiles.fast]` config; move those settings into
/private/tmp/codextest/fast.config.toml and remove the legacy profile selector/table.
```

改用 `~/.codex/fast.config.toml`（顶层键，不嵌套 `[profiles.*]`）后**实测成功**，`codex exec` 头部显示 `model: gpt-5-mini` / `reasoning effort: low`，且 `config.toml` 内容**未被改动**。

注意两个 schema 键仍然存在（`codex-rs/core/config.schema.json` 的 `properties.profile` / `properties.profiles`），但**运行时拒绝**——不要以 schema 是否存在判断能否用。

`--help` 也印证了新语义：`-p, --profile <CONFIG_PROFILE_V2>` → "Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config"。

### 1.4 CLI `-c/--config` 覆盖

`codex exec --help` 原文：

> `-c, --config <key=value>` — Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`. Use a dotted path (`foo.bar.baz`) to override nested values. **The `value` portion is parsed as TOML. If it fails to parse as TOML, the raw string is used as a literal.**

所以 `-c model='"gpt-6.1-sol"'` 需要内层引号，`-c model_reasoning_effort=high` 不需要。另有 `--enable/--disable <FEATURE>`，等价 `-c features.<name>=true/false`。

### 1.5 本机真实 `config.toml`（已脱敏）

`~/.codex/config.toml`（3405 B，mtime 2026-10-28 09:16）：

```toml
model_provider = "custom"
model = "gpt-6.1-sol"
notify = ["/Users/hugoyu/.codex/computer-use/.../SkyComputerUseClient", "turn-ended"]
model_context_window = 1000000
model_auto_compact_token_limit = 900000
model_catalog_json = "cc-switch-model-catalog.json"
model_reasoning_effort = "high"

[model_providers]
[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://anyrouter.top/v1"
experimental_bearer_token = "<REDACTED>"

[desktop]
followUpQueueMode = "queue"
show-context-window-usage = true
enabled-reasoning-efforts = ["low","medium","high","xhigh","ultra","persistent","max"]

[features]
local_thread_store_compression = true
memories = true

[projects."/Users/hugoyu/Desktop/无纸化平台"]
trust_level = "trusted"
```

（另有 `[mcp_servers.node_repl]`、`[marketplaces.*]`、`[plugins.*]`、`[memories]`、`[tui]` 等段落，与本次集成关系不大，略。）

**关键实测**：把这份**原样** config 复制到临时 `CODEX_HOME`，用 `--strict-config` 跑 `codex exec` → **无 unknown key 报错**，正常启动。说明本机配置在当前版本是合法的。唯一的警告是 `local_thread_store_compression` 属 under-development feature。

**注意 `model_catalog_json = "cc-switch-model-catalog.json"` 是相对路径**，但 schema 定义是 `AbsolutePathBuf`（`codex-rs/core/config.schema.json` → `properties.model_catalog_json` → `$ref: AbsolutePathBuf`）。本机它能跑通，说明相对路径按 **`CODEX_HOME`** 解析（实测：把 catalog 复制进临时 `CODEX_HOME` 后即可加载）。⚠️ 这一相对路径解析规则**上游文档未明说**，属实测推断，标记 **PARTIALLY VERIFIED**。

---

## 2. `[model_providers.<id>]` schema（当前版本全量字段）

权威来源：`codex-rs/model-provider-info/src/lib.rs` 的 `struct ModelProviderInfo`（带 `#[schemars(deny_unknown_fields)]`），与生成的 `codex-rs/core/config.schema.json#/definitions/ModelProviderInfo`（`additionalProperties: false`）。两者字段完全一致。

### 2.1 字段全表（0.164.0）

| 字段 | 类型 | 说明（源码/文档原文摘要） |
| --- | --- | --- |
| `name` | string | 显示名。**default 空串** |
| `base_url` | string | OpenAI 兼容 API base URL |
| `wire_api` | `"responses"` | **只有 responses 合法**，见 §2.2 |
| `env_key` | string | 提供 API key 的环境变量名 |
| `env_key_instructions` | string | 提示用户如何获取该 key |
| `experimental_bearer_token` | string | 直接给 `Authorization: Bearer`，源码注释「discouraged; use `env_key`」；被 `RedactedString` 包裹 |
| `auth` | table | 命令式取 token，见 §2.3 |
| `gateway_oauth` | table | 网关 OAuth（`authorization_url`,`token_url`,`client_id`,`scopes`,`resource`,`redirect_port`,`delivery`） |
| `aws` | table | SigV4（`profile`,`region`,`credential_export`,`auth_refresh`） |
| `capabilities` | table | `external_web_access` (bool)、`remote_compaction` (`"unsupported"`/`"v2"`) |
| `model_catalog_url` | string | **新字段**。Codex 原生 catalog 的完整 URL；不设则用 provider 默认发现逻辑 |
| `query_params` | map<string,string> | 追加到请求的 query 参数 |
| `http_headers` | map<string,string> | 静态请求头 |
| `env_http_headers` | map<string,string> | 头名 → **环境变量名**；变量未设或为空则该头不发送 |
| `request_max_retries` | u64 | 默认 **4**，上限 100 |
| `stream_max_retries` | u64 | 默认 **5**，上限 100 |
| `stream_idle_timeout_ms` | u64 | 默认 **300000** |
| `websocket_connect_timeout_ms` | u64 | 默认 15000（`DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS`） |
| `requires_openai_auth` | bool | 默认 false |
| `supports_websockets` | bool | 是否支持 Responses WebSocket transport |
| `supports_standalone_web_search` | bool | 默认 false，见 §2.4 |
| `project_id` / `location` / `credential_file` | string | 仅内置 GCP provider 用 |

**超时相关**：上游**没有**单独的 `request_timeout_ms` / `timeout` 字段。可用的只有 `request_max_retries`、`stream_max_retries`、`stream_idle_timeout_ms`、`websocket_connect_timeout_ms`。若需要整体请求超时，只能靠 `stream_idle_timeout_ms`。**`request_timeout_ms` 不存在 → 勿发明。**

**`requires_auth` 不存在**。schema 与源码里只有 `requires_openai_auth`。已在 `config.schema.json` 全文搜索 `requires_auth` 无结果。

**保留 ID**：`openai`、`ollama`、`lmstudio`（文档）以及源码中的 `amazon-bedrock`、`amazon-bedrock-runtime`、`gcp`，自定义 provider **不可占用**。

### 2.2 ⚠️ `wire_api = "chat"` 已被移除（不是 deprecate，是**删除**）

源码 `model-provider-info/src/lib.rs`：

```rust
pub struct WireApi { ... }   // 枚举只剩一个成员
#[serde(rename_all = "lowercase")]
pub enum WireApi {
    /// The Responses API exposed by OpenAI at `/v1/responses`.
    #[default]
    Responses,
}

const CHAT_WIRE_API_REMOVED_ERROR: &str = "`wire_api = \"chat\"` is no longer supported.\nHow to fix: set `wire_api = \"responses\"` in your provider config.\nMore info: https://github.com/openai/codex/discussions/7782";

impl<'de> Deserialize<'de> for WireApi {
    fn deserialize<D>(d: D) -> Result<Self, D::Error> ... {
        match value.as_str() {
            "responses" => Ok(Self::Responses),
            "chat" => Err(serde::de::Error::custom(CHAT_WIRE_API_REMOVED_ERROR)),
            _ => Err(serde::de::Error::unknown_variant(&value, &["responses"])),
        }
    }
}
```

**本机 0.164.0 实测**（`/tmp/codextest`）：

```
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
More info: https://github.com/openai/codex/discussions/7782
in `model_providers.mine.wire_api`
```
退出码 1，**整个 config 加载失败**（不是忽略该字段）。

连带影响：`ollama-chat` provider 也已移除，错误串为 `` `ollama-chat` is no longer supported ``。同时官方 `config-advanced` 里那句「Chat Completions providers will ignore the setting」是**过时残留文案**，与源码矛盾，应以源码为准。

**工程结论**：任何「OpenAI 兼容 = Chat Completions」的第三方中转（大量国产中转、one-api、new-api 默认 `/v1/chat/completions`）在 0.164 **完全不可用**，除非它实现了 `/v1/responses`。这是本调研对方案影响最大的一条。

### 2.3 `[model_providers.<id>.auth]`（命令式取 token）

```toml
[model_providers.proxy.auth]
command = "/usr/local/bin/fetch-codex-token"  # 必填，直接 exec，不经 shell
args = ["--audience", "codex"]
timeout_ms = 5000            # default 5000
refresh_interval_ms = 300000 # default 300000；设 0 = 仅在认证重试后刷新
cwd = "..."                  # optional
```
约束（文档 + 源码注释一致）：token 打到 stdout，Codex trim 空白，空 token 视为错误；**不可**与 `env_key` / `experimental_bearer_token` / `requires_openai_auth` 同时使用。

### 2.4 `supports_standalone_web_search`

文档原文：「The setting defaults to `false` for custom providers. Standalone web search is **under development and off by default**. Setting the provider capability to `true` **doesn't enable it**: the provider must support a compatible endpoint, and the selected model and runtime must support standalone search.」— `md/config-file_config-advanced.md`

### 2.5 provider 选择与模型相关顶层键

| 键 | 类型 | 备注 |
| --- | --- | --- |
| `model_provider` | string | 指向 `model_providers` 的 key（默认 `openai`） |
| `model` | string | 模型 slug |
| `model_reasoning_effort` | enum | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`/`persistent`，另支持 `Custom(String)`（源码 `ReasoningEffort`） |
| `model_reasoning_summary` | enum | — |
| `plan_mode_reasoning_effort` | enum | — |
| `model_verbosity` | enum | 仅 Responses 生效 |
| `model_context_window` | int64 | **覆盖 catalog 的 context window** |
| `model_auto_compact_token_limit` | int64 | 自动压缩阈值 |
| `model_auto_compact_token_limit_scope` | `"total"` \| `"body_after_prefix"` | 统计口径 |
| `model_post_turn_compact_threshold_percent` | 0–100 int | 回合结束后按可用窗口百分比压缩 |
| `model_catalog_json` | AbsolutePathBuf | 本地 catalog，见 §2.6 |
| `openai_base_url` | string | 仅改内置 `openai` provider 的 base URL |

### 2.6 ⚠️ `model_max_output_tokens` 不存在

在**整个上游源码**（`grep -rn "model_max_output_tokens"` on `codex-rs/`）中**零命中**；在 `core/config.schema.json` 中也不存在。**不要写这个键**。

当前 catalog 中**没有** output-token 上界字段；`ModelInfo`（`codex-rs/protocol/src/openai_models.rs`）里与"上限"相关的只有：

- `context_window: Option<i64>`
- `max_context_window: Option<i64>` — 注释：「**Maximum context window allowed for config overrides.**」
- `auto_compact_token_limit: Option<i64>` — 注释：「When omitted, core derives it from `context_window` (90%). When provided, core **clamps it to 90% of the context window**」
- `effective_context_window_percent: i64` — 默认 95，注释：「Percentage of the context window considered usable for inputs, after reserving headroom for system prompts, tool overhead, and **model output**」

所以「输出预留」是靠 `effective_context_window_percent` 隐式表达的，不是独立 token 数。

### 2.7 ⭐ 自定义模型如何获得 context window / 输出上限（核心问题）

这决定压缩是否正确，必须讲清。三条路径，**优先级从高到低**：

**路径 A：`model_catalog_json`（推荐，唯一能给「非内置模型」完整元数据的方式）**

- schema：`properties.model_catalog_json` → `AbsolutePathBuf`，描述「Optional path to a JSON model catalog (**applied on startup only**). Per-thread `config` overrides are accepted but **do not reapply this** (no-ops).」
- 加载实现 `core/src/config/mod.rs`：解析失败报 `failed to parse model_catalog_json path ... as JSON`；`catalog.models.is_empty()` 直接报错 `must contain at least one model`。
- 文档 `md/model-catalogs.md`：catalog = `ModelsResponse`，顶层 `models` 数组；**每个 entry 必须有唯一非空 `slug`**；类型定义见 `codex-rs/protocol/src/openai_models.rs` 的 `ModelsResponse` / `ModelInfo`（文档明确指向 `rust-v<version>` tag 下的 `protocol/src/openai_models.rs`）。
- 源码注释（`core/src/config/mod.rs`）：「When set, this **replaces the bundled catalog** for the current process.」
- 远端替代方案：`[model_providers.<id>.model_catalog_url]`，但文档明确「**Remove any effective `model_catalog_json` setting from clients using the endpoint: the local file takes precedence and prevents remote fetching.**」→ 两者互斥，且**本地文件优先**。

**本机真实 catalog 证据**（`~/.codex/cc-switch-model-catalog.json`，262 KB，4 个 entry，顶层只有 `models` 一个 key）。

用户描述里的键名需要**纠正**：`max_output_tokens` **不存在**；实际存在的是 `max_context_window`。4 个 entry 的键并集（43 个，实测枚举）：

```
additional_speed_tiers, apply_patch_tool_type, auto_compact_token_limit, availability_nux,
base_instructions, comp_hash, context_window, default_reasoning_level, default_reasoning_summary,
default_verbosity, description, display_name, effective_context_window_percent,
experimental_supported_tools, include_apps_usage_instructions, include_plugin_usage_instructions,
include_skills_usage_instructions, input_modalities, max_context_window, model_messages,
multi_agent_reasoning_effort, multi_agent_version, node_repl_auto_review_required,
node_repl_disabled, priority, service_tiers, shell_type, slug, support_verbosity, supported_in_api,
supported_reasoning_levels, supports_experimental_context, supports_image_detail_original,
supports_parallel_tool_calls, supports_reasoning_effort_updates, supports_reasoning_summaries,
supports_search_tool, tool_mode, truncation_policy, upgrade, use_responses_lite, visibility,
web_search_tool_type
```

本机某个 entry 的关键取值：

```json
{
  "slug": "gpt-6.1-sol",
  "display_name": "GPT-6.1-Sol",
  "context_window": 1000000,
  "max_context_window": 1000000,
  "auto_compact_token_limit": 900000,
  "effective_context_window_percent": 95,
  "supported_reasoning_levels": [
    {"effort":"low","description":"Fast responses with lighter reasoning"},
    {"effort":"medium", ...}, {"effort":"high", ...},
    {"effort":"xhigh", ...}, {"effort":"max", ...}, {"effort":"ultra", ...}
  ],
  "comp_hash": "3000",
  "shell_type": "freeform",
  ...
}
```

对应本机 `config.toml` 里 `model_context_window = 1000000` / `model_auto_compact_token_limit = 900000`，即**catalog 值与 config 值一致**（900000 = 90% × 1000000，正好是 `ModelInfo::auto_compact_token_limit()` 的 clamp 上限）。

**路径 B：`model_context_window` 顶层键（轻量，但没有模型专属指令）**

`config.schema.json` 描述就一句「Size of the context window for the model, in tokens.」。它能覆盖 context window，但**不提供** `base_instructions`、`shell_type`、`apply_patch_tool_type`、`supported_reasoning_levels` 等模型专属行为。

**路径 C：什么都不配 → fallback metadata（有害）**

**本机实测**：模型不在 catalog 且未设 context window 时，stderr 输出

```
warning: Model metadata for `gpt-5` not found. Defaulting to fallback metadata;
this can degrade performance and cause issues.
```

`codex exec --json` 中该警告以 item 形式出现：
```json
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
```
源码里对应 `ModelInfo.used_fallback_model_metadata: bool`（注释：「Internal-only marker set by core when a model slug resolved to fallback metadata」）。**fallback 下 context window 不可靠 → 压缩阈值错误 → 要么过早压缩，要么超窗报错。** 这正是需求里担心的场景，已实测确认存在。

**压缩链路精确规则**（`ModelInfo` 方法，源码）：

```rust
fn resolved_context_window() -> Option<i64> { self.context_window.or(self.max_context_window) }
fn usable_context_window()  -> Option<i64> { resolved * effective_context_window_percent / 100 }
fn auto_compact_token_limit() -> Option<i64> {
    let context_limit = resolved.map(|c| (c * 9) / 10);
    match context_limit {
        Some(l) => Some(config_limit.map_or(l, |x| min(x, l))),
        None => config_limit,
    }
}
```
即：**auto_compact 永远 ≤ 90% context window**；无 context window 时才直接采用配置值。

---

## 3. Session logs / token 记账

### 3.1 路径与命名（实测 + 源码双确认）

- 目录：`~/.codex/sessions/YYYY/MM/DD/`
- 命名（`codex-rs/rollout/src/rollout_file_name.rs`）：
  - 普通：`rollout-{YYYY}-{MM}-{DD}T{HH}-{mm}-{ss}-{thread_id}.jsonl`
  - 被 revert 的线程：`rollout-{ts}-{thread_id}_{rollout_id}.jsonl`（下划线分段，两 ID 不同）
  - 时间戳格式精确为 `[year]-[month]-[day]T[hour]-[minute]-[second]`（**秒级**，`T` 分隔，`-` 作时分秒分隔符）
- **⚠️ 后缀不是固定 `.zst`**。源码 `rollout/src/compression.rs`：
  - `const COMPRESSED_SUFFIX: &str = ".zst";`
  - `const MIN_ROLLOUT_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);`
  - `COMPRESSION_LEVEL: i32 = 3`，`MAX_CONCURRENT_COMPRESSION_JOBS = 2`，`RUN_MARKER_FILE_NAME = "rollout-compression.lock"`
  - 触发点只有 `Startup` 和 `Rpc` 两个；后台 best-effort，不阻塞启动。
  - **结论：`.jsonl` 是常态，`.jsonl.zst` 只出现在「超过 7 天且压缩任务已跑过」的文件上。**本机两者并存——`sessions/2026/10/17/...zst` 与本次实测新生成的 `sessions/2026/10/28/rollout-...jsonl` 同时存在。
  - **解析器必须同时支持两种后缀**，这是本机实测最容易漏的一点。

本机实测数量：`~/.codex/sessions` 下 614 个文件（仅 `2026/` 一年）；`~/.codex/archived_sessions` 365 个。

### 3.2 行格式

每行一个 JSON 对象，**统一外壳**（`codex-rs/rollout/src/lib.rs`、`history/src/lib.rs`）：

```json
{"timestamp":"2026-09-03T04:36:26.278Z","ordinal":22,"type":"<tag>","payload":{...}}
```

- `timestamp`：ISO-8601 UTC，毫秒
- `ordinal`：从 0 递增的整数，**同一 rollout 内唯一且有序**，可用于去重/断点续读
- `type`：`RolloutItem` 的 serde tag（`#[serde(tag="type", rename_all="snake_case")]`，见 `history/src/rollout_payload.rs` 的 `RolloutItemWire`）

`RolloutItem` 变体（`history/src/lib.rs`）→ 落盘 `type` 值：

| Rust 变体 | 落盘 `type` |
| --- | --- |
| `SessionMeta` | `session_meta` |
| `TurnContext` | `turn_context` |
| `WorldState` | `world_state` |
| `TokenUsageRecord` | `token_usage_record` |
| `EventMsg` | `event_msg` |
| `ResponseItem` | `response_item` |
| `Compacted` | `compacted` |
| `DynamicToolsUpdated` | `dynamic_tools_updated` |
| `InterAgentCommunication` | `inter_agent_communication` |
| `InterAgentCommunicationMetadata` | `inter_agent_communication_metadata` |
| `RetainedContext` | `retained_context` |
| `SecurityRiskScore` | `security_risk_score` |
| `RealtimeItem` | `realtime_item` |

`event_msg` 的 `payload.type` 值（本机 153 个 rollout 实测枚举）：

| `payload.type` | 含义 |
| --- | --- |
| `task_started` / `task_complete` | 回合起止 |
| `token_count` | **token 记账，见 §3.3** |
| `item_completed` | 单个 item 完成（含 `thread_id`,`turn_id`,`item`,`started_at_ms`,`completed_at_ms`） |
| `thread_settings_applied` | 线程设置变更（**含 `model`、`model_provider_id`**） |
| `turn_aborted` | 回合中断 |

`response_item` 的 `payload.type`：`message`、`reasoning`、`function_call`、`function_call_output`、`custom_tool_call`、`custom_tool_call_output`。

### 3.3 `token_count` 精确 schema（实测样本 + 源码）

源码 `codex-rs/protocol/src/protocol.rs`：

```rust
pub struct TokenCountEvent { pub info: Option<TokenUsageInfo>, pub rate_limits: Option<RateLimitSnapshot> }
pub struct TokenUsageInfo {
    pub total_token_usage: TokenUsage,
    pub last_token_usage: TokenUsage,
    pub model_context_window: Option<i64>,   // TODO(aibrahim): make this not optional
}
pub struct TokenUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    #[serde(default)] pub cache_write_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    // 另有 skip_serializing 的 codex_rollout_budget_units: Option<Number>
}
```

本机真实样本（`sessions/2026/09/03/rollout-2026-09-03T12-33-56-01a06245-...zst`，第 2 条 `token_count`）：

```json
{
  "timestamp": "2026-09-03T04:36:30.760Z",
  "ordinal": 28,
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {"input_tokens":53011,"cached_input_tokens":29184,"cache_write_input_tokens":0,"output_tokens":751,"reasoning_output_tokens":424,"total_tokens":53762},
      "last_token_usage":  {"input_tokens":26875,"cached_input_tokens":25344,"cache_write_input_tokens":0,"output_tokens":40, "reasoning_output_tokens":7,  "total_tokens":26915},
      "model_context_window": 258400
    },
    "rate_limits": {
      "limit_id": "codex", "limit_name": null, "primary": null, "secondary": null,
      "credits": null, "individual_limit": null, "spend_control_reached": null,
      "plan_type": null, "rate_limit_reached_type": null
    }
  }
}
```

`RateLimitSnapshot` 源码字段（比样本更全，缺字段是 `skip_serializing_if` 导致）：`limit_id`、`limit_name`、`normal_model_slug`、`primary`、`secondary`、`credits`、`individual_limit`、`spend_control_reached`、`plan_type`、`rate_limit_reached_type`；`normal_model_slug` 注释：「Normal model metadata for a quota alias; **never a replacement for the request model**」。

### 3.4 ⭐ 去重（必须做，否则严重高估）

**每个 `token_count` 事件都重复携带"从会话开始累计"的 `total_token_usage`。** 直接累加 cumulatives 会成倍高估。

对同一文件实测（11 个 `token_count` 事件）：

| 算法 | 结果 |
| --- | --- |
| Σ `total_token_usage.total_tokens`（**错误**） | 2,174,735 |
| Σ `last_token_usage.total_tokens`（正确增量） | **414,915** |
| 最后一条 `total_token_usage.total_tokens`（正确总量） | **414,915** |

→ 累加 cumulatives **高估 5.24 倍**；而 `Σ last` 与 `final cumulative` **完全相等**（414,915），交叉验证成立。

**推荐规则**：
1. 单会话总量：取该 rollout **最后一条** `token_count` 的 `total_token_usage`（不要 sum）。
2. 按回合/按请求增量：用 `last_token_usage`。
3. 跨会话聚合：`Σ over sessions (final total_token_usage)`。
4. 更严谨的 Cross-check：`Σ last == final total`，不等则说明有截断/丢了事件（本机样本相等，可作为健康校验）。

**补充：`token_usage_record` 是另一条更精确的路径。** 源码注释：「Exact usage and metadata reported by one upstream Responses API completion. **Unlike TokenCountEvent, this is not accumulated, estimated, or replayed.**」结构（`protocol.rs`）：

```rust
pub struct TokenUsageRecord {
    thread_id, turn_id, session_id, root_turn_id, response_id,
    usage: TokenUsage,            // 本次 response
    turn_token_usage: TokenUsage, // 本 turn 累计
    thread_token_usage: TokenUsage, // 本 thread 累计
}
```
本机 153 个 rollout 中只有 3 个文件含该类型（较新特性），**不能作为唯一数据源**，但存在时是最高保真度。

### 3.5 模型归因（model attribution）

优先级从高到低：

1. **`turn_context.payload.model`** — 每回合一个 `turn_context`，实测字段：`turn_id, cwd, workspace_roots, current_date, timezone, approval_policy, approvals_reviewer, sandbox_policy, permission_profile, file_system_sandbox_policy, model, comp_hash, personality, collaboration_mode, multi_agent_version, realtime_active, effort, summary`。**这是按回合归因模型的正确来源。**
2. **`event_msg/thread_settings_applied.payload.thread_settings.model` + `.model_provider_id`** — 线程中途切换模型/provider 时出现（实测样本 `model":"gpt-5.6-terra"`, `model_provider_id":"cc"`）。
3. **`session_meta.payload.model_provider`** — 仅 provider id，**没有 model 字段**（实测 key 列表：`session_id, id, timestamp, cwd, originator, cli_version, source, thread_source, model_provider, base_instructions, dynamic_tools, history_mode, history_base, context_window`）。
4. `world_state.payload.state.collaboration_mode.model` — 冗余，可忽略。

⚠️ `token_count` 本身**不含 model 字段**。必须把它**关联到"最近的 `turn_context`"**（用 `ordinal` 排序，`token_count.ordinal > turn_context.ordinal` 且下一个 `turn_context` 之前）。这是 slug 归因的唯一可靠方式。

⚠️ `world_state` 里 `collaboration_mode.model` 可能与会话实际模型不同（实测出现 `"gpt-6-astra"` 而 `turn_context.model` 是 `gpt-5.6-terra`）→ **不要用 world_state 归因**。

### 3.6 cwd / repo 归因（按项目统计）

从 **`session_meta.payload`** 取：

- `cwd` — 绝对路径；**所有实测样本都有**
- `runtime_workspace_roots` — `Option<Vec<PathBuf>>`，源码注释：「Top-level runtime workspace roots at creation for default environments... **An absent value means unknown; an empty list means no roots.**」
  - ⚠️ 不是每个 session 都有：本次实测的 `exec` 样本有该字段；另一个 rollout 的 `session_meta` key 列表里**没有**它。
- `turn_context.payload.cwd` 与 `.workspace_roots` — 每回合都有，**cwd 可能在会话中途变化**（实测 `workspace_roots` 含两个目录）
- `world_state.payload.state.environments.environments.local.cwd` — 冗余

**repo 归因不在 rollout 文件里**，而在 SQLite：`~/.codex/state_5.sqlite` 的 `threads` / `projects` / `project_roots` / `thread_spawn_edges` 等表（实测 `.tables` 输出）。`rollout/src/metadata.rs` 会写入 `git_sha` / `git_branch` / `git_origin_url`，来源是 `session_meta.git`（`metadata.rs`：`builder.git_sha = git.commit_hash...`）。但**本机实测的 rollout JSON 里没有顶层 `git` 字段**，故 git 信息应视为 SQLite / app-server 侧数据 → 标记 **PARTIALLY VERIFIED**。

实用建议：按项目归因用 `session_meta.cwd`（+`turn_context.cwd` 处理变更为其他目录的回合）比依赖 git 字段稳。

### 3.7 其他目录

| 路径 | 本机实况 | 说明 |
| --- | --- | --- |
| `~/.codex/sessions/YYYY/MM/DD/` | 614 文件，仅 `2026/` | 活动会话 |
| `~/.codex/archived_sessions/` | 365 文件 | 归档；`rollout/src/lib.rs`: `ARCHIVED_SESSIONS_SUBDIR = "archived_sessions"` |
| `~/.codex/history.jsonl` | 35,776 B | 实测行格式 `{"session_id":"...","ts":1789637585,"text":"<用户输入原文>"}`；**含用户 prompt 明文**。文档：`[history] persistence = "none"` 可关，`history.max_bytes` 可限 |
| `~/.codex/log/` | 只有 `codex-login.log`（663 B, 2026-06-17） | 基本不用；`log_dir` 键可重定向 |
| `~/.codex/*.sqlite` | `state_5.sqlite`(59 MB)、`thread_history_1.sqlite`(451 MB)、`logs_2.sqlite`(69 MB)、`memories_1/2`、`goals_1`、`queue_1` | 新的 SQLite 状态层。`logs_2.sqlite` 有 `logs` 表；`thread_history_1.sqlite` 本机 `.tables` 返回空（可能为 WAL/损坏或需 checkpoint，**UNVERIFIED**） |
| `~/.codex/thread-writer-locks/` | 每 thread 一个 `.lock` + `.coordination.lock` | 多进程写同一 rollout 的锁，**外部写入者需注意** |
| `~/.codex/app-server-daemon/` | `daemon.pid`、`daemon.lock`、`daemon.pid.lock`、`app-server-control.sock` | **可探测 Codex 是否在跑**，见 §6 |

### 3.8 `codex exec` vs 交互式：日志差异

**结论：两者都写同一套 `~/.codex/sessions/YYYY/MM/DD/`，路径与格式完全相同；差异只在 `session_meta` 的 `source` / `originator` 字段。**

本机实测枚举（含 `source` / `originator` / `cli_version` / `model_provider`）：

```
source="exec"    originator="codex_exec"        cli=0.162.1        provider=custom
source="cli"     originator="codex-tui"         cli=0.154.0-alpha.6.2  provider=cc
source="vscode"  originator="Codex Desktop"     cli=0.142.5        provider=custom
source={"subagent":{"other":"guardian"}}                originator="Codex Desktop"
source={"subagent":{"thread_spawn":{"parent_thread_id":"...","depth":1,
        "agent_path":"/root/rec_log_001","agent_nickname":"Euler","agent_role":null}}}
```

对应源码 `SessionSource`（`protocol.rs`）：`Cli`、`VSCode`(default)、`Exec`、`Mcp`、`Custom(String)`、`Internal(...)`、`SubAgent(SubAgentSource)`、`Unknown`；`#[serde(other)]` 兜底。所以 **`source` 可能是字符串，也可能是对象** —— 解析器不能假设是 string。

另外两点 CSV 差异：

- **失败的 `codex exec` 仍会写 rollout**（实测 401 失败后仍生成 `rollout-2026-10-28T11-06-13-...jsonl`）。
- `codex exec --ephemeral` **不落盘**：「Use `--ephemeral` when you don't want to persist session rollout files to disk」— `md/non-interactive-mode.md`。若做统计，需注意 ephemeral 会话不可见。
- `codex exec --json` 给的是**独立的事件流**（stdout，JSONL），与 rollout 文件**不是同一套 schema**：`thread.started` / `turn.started` / `item.started` / `item.completed` / `turn.completed` / `turn.failed` / `error`；`turn.completed.usage` = `{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`（无 `total_tokens`、无 `cache_write_input_tokens`）。—— 文档 `md/non-interactive-mode.md` + 本机实测。**若要精确 token，仍推荐读 rollout；`--json` 更适合做实时进度。**

---

## 4. OTel / OpenTelemetry

**结论：当前版本原生支持 `[otel]`，且支持 log / trace / metrics 三类导出。**（此前一些版本只有 log/trace，metrics 是新增的。）

### 4.1 `[otel]` 键全表

源码 `config/src/types.rs` 的 `OtelConfigToml`（`#[schemars(deny_unknown_fields)]`），与 `config.schema.json#/definitions/OtelConfigToml`（`additionalProperties: false`）一致：

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `environment` | string，默认 `"dev"` | 给 trace 打环境标签 |
| `exporter` | `OtelExporterKind`，默认 `"none"` | **log** 导出器 |
| `trace_exporter` | `OtelExporterKind`，默认 `"none"` | trace 导出器 |
| `metrics_exporter` | `OtelExporterKind`，默认 `"statsig"` | metrics 导出器 |
| `log_user_prompt` | bool，默认 false | 记录用户 prompt |
| `log_agent_responses` | bool，默认 false | 记录最终回复文本，≤64 KiB |
| `log_guardian_assessments` | bool，默认 false | 记录 Guardian 评估，≤64 KiB |
| `span_attributes` | map<string,string> | 附加到每个 span |
| `tracestate` | map<string,map<string,string>> | 注入 W3C tracestate 成员 |
| `tool_result` | `ToolResultLogConfig`，默认 `{max_bytes: 2048}` | tool 结果日志字节上限 |

`OtelExporterKind`（serde `rename_all = "kebab-case"`）：

```jsonc
"none" | "statsig"
{ "otlp-http": { "endpoint": "<必填>", "protocol": "<必填>", "headers": {}, "tls": {...} } }
{ "otlp-grpc": { "endpoint": "<必填>", "headers": {}, "tls": {...} } }
```
`tls` 子键：`ca-certificate`、`client-certificate`、`client-private-key`（`config-reference.md`）。

**本机实测**：`--strict-config` 接受以下配置（无 unknown key 报错）：

```toml
[otel]
environment = "staging"
exporter = "none"
metrics_exporter = { otlp-http = { endpoint = "https://otel.example.com/v1/metrics", protocol = "binary" } }
log_user_prompt = false
```

⚠️ 两种写法都可用：文档示例写 `exporter = { otlp-http = {...} }`，`config-sample.md` 示例写 `[otel.exporter."otlp-http"]`（表形式）。**注意表键必须加引号**（`"otlp-http"` 含连字符）。

### 4.2 ⚠️ `[otel]` 在项目级配置里被忽略

`md/config-file_config-advanced.md` 与 `config-reference.md` 均列出：项目本地 `.codex/config.toml` 中的以下键**被忽略并打印启动警告**：

```
openai_base_url, chatgpt_base_url, apps_mcp_product_sku, model_provider,
model_providers, notify, profile, profiles, experimental_realtime_ws_base_url, otel
```

→ **`otel` 与 `model_providers` 一样，只能写在用户级 `~/.codex/config.toml`。** 这条对"扩展写项目配置"的设计是硬约束。

### 4.3 Token 相关 metric（关键）

**`codex.turn.token_usage`（histogram）** — `codex-rs/otel/src/metrics/names.rs`：`TURN_TOKEN_USAGE_METRIC = "codex.turn.token_usage"`。

属性（`core/src/state/turn_token_usage.rs` 逐字）：

```rust
for (token_type, value) in [
    ("total", usage.total_tokens),
    ("input", usage.input_tokens),
    ("cached_input", usage.cached_input()),
    ("cache_write_input", usage.cache_write_input_tokens),
    ("output", usage.output_tokens),
    ("reasoning_output", usage.reasoning_output_tokens),
] {
    telemetry.histogram(TURN_TOKEN_USAGE_METRIC, value.max(0),
        &[("token_type", token_type), tmp_mem]);
}
```
即 `token_type` ∈ `{total, input, cached_input, cache_write_input, output, reasoning_output}`，外加 `tmp_mem_enabled` 标签（文档表格确认：「`turn.token_usage` histogram, fields `token_type`, `tmp_mem_enabled`」— `config-advanced.md`）。

**该 metric 天然按 "producing model" 分组**：`turn_token_usage.rs` 模块注释「Turn token metrics grouped by the model that actually produced each response. Multiple responses from one model contribute a single histogram sample per turn.」→ 省掉了 §3.5 的归因麻烦，**这是 OTel 相对 rollout 解析的最大优势**。

配套：**`codex.turn.cost_microusd`**（`TURN_COST_MICROUSD_METRIC`）。

**默认元数据标签**（文档，每个 metric 都有）：`auth_mode`、`originator`、`session_source`、`model`、`app.version`；`config-advanced.md` 另称「Each metric includes the required fields plus the default context fields」，其中 `auth_mode` ∈ `swic|api|unknown`、`model`、`app.version = Codex 版本`。

⚠️ **注意 Statsig 不接收 token metric**：`otel/src/metrics/config.rs` 的 `STATSIG_DISABLED_METRICS` 明确包含 `TURN_TOKEN_USAGE_METRIC`、`TURN_COST_MICROUSD_METRIC`、`API_CALL_COUNT_METRIC`、`TOOL_CALL_COUNT_METRIC` 等，注释「Metrics intentionally not sent through Codex's built-in Statsig route. Keep this as an exact-name list so **custom OTLP exporters still receive them**.」→ **必须配 `metrics_exporter` 指向自己的 OTLP，才能拿到 token metric。**

⚠️ `analytics.enabled = false` 会连带关掉自定义 OTLP metrics 导出（`config-reference.md`：「In Codex CLI, `analytics.enabled = false` disables this exporter, including custom OTLP exporters」），只有显式 `metrics_exporter = "none"` 才是干净地只关 metrics。

其他相关 metric（`names.rs` 全量前缀 `codex.`）：`api_request`、`api_request.duration_ms`、`sse_event`、`sse_event.duration_ms`、`websocket.request`、`websocket.event`(+`.duration_ms`)、`tool.call`、`tool.call.duration_ms`、`tool.unified_exec`、`conversation.turn.count`、`turn.e2e_duration_ms`、`turn.ttft.duration_ms`、`turn.ttfm.duration_ms`、`turn.tool.call`、`turn.memory`、`turn.network_proxy`、`guardian.review`、`process.start`、`multi_agent.spawn.failure` 等。

选取建议：**若只想要 token 用量，OTel `codex.turn.token_usage` 比解析 rollout 更省事、更准（内部已做 delta 聚合与模型归因）；若需要历史回溯/离线补齐，必须走 rollout 文件（因为 OTel 是 push 且有采样/网络依赖，且默认关闭）。**

---

## 5. Codex VSCode 扩展（本机证据）

路径：`~/.vscode/extensions/openai.chatgpt-26.1021.22027-darwin-arm64/`

### 5.1 `package.json` 关键字段（实测读取）

| 字段 | 值 |
| --- | --- |
| `name` | `chatgpt` |
| `publisher` | `openai` |
| `version` | `26.1021.22027` |
| **扩展 id** | **`openai.chatgpt`**（注意：**不是** `openai.codex`） |
| `engines.vscode` | `^1.96.2` |
| `main` | `./out/extension.js`（2.58 MB 单文件 bundle） |
| `activationEvents` | `["onStartupFinished", "onUri"]` |
| `contributes` 顶层键 | `commands`, `keybindings`, `configuration`, `viewsContainers`, `views`, `customEditors`, `menus`, **`chatSessions`**, `grammars`, `languages` |

### 5.2 `contributes.commands`（10 个，全量）

```
chatgpt.implementTodo          Implement with Codex          [Codex]
chatgpt.openSidebar            Open Codex Sidebar            [Codex]
chatgpt.openCommandMenu        Open Codex Command Menu       [Codex]
chatgpt.newCodexPanel          New Codex Agent               [Codex]
chatgpt.addToThread            Add to Codex Chat             [Codex]
chatgpt.addFileToThread        Add File to Codex Chat        [Codex]
chatgpt.newChat                New Chat in ChatGPT Sidebar   [Codex]
chatgpt.showLspMcpCliArgs      Copy Codex CLI args for LSP MCP [Codex]
chatgpt.dumpNuxState           Debug: print NUX state to console [Codex]
chatgpt.resetNuxState          Debug: reset NUX state        [Codex]
```

### 5.3 `contributes.viewsContainers` / `views`

```json
"viewsContainers": {
  "activitybar": [{"id":"codexViewContainer","title":"Codex","icon":"resources/blossom-white.svg",
                   "when":"chatgpt.doesNotSupportSecondarySidebar"}],
  "secondarySidebar": [{"id":"codexSecondaryViewContainer","title":"Codex", ...,
                        "when":"!chatgpt.doesNotSupportSecondarySidebar"}]
},
"views": {
  "codexViewContainer":        [{"id":"chatgpt.sidebarView","type":"webview","name":"Codex", ...}],
  "codexSecondaryViewContainer":[{"id":"chatgpt.sidebarSecondaryView","type":"webview","name":"Codex", ...}]
}
```

### 5.4 `contributes.configuration`（全部 8 个键，即"claudeCode 类似物"）

扩展**没有** claudeCode 那样的 `selectedModel` / `permissionMode` / `environmentVariables` 之类设置。它的设置面极小，且**绝大多数行为来自 `~/.codex/config.toml`**，不是 VSCode settings。8 个键全量：

| 键 | 类型 / 默认 | 说明（原文摘要） |
| --- | --- | --- |
| `chatgpt.commentCodeLensEnabled` | boolean, `true` | TODO 注释上的 CodeLens |
| `chatgpt.cliExecutable` | `string\|null`, `null`, scope `application`, `restricted` | **「DEVELOPMENT ONLY: Path to the Codex CLI executable. You do NOT need to set this unless you are actively developing the Codex CLI.」** |
| `chatgpt.openOnStartup` | boolean, `false` | 启动时聚焦 sidebar |
| `chatgpt.followUpQueueMode` | `queue\|steer\|interrupt`, `queue` | 后续消息排队/抢断 |
| `chatgpt.composerEnterBehavior` | `enter\|cmdIfMultiline\|cmdAlways`, `enter` | 回车行为 |
| `chatgpt.reviewDelivery` | `inline\|detached`, `inline` | /review 内联还是新开 |
| `chatgpt.localeOverride` | `string\|null`, `null`, scope `application` | UI 语言 |
| `chatgpt.runCodexInWindowsSubsystemForLinux` | boolean, `false` | 仅 Windows |

> ⚠️ `chatgpt.cliExecutable` 虽是"开发用"，但它是**唯一能改 CLI 路径的官方旋钮**。对"外部扩展想接管 CLI 调用"有参考价值：**Codex 官方扩展也是 spawn 子进程，而不是走 LSP/IPC 复用别人的进程。**

### 5.5 是否 spawn CLI —— 是，且是 `app-server` 模式

`out/extension.js` 实测字符串定位到：

```js
this.logger.info("Spawning codex app-server"),
e = dWe(this.extensionUri, [
  "-c","features.code_mode_host=true",
  "-c","features.windows_sandbox_service=true",
  "app-server",
  "--analytics-default-enabled"
])
```
（`dWe` 走 `spawn-codex-process` logger 名，`hv` 是 `CodexProcessError`。）

bundle 内字符串出现次数（实测计数）：`app-server` × 21、`thread/start` × 11、`turn/start` × 8、`resume` × 21、`thread/resume` × 1、`config/batchWrite` × 1、`config/read` × 2、`config/value/write` × 0。→ **扩展通过 app-server 的 JSON-RPC（`thread/*`、`turn/*`）驱动，不是 `codex exec`。** 与 `md/app-server.md` 的方法列表（`config/read`、`config/value/write`、`config/batchWrite`）吻合。

`codex.path` 解析逻辑（bundle 实测）：

```js
function Zt({preferWsl=!1}={}) {
  ...
  return process.env.CODEX_HOME ?? Rwe.join(_we.homedir(), ".codex")
}
```
→ 扩展**尊重 `CODEX_HOME`**，默认 `~/.codex`。WSL 场景会执行 `bash -lc 'printf %s "${CODEX_HOME:-$HOME/.codex}"'` 再 `wslpath -w` 转换。

### 5.6 会话是否落到同一个 `~/.codex/sessions` —— 是

证据链：
1. 扩展用 `CODEX_HOME ?? ~/.codex`（上）。
2. 本机 `session_meta.source == "vscode"` 且 `originator == "Codex Desktop"` 的真实 rollout 存在于 `~/.codex/sessions/`（§3.8 实测枚举）。
3. `SessionSource::VSCode` 被列入 `INTERACTIVE_SESSION_SOURCES`（`rollout/src/lib.rs`：`vec![Cli, VSCode, Custom("atlas"), Custom("chatgpt")]`）。

→ **CLI、IDE 扩展、Desktop app 共用同一 rollout 存储**。对"外部扩展做统一用量统计"是利好：一个目录覆盖全部入口，用 `session_meta.source` 区分来源即可。

### 5.7 自带 CLI 与用户 CLI 是两个二进制

`bin/macos-aarch64/codex-package.json`（实测）：

```json
{"layoutVersion":1,"version":"0.164.0-alpha.11.1","target":"aarch64-apple-darwin",
 "variant":"codex","entrypoint":"bin/codex","resourcesDir":"codex-resources","pathDir":"codex-path"}
```
`./bin/macos-aarch64/codex --version` → `codex-cli 0.164.0-alpha.11.1`（260 MB 静态二进制）。
而 `which codex` → `/opt/homebrew/bin/codex` → `../lib/node_modules/@openai/codex/bin/codex.js`（用户装的 0.164.0）。

⚠️ **扩展默认用自带的 alpha 版**，只有当 `chatgpt.cliExecutable` 被设置时才可能换。这解释了本机 rollout 里 `cli_version` 五花八门（0.142.5 / 0.148.0-alpha.9 / 0.154.0-alpha.6.2 / 0.160.1 / 0.162.1）——**同一份 `~/.codex` 被多个不同版本的 Codex 写过**。统计/解析必须**按 `cli_version` 做兼容分支**。

---

## 6. 外部 VSCode 扩展改写 `~/.codex/config.toml` 的风险清单

### R1. 未知键：**默认忽略 + 警告，不致命**（可被 `--strict-config` 变成致命）

**本机实测**（`/tmp/codextest`，config 含 `this_key_does_not_exist` 与 `model_providers.mine.bogus_provider_key`）：

```
warning: Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.
  user (/private/tmp/codextest/config.toml): `model_providers.mine.bogus_provider_key` is ignored.
  user (/private/tmp/codextest/config.toml): `this_key_does_not_exist` is ignored.
```
退出码 0，**继续运行**（同一警告打印了两次）。

⚠️ 但 `codex exec --strict-config` 会**直接失败**：

```
Error loading config.toml:
/private/tmp/codextest/config.toml:2:1: unknown configuration field `unknown_key_here`
  |
2 | unknown_key_here = true
  | ^^^^^^^^^^^^^^^^
```
退出码 1。CI / 自动化脚本常用 `--strict-config`，所以「写个自定义键挺安全」是错的假设。

⚠️ **取值非法 ≠ 未知键**：`wire_api = "chat"` 会**直接 load 失败**（§2.2），不是 warning。所以写 config 必须区分「未知键（warn）」与「已知键非法值（fatal）」。后者还包括 `[profiles.x]`（§1.3）。

### R2. Codex 会不会自己重写 / 规范化 config.toml（毁注释）？

- **普通启动/运行不会改 `config.toml`。** 本机实测：`codex exec` 多次运行后，`config.toml` 的 md5 与内容（含注释）**逐字节不变**。
- 但 Codex **确实具备**结构化写入能力，且**保留注释**（用 `toml_edit`）：
  - `core/src/config/edit.rs`：`use toml_edit::DocumentMut;`，`use crate::path_utils::write_atomically;`，落盘为 `write_atomically(&write_paths.write_path, &document.doc.to_string())`
  - app-server 暴露 `config/value/write`（单键）与 `config/batchWrite`（批量、带 `expected_version` 乐观锁）
  - `config/src/fingerprint.rs`：`version_for_toml()` → `sha256:<hex>`（对排序后的 JSON 做 SHA-256），供 `expected_version` 冲突检测 → 错误码 `ConfigVersionConflict`
- **结论**：Codex 自身的写路径是"读 DocumentMut → 改 key → 原样 to_string → 原子写"，**注释可保留**；但**这是 Codex 的写路径，不是外部扩展的**。外部扩展若用 `toml` crate 的 `to_string`（而非 `toml_edit`）重写，**会丢掉全部注释与顺序**。
- `merge_strategy` 字段（`ConfigEdit`）支持合并语义；`reload_user_config` 明确不重载 session-static 项（见 R3）。

⚠️ **风险点**：Codex 写 config 时会整文件重写（虽保留注释）。若外部扩展同时持有旧内容做 read-modify-write，会**静默覆盖** Codex 刚写的键。→ **外部扩展应优先用 `toml_edit`，并复用 Codex 的 `expected_version`/sha256 指纹做冲突检测。**

### R3. 热重载：**基本"启动时读一次"，改动需重启或走专用 RPC**

- 源码证据：`codex-rs/config` 内**没有任何 config 文件的 `notify` watcher**（`grep` 了 `notify::`/`RecommendedWatcher`/`watch(`，命中的都是 `exec-server` 与 `file-watcher` crate，与 config 无关）。`config/src/loader/` 只在启动时组装 layer。
- `model_catalog_json` schema 描述直接写明「**applied on startup only**」；per-thread config 覆盖「**do not reapply this (no-ops)**」。
- app-server 有 `ConfigBatchWriteParams.reload_user_config`（默认 false），注释：「When true, hot-reload updated runtime settings into loaded threads after writing. **Session-static model, reasoning-effort, Plan-mode reasoning-effort, and service-tier defaults are not reloaded.** The deprecated personality setting is also not reloaded.」→ 即使热重载，**`model` 与 `model_reasoning_effort` 也不会生效**，必须新开 thread/会话。
- 结论：**改 `model` / `model_providers` / `model_catalog_json` 后，必须重启进程或新开 thread 才生效。** 外部扩展"改完立刻生效"的期望不成立。
- 少数动态项（`otel` 有 `app-server/src/otel_reloader.rs`）例外，但不是我们要改的字段。

### R4. 能否探测 Codex 正在运行：**可以，有稳定文件信号**

实测本机存在（`~/.codex/`）：

| 信号 | 内容 |
| --- | --- |
| `app-server-daemon/daemon.pid` | 478 B（JSON，含 pid） |
| `app-server-daemon/daemon.pid.lock`、`daemon.lock` | 0 B 锁文件 |
| `app-server-control/app-server-control.sock` | 符号链接 → `/private/tmp/codex-daemon-501/<sha256>` |
| `app-server-daemon/daemon-updater.pid` + `.sock` | 更新器进程 |
| `thread-writer-locks/*.lock` | 每 thread 的写锁，含 `.coordination.lock` |
| `~/.codex/*.sqlite-wal`、`-shm` | WAL 活跃度可间接判断 |

源码侧：`app-server-daemon/src/client.rs` 有 `request_shutdown(socket_path, pid)` + **pid 回显校验**（「shutdown acknowledgment did not match the managed process {pid}」）；`app-server-daemon/src/install_lock.rs` 写 `pid` 文件并在目录里校验。
→ **推荐探测法**：读 `app-server-daemon/daemon.pid` 拿 pid，再确认 socket 可达 / `/proc`(或 `kill -0`) 存活。**不要**用"进程名 grep"（本机 `ps` 被沙箱拒绝）。

⚠️ 但注意：`codex exec` 这类**一次性进程不写 daemon.pid**。所以 "agent-server 在跑" ≠ "用户正在某个终端里跑 codex exec"。要更完整需结合 `thread-writer-locks/` 的新鲜度与 `sessions/**` 最新 mtime。

### R5. 备份：**Codex 自己不备份 config.toml**

- 源码与实测均未发现 `config.toml` 的 `.bak` 生成逻辑。
- 本机 `~/.codex/` 里所有 `config.toml.*` 备份（`config.toml.backup-before-custom-provider-20260712110213`、`config.toml.bak-20260712-cc-provider`、`config.toml.bak-fix-cc-*`、`config.toml.bak-merge-cc-*`）**命名风格明显来自 cc-switch，而非 Codex**。
- `backups_state/provider-sync/<timestamp>/` 也是 cc-switch 的产物。
- ⚠️ 唯一的"Codex 自动备份"是 SQLite 损坏重建时的数据库备份（`app-server/src/lib.rs` 提示「The original database files were preserved at the backup locations below」），与 config 无关。
- **结论：外部扩展必须自己做备份 + 原子写（临时文件 + rename）。**

### R6. ⚠️ cc-switch 冲突（本机既有事实）

本机**已经**有一个第三方 provider 切换器在管理这些文件：

| 证据 | 内容 |
| --- | --- |
| `~/.codex/cc.config.toml` | 408 B，`model_provider = "cc"`, `model = "gpt-5.5"`, `model_reasoning_effort = "high"`, `disable_response_storage = true`, `[model_providers.cc]`（`name="AI INPUT"`, `base_url="https://ai.input.im"`, `wire_api="responses"`, `requires_openai_auth=true`, `experimental_bearer_token=<REDACTED>`） |
| `~/.codex/raw.config.toml` / `thirdparty.config.toml` | 各 41 B，`model_provider="raw"`, `model="gpt-5.5"` |
| `~/.codex/cc-switch-model-catalog.json` | 262 KB 模型 catalog，被 `config.toml` 的 `model_catalog_json` 引用 |
| `~/.codex/config.toml.bak-*` 等 6 个 | 时间戳 2026-07-11/12，命名含 `cc` |
| `~/.codex/backups_state/provider-sync/` | 3 个时间戳目录 |
| `config.toml` 当前内容 | `model_provider = "custom"`，`base_url = "https://anyrouter.top/v1"`，即 cc-switch 最近一次切换的产物（对比 `config.toml.backup-before-custom-provider-20260712110213` 里还是 `model_provider = "cc"` + `disable_response_storage = true` + `sandbox_mode = "danger-full-access"`） |

**冲突评估**：

1. **写入竞态（最严重）**：cc-switch 显然做**整文件替换或大段重写**（否则不会留下 6 个不同阶段的 `.bak`）。外部扩展若同时做 read-modify-write，**必然互相覆盖**。且两边都无文件锁 → 无法靠锁规避。缓解：改前读 mtime+hash，写前复核，冲突则放弃并提示用户。
2. **`cc.config.toml` 已经用了 `disable_response_storage = true`——该键在当前 schema 中已不存在**。`codex-rs/core/config.schema.json` 的 `properties` 里搜 `disable_response_storage` 为 **false**，源码 grep 也零命中。所以：**任何把 `cc.config.toml` 内容合并进 `config.toml` 的行为，都会引入一个 deprecated 未知键（触发 R1 警告；`--strict-config` 下直接失败）。** 这是 cc-switch 与 0.164 已经存在的潜在不兼容，外部扩展不应"顺手帮它保留"。
3. **`model_catalog_json` 是相对路径**（`"cc-switch-model-catalog.json"`），依赖按 `CODEX_HOME` 解析。若外部扩展按"相对 cwd"理解或移动该文件，**catalog 直接加载失败 → fallback metadata → 压缩错误**（§2.7 路径 C）。这是**最隐蔽但后果最严重**的冲突面。
4. **语义冲突**：cc-switch 拥有 `model_provider` / `model` / `model_providers.*` / `model_catalog_json` 的所有权。外部扩展若要写同类键，等于**两个工具抢同一组键**。建议外部扩展**只写互不重叠的键**（例如只用 `[otel]` + `model_context_window` 之外的独立 section），或在 UI 上明示"provider 由 cc-switch 管理"。
5. **备份互相污染**：外部扩展若也用 `config.toml.bak-*` 命名，会与 cc-switch 的命名混淆，且 `~/.codex` 已积累 6 个历史备份。建议用独立命名空间（如 `config.toml.dsh-backup-<ts>`）。

### R7. 其他需注意的点

- **`[otel]` 与 `model_providers` 不可写项目级**（§4.2）→ 若扩展想"per-project 设 provider"，**做不到**。
- **`~/.codex` 权限**：`config.toml` 是 `-rw-------`（0600），目录 `drwxr-xr-x`。外部写入需保持 0600，否则 Codex 可能拒绝（**未实测**，标记 UNVERIFIED）。
- **文件锁**：`thread-writer-locks/*.lock` 是 **rollout 写锁**，与 config 无关；不存在 config 锁。
- **多版本混写**：同一 `~/.codex` 被 0.142.5 ~ 0.164.0-alpha 多个版本写过（§5.7）。新键（如 `model_catalog_url`、`capabilities.remote_compaction`）在旧版本上是 unknown key → 若用户在旧版 CLI 与新版扩展间切换，**同一份 config 会时而警告时而正常**。外部扩展写入时应按**检测到的最低 cli_version** 收敛特性面。

---

## 7. 对方案的 5 条硬约束（浓缩）

1. **`wire_api` 只能是 `"responses"`**；`"chat"` 是 fatal 错误，不是 deprecated。任何 Chat-Completions-only 中转在 0.164 不可用。
2. **自定义模型必须有 catalog entry 或 `model_context_window`**，否则 fallback metadata → 压缩阈值失真。catalog 用 `model_catalog_json`（启动时一次性加载、本地优先于远端、必须非空且 slug 唯一）。
3. **token 统计读 `last_token_usage` 或"每会话最后一条 cumulative"**，绝不 sum cumulatives（实测高估 5.24×）。模型归因靠 `turn_context.model`（`token_count` 无 model 字段）。
4. **`.jsonl` 与 `.jsonl.zst` 必须都支持**（压缩是 >7 天的后台任务，不是默认格式）。`session_meta.source` 可能是 string 或 object。
5. **配置写入要防三件事**：未知键 warn（`--strict-config` 下 fatal）、非法值 fatal（`wire_api`/`[profiles.x]`）、与 cc-switch 的整文件重写竞态（无锁，须 mtime+hash 复核 + 原子写 + 自建备份 + `toml_edit` 保注释）。

---

## 8. UNVERIFIED / 待确认清单

| # | 项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | `model_catalog_json` 相对路径按 `CODEX_HOME` 解析 | **PARTIALLY VERIFIED** | schema 声明 `AbsolutePathBuf`，但本机用相对路径且实测可加载（复制 catalog 进临时 CODEX_HOME 即成功）。上游文档未明说解析基准。 |
| 2 | rollout 里 `git_sha` / `git_branch` / `git_origin_url` | **PARTIALLY VERIFIED** | `rollout/src/metadata.rs` 从 `session_meta.git` 读取并写入 SQLite，但本机 rollout JSON 未见顶层 `git` 字段；git 归因应以 `state_5.sqlite` 为准。 |
| 3 | `thread_history_1.sqlite` 表结构 | **UNVERIFIED** | 本机 `sqlite3 .tables` 返回空（451 MB 文件），可能需 WAL checkpoint 或文件被占用。 |
| 4 | `~/.codex` 文件权限（0600）是否被 Codex 强制校验 | **UNVERIFIED** | 未做破坏性测试（任务禁止修改 `~/.codex`）。 |
| 5 | OTel `protocol` 合法枚举值 | **VERIFIED：仅 `binary` \| `json`** | `config/src/types.rs` 与 `otel/src/config.rs` 的 `OtelHttpProtocol` 均为 `Binary`/`Json` 两个变体，serde `rename_all="kebab-case"` → `"binary"`、`"json"`。不存在 `"grpc"`（gRPC 走 `otlp-grpc` 变体，无 `protocol` 字段）。 |
| 6 | 是否能用 `-c` 覆盖 `model_providers.<id>.*` 的嵌套键 | **UNVERIFIED** | 只验证了 `-c 'model_providers.mine.name="X"'` 被接受（未验证其生效结果，因为需要可用 provider）。 |
| 7 | `codex exec --json` 的 `turn.completed.usage` 是否含 `cache_write_input_tokens` | **VERIFIED 为「不含」** | 文档 + 实测样本均只有 4 个字段；但这与 rollout 的 6 字段不一致，需在方案里显式分支。 |
| 8 | 0.164 与 0.160 之间 `model_providers` 字段的增删 | **UNVERIFIED** | 只核对了 `main` 分支源码（≈0.164）与本机二进制行为，未逐版本 diff。 |

---

## 附：本次实测命令（可复现，均未改动 `~/.codex`）

```bash
# 1) 取上游源码（codeload 可通；github.com/api.github.com 返回 000）
curl -sL --retry 3 --retry-all-errors \
  "https://codeload.github.com/openai/codex/tar.gz/refs/heads/main" -o codex-main.tar.gz
mkdir -p src && tar xzf codex-main.tar.gz -C src --strip-components=1

# 2) 官方文档（注意：是 learn.chatgpt.com，不是 github docs/）
curl -sL "https://learn.chatgpt.com/docs/config-file/config-reference.md"

# 3) 未知键 / strict-config 实测
CODEX_HOME=/tmp/codextest codex exec --skip-git-repo-check "echo hi"          # warning, exit 0
CODEX_HOME=/tmp/codextest codex exec --skip-git-repo-check --strict-config "echo hi"  # exit 1

# 4) wire_api=chat 实测 → fatal
# 5) 读 rollout（同时支持 .jsonl 与 .jsonl.zst）
node -e 'const z=require("zlib");process.stdout.write(z.zstdDecompressSync(require("fs").readFileSync(process.argv[1])).toString())' <file>.jsonl.zst
```
