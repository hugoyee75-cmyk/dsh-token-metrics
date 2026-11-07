# VSCode 插件需求梳理 — dsh-token-metrics

> 起草：2026-10-28。基于 `docs/research/vscode-plugin-research.md` 的实测结论。
> 目标：把现有 DSH 插件（Host + Web Client）的核心能力复刻到 VSCode，并新增「把插件管理的供应商写进 Codex / Claude 配置文件」的接入能力。
> 状态标记：**[已定] `[待定]` [建议]** —— `[已定]` 来自本次对话的明确决策，`[待定]` 需要你拍板。

---

## 1. 一句话需求

**在 VSCode 里做一个「AI 编程代理用量控制台」**：统一统计 **DSH / Claude Code / Codex** 三家的 Token 用量与成本，并且能把插件里维护的 LLM 供应商**一键写进 `~/.codex/config.toml` 与 `~/.claude/settings.json`**（可回滚），让这三家都走你指定的中转站。

---

## 2. 已确认的四项决策 [已定]

| 决策点 | 结论 |
| --- | --- |
| 数据源 | **直读落盘数据**（`~/.dsh` 账本 + 会话日志、`~/.codex/sessions`、`~/.claude/projects`），DSH HTTP 接口只作为可选加速路径 |
| 「接入」的含义 | **接入插件管理的供应商**：把供应商的 `baseURL + 协议 + 模型` 写入 Codex/Claude 配置文件，让它们直连中转站 |
| 代码位置 | **本仓库新增 `vscode/` 子包**，与 Host/Client 共享 `src/` 的计算逻辑 |
| 发布范围 | **VSCode + Cursor/Windsurf**（同时上 Marketplace 与 Open VSX） |

---

## 3. 用户故事

| # | 角色 | 故事 | 验收 |
| --- | --- | --- | --- |
| U1 | 重度 AI 编程用户 | 我想在 VSCode 里一眼看到今天/本周花了多少钱、用了多少 token，不用切回 DSH 窗口 | 状态栏常驻 + 侧边栏/面板看板，打开即出数 |
| U2 | 同上 | 我想知道这些钱花在哪个工具（DSH/Claude/Codex）、哪个模型、哪个项目、哪个中转站 | 看板可按来源/模型/项目/供应商拆分 |
| U3 | 多供应商用户 | 我想在插件里维护一批中转站（地址/模型/余额），然后让 Codex 和 Claude 都指向其中某一个 | 一键写入 + 生效验证 + 一键回滚 |
| U4 | 谨慎的用户 | 我担心插件改坏了我的 `~/.claude/settings.json`（我还在用 cc-switch） | 写入前快照、冲突检测、单键回滚、永不整文件覆盖 |
| U5 | 成本敏感用户 | 我想在余额低于阈值/配额将尽时收到提醒 | VSCode 通知 + 状态栏变色 |
| U6 | 多项目用户 | 我想按项目看用量，而不只是总量 | 按会话 `cwd` 归组 |
| U7 | 新装用户 | 我装完插件就想看到历史数据，而不是从今天开始记 | 首次启动全量回扫，带进度提示 |

---

## 4. 功能需求（分 P 级）

### P0 — 必须有（MVP，缺一不可）

**F1. 三源采集与统一口径**
- F1.1 DSH：读 `$DSH_HOME/token-metrics/usage.json` 账本（增量）+ 回扫 `sessions/**/session.v4.jsonl.zstd`。
- F1.2 Codex：解析 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`（**两种后缀都要支持**：7 天内未压缩、7 天外被后台压缩），**累加 `last_token_usage`**（等价于末条 `total_token_usage`，可交叉校验），模型取 `turn_context.payload.model`，项目取 `session_meta.payload.cwd`，来源取 `originator`。
- F1.3 Claude：解析 `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl`，**按 `message.id` 去重**（`stop_reason` 非空者优先，否则取最大 usage），跳过 `<synthetic>`，模型取 **`message.model`（记录级没有 model 字段）**，项目取记录级 `cwd`（**不可反解目录 slug**，CJK 会坍缩成 `-`）。
  缓存写入只认 `cache_creation_input_tokens`；扁平的 `claude_cache_creation_5_m_tokens`/`_1_h_tokens` 实测 29 条存在但**值为 0**，属历史残留，不要用。
- F1.4 统一事件模型与统一去重键，保证「增量」与「全量回扫」幂等、不重复。
- F1.5 成本核算复用 `src/pricing.js`（峰谷计价、缓存读写倍率、汇率、自定义倍率），**不依赖各工具自报的 cost 字段**。

**F2. 看板（Webview）**
- F2.1 九项总计：input / output / cacheRead / cacheWrite / reasoning / total / 调用次数 / 缓存命中率 / 平均首字延迟（TTFT 仅 DSH 有，其余显示 N/A）。
- F2.2 时间范围：今日 / 近 7 天 / 全部；趋势粒度自适应（今日按小时、7 天按天、全部按月）。
- F2.3 明细表标签页：按来源（DSH/Claude/Codex）→ 模型 / 项目 / 供应商 / 日期。
- F2.4 模型筛选下拉（多选）、总成本卡片、货币切换（USD/CNY）。

**F3. 状态栏**
- F3.1 常驻文本：`今日 $1.23 · 1.2M tok`（可配置模板）。
- F3.2 点击打开看板；成本超预算时变色。

**F4. 供应商管理与接入（核心增量）**
- F4.1 供应商 CRUD（地址、协议、模型、Key 引用），复用 `src/providers.js` 的 34 个预设与 `src/balance.js` 的余额探测。
- F4.2 **Codex 接入**：生成/更新 `[model_providers.<id>]`（`base_url`、`env_key`、`wire_api="responses"`）、顶层 `model_provider`/`model`/`model_context_window`/`model_catalog_json`。
- F4.3 **Claude 接入**：写 `settings.json` 的 `env` 白名单键（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 或 `apiKeyHelper`、`ANTHROPIC_DEFAULT_*_MODEL`），可选写 `modelPicker`。
- F4.4 **安全写入**：局部命名空间 + JSON 快照 + 指纹冲突检测 + 原子写（临时文件 + rename）+ 一键回滚。
- F4.5 **协议可用性预检**：接入 Codex 前探测目标站 `/v1/responses` 是否可用；不支持则明确拒绝并说明原因。
  > 已实测可行的判据：对该站 `POST {baseUrl}/v1/responses`（空 JSON body）。**401/400 = 端点存在**（需鉴权/参数不全）；**404 = 该站不支持 responses 协议**，Codex 无法接入。本机「佬有公益」实测返回 **401**，说明预检能正确区分。

**F5. 配置与安全**
- F5.1 密钥只存 `context.secrets`（系统钥匙串），永不写入 settings/日志/统计文件。
- F5.2 所有路径可覆盖（`dshHome` / `codexHome` / `claudeConfigDir`）。
- F5.3 首次运行引导 + 权限说明（会读哪些目录、会写哪两个文件）。

### P1 — 应该有

- F6. 余额与配额页（复用 `balance.js`）：余额型显示金额，订阅型显示窗口剩余% + 重置倒计时。
- F7. 告警：余额低 / 配额将尽 / 配额即将重置，走 VSCode 原生通知，带冷却与去重（复用 `push.js` 的三层去重思路）。
- F8. 预算（日/月），超限状态栏变色 + 通知。
- F9. 会话明细（可选开启），支持跳转到源日志文件。
- F10. 数据导出 CSV / JSON。
- F11. 多语言（中/英），跟随 VSCode `displayLanguage`。

### P2 — 可以有

- F12. 「用插件配置的供应商启动 Claude/Codex」终端 profile（`TerminalProfileProvider`），启动即注入 env，避免污染全局配置。
- F13. Claude statusLine 注入（实时用量回传到插件），需冲突检测（用户可能已有 statusLine）。
- F14. OTel 接收端（本地 OTLP listener），作为实时数据补充源。
- F15. 按账号/组织归属（从 OTel 属性或日志推断）。
- F16. 把供应商暴露给 Copilot Chat（`lm.registerLanguageModelChatProvider`，成本信息需 proposed API，发布版受限）。

### 明确不做（Out of Scope）

- ❌ **统计 GitHub Copilot 的用量**：VSCode 无任何 API 暴露其他工具的 token 消耗（已证实）。
- ❌ **Web 版 VSCode（vscode.dev）**：无 `fs` / `node:zlib`，本项目依赖本地文件。
- ❌ **插件自更新/热重载**：VSCode 扩展不支持（与 DSH 插件不同，`updater.js`/`reload.js` 不搬）。
- ❌ 代理转发（不做网关；接入是「写配置」，不是「当代理」）。
- ❌ 修改 managed settings / MDM。

---

## 5. 技术方案要点

### 5.1 架构

```
vscode/
  src/
    extension.ts          # activate：注册命令、状态栏、webview、watcher
    sources/
      dshLedger.ts        # 读 usage.json（增量）
      dshLogs.ts          # 回扫 sessions/**/*.jsonl.zstd（zstd）
      codexLogs.ts        # 解析 rollout-*.jsonl.zst（last_token_usage）
      claudeLogs.ts       # 解析 projects/**/*.jsonl（message.id 去重）
    core/                 # 与 VSCode 解耦的纯逻辑
      events.ts           # 统一事件模型 + 去重键
      aggregate.ts        # 分桶聚合（byDay/byModel/byProject/bySource）
      cost.ts             # 适配层，桥接仓库根 src/pricing.js
      providers.ts        # 桥接 src/providers.js
      balance.ts          # 桥接 src/balance.js
    inject/
      codexConfig.ts      # TOML 局部读写（含注释保留策略）
      claudeSettings.ts   # JSON 局部读写（严格 JSON、原子写）
      backup.ts           # 快照/回滚/指纹
    ui/
      statusBar.ts
      dashboard.ts        # Webview 宿主侧
      treeView.ts
  webview/                # React 前端（esbuild → 单文件）
  package.json
```

**分层原则**：`core/` 与 `sources/` **不得 import `vscode`**，这样可以在纯 Node 下跑单测（这是现有仓库测试策略的延续，也是 VSCode 插件最容易做坏的地方）。

### 5.2 关键实现约束（全部来自调研实测）

| 约束 | 实现要求 |
| --- | --- |
| Codex `wire_api=chat` 是 **fatal**（源码枚举只剩 `responses`） | 生成配置时固定 `responses`；接入前预检；绝不为兼容旧站写 `chat` |
| Codex token 是累计+增量 | **只累加 `last_token_usage`**；实测 Σlast == 末条 total，可作健康校验（直接累加累计值会高估 5.24×） |
| Codex rollout 后缀不固定 | `.jsonl` 与 `.jsonl.zst` 都要解析（7 天为压缩分界） |
| Codex 无 config watcher | 改 `model`/`model_providers` 后必须重启或新开 thread |
| Claude 日志有重复 | 按 `message.id` 去重；`stop_reason` 优先 |
| Claude settings 严格 JSON + 热重载 | 原子写 + 写入前校验；坏 JSON 会让 Claude 报 Settings Error |
| 两文件已被 cc-switch 接管 | 只写自己的键；快照 + 指纹 + 回滚 |
| 大文件（302 MB） | 流式/分块 + worker_threads；首屏先聚合后明细 |
| 工作区外监听 | `RelativePattern(Uri.file(...), '**/*.jsonl')`；保留低频兜底扫描 |
| 远程窗口 | `extensionKind: ["ui"]` + 检测 `env.remoteName` 并提示 |

### 5.3 数据流

```
启动 → 读位点(globalState) → 增量解析各源 → 写入自有缓存(SQLite/JSON)
     → 聚合 → 状态栏 + Webview(push 聚合结果)
     → FileSystemWatcher 监听三源 → 增量 → 防抖 → 聚合 → 刷新 UI
```

**建议用 `context.globalStorageUri` 下的 SQLite（Node 22+ 内置 `node:sqlite`）**存事件，而不是 JSON：
本机实测 `node:sqlite` 可用，且 Codex 单文件就 302 MB，JSON 全量重写不可行。DSH 现有 `usage.json` 924 KB 属于「已聚合」形态，可作为增量来源直接读。

---

## 6. 非功能需求

| 项 | 要求 |
| --- | --- |
| 启动开销 | 激活 ≤ 200 ms 内出状态栏数字（允许先用缓存，后台再扫） |
| 内存 | 常驻 ≤ 150 MB；单次解析大文件不超 300 MB 峰值 |
| 增量延迟 | 日志新增到 UI 更新 ≤ 5 s（防抖 1–2 s） |
| 幂等 | 全量重扫与增量结果一致（按统一去重键） |
| 跨平台 | macOS / Windows / Linux（`node:path`，不调 shell；`rename` 重试处理 Windows 文件锁） |
| 可观测 | 自有 OutputChannel 记录扫描/接入/回滚操作 |
| 隐私 | 不读取对话内容用于统计；只在解析时读取 usage/model/cwd 字段 |

---

## 7. 里程碑

| 阶段 | 内容 | 出口标准 |
| --- | --- | --- |
| **M0 骨架**（1–2 天） | `vscode/` 子包、esbuild、F5 扩展可安装、状态栏出假数据 | F5 调试可跑起来，`vsce package` 通过 |
| **M1 采集**（3–5 天） | F1 三源解析 + 去重 + 聚合；纯 Node 单测对齐 DSH 现有口径 | 三源解析结果与「手工核对」一致；DSH 侧总量与现有看板差 ≤ 0.1% |
| **M2 看板**（3–5 天） | F2 + F3：React Webview、图表、筛选、状态栏真实数据 | 今日/7天/全部与 DSH 页面数字对上 |
| **M3 接入**（4–6 天） | F4：供应商 CRUD、Codex/Claude 写入、快照回滚、协议预检 | 在真实 cc-switch 环境下写入后可回滚；Codex/Claude 能连上 |
| **M4 打磨**（3–4 天） | F6–F11：余额、告警、预算、i18n、导出 | 内部试用无阻断问题 |
| **M5 发布** | 图标、README、CHANGELOG、Marketplace + Open VSX | 两端可安装并激活 |

**关键路径**：M1（口径对齐）→ M3（写入安全）。这两个决定项目成败，M2 是体力活。

---

## 8. 验收口径（可测）

1. **一致性**：DSH 源单独统计时，与现有 DSH 看板「今日/7天/全部」的 totals 偏差 < 0.1%。
2. **幂等**：连续全量重建 3 次，结果完全一致。
3. **去重**：Claude 源在含重复记录的样本上，calls 数等于唯一 `message.id` 数（本机样本应为 478，跳过 synthetic）。
4. **Codex 口径**：单会话累加 `last_token_usage` 的 total 等于末条 `total_token_usage.total_tokens`。
5. **写入安全**：写入后再回滚，文件与写入前**逐字节一致**（或用 JSON 语义等价 + 保留原键顺序）。
6. **冲突检测**：模拟外部改动文件后，插件拒绝覆盖并提示。
7. **性能**：57 MB DSH 日志 + 18 MB Claude 日志 + 最大 Codex 样本，冷启动全扫 ≤ 10 s（后台）。

---

## 9. 需要你拍板的事项 [待定]

| # | 问题 | 选项 / 建议 |
| --- | --- | --- |
| D1 | **Claude 密钥怎么放**：`env` 里明文 `ANTHROPIC_AUTH_TOKEN`，还是走 `apiKeyHelper` 脚本读 `context.secrets`？ | 建议 **`apiKeyHelper`**（不落明文）；但脚本路径与执行权限需处理 |
| D2 | **接入的粒度**：只允许「一站点全局生效」，还是支持按项目？ | 建议 v1 只做全局，按项目留到 P1 |
| D3 | **是否做「终端 profile 启动」**（F12）：不改全局配置，只在启动时注入 env | 建议做，和 F4 互补，能绕开 cc-switch 冲突 |
| D4 | **看板形态**：侧边栏 Webview、编辑器 Tab Webview，还是两者都做？ | 建议 **两者都做**（侧边栏给概览，Tab 给大图表） |
| D5 | **统计范围**是否包含历史全量？本机 DSH 有 11724 次调用 / 35.9 亿 token | 建议保留全量，但 UI 默认显示近 7 天 |
| D6 | **发布主体**：Marketplace publisher 与 Open VSX 命名空间由谁注册？ | 需要你提供账号或授权 |
| D7 | **是否复用 DSH 的 `usage.json` 作为一级来源**（省一次全量回扫），还是只当作校验？ | 建议作为增量来源，但仍能独立回扫（DSH 未装也能用） |

---

## 10. 与现有 DSH 插件的关系

| 维度 | DSH 插件（现状） | VSCode 插件（新增） |
| --- | --- | --- |
| 运行环境 | Electron 宿主进程 | VSCode 扩展宿主（Node） |
| UI | Web Client（8674 行） | Webview（React，重写） |
| 数据 | 自己的 `usage.json` + 会话日志 | 三源日志（含 DSH） |
| 配置写入 | 写 DSH 的 `llm-pi-ai` provider | 写 Codex / Claude 的配置文件 |
| 共享 | **`src/pricing.js` / `src/providers.js` / `src/balance.js`** | 同一份代码 |
| 生命周期 | 有热重载与自更新 | 无（依赖 Marketplace） |

**建议**：把 `pricing/providers/balance` 三个模块抽成 `shared/`（或直接在 `vscode/` 里 `import ../src/xxx.js`），并用现有 `test/pricing-test.mjs` 等单测同时保护两端，防止口径漂移。
