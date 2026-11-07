# DSH Git 工具插件 — 调研结论

> 调研时间：2026-10-22。对象：本机正在运行的 DSH 桌面端（`@deepseek-ai/dsh` **0.2.1-rc.2**，Electron，Web GUI `http://127.0.0.1:58473`）。
> 依据：从 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 解出的真实前端产物 + 已发布的第三方 Git 插件源码。不是凭印象。

## 1. 结论先行

1. **DSH 官方没有 Git 功能**。全部 `@deepseek-ai/*` 包里与 git 相关的只有：`dsh-host-open-in-app` 的「用外部 Git 客户端打开」目录项（GitHub Desktop / GitKraken / gitbash），以及 `dsh-tool-worktree` 这类工作树工具。没有任何变更统计 / 提交 / 分支 / 图谱能力。
2. **社区已经有 7 个 Git 插件**（见 §6），其中 `dsh-git-idea` 与用户截图里的 zcode 卡片形态最接近，`@xbzbing/dsh-git-panel` 功能最全。**但没有任何一个做成用户要的「右上角常驻徽标 + 点击展开卡片 + 收起只剩 +/−」**。
3. **技术上完全可行**，且现有 `dsh-token-metrics` 仓库已经踩平了全部基础设施（Host 路由、Client slot、locale、热重载、测试脚手架）。**建议在本仓库内新增，而不是从零起一个新仓库**（理由见 §7）。

## 2. 运行时真实版本与关键差异（重要）

| 项 | npx 缓存里的 `~/.npm/_npx/.../@deepseek-ai` | 桌面端真实运行 |
|---|---|---|
| 版本 | 0.1.5-rc.1 | **0.2.1-rc.2** |
| slot 数量 | 约 60 | **100** |

**一切以 0.2.1-rc.2 为准。** 两者 slot 名单有增删，若照 0.1.5 写会注册到不存在的 seat 上（静默不渲染）。

## 3. Client 侧：徽标该放哪

### 3.1 候选 seat（0.2.1 实测）

| slot | kind | scope | 说明 | 结论 |
|---|---|---|---|---|
| `conversation.session.header.utilities` | list | session | 会话头部右对齐工具区，`display:flex; gap:8px; margin-left:20px`。现有占用者：open-in-app / schedule-catalog / session-log-download | **✅ 徽标首选**。就是截图里 zcode 的位置语义 |
| `conversation.session.header.corner` | single | session | 头部最右角，`margin-left:auto`。已被 `sidebar-right` 的 ExpandButton 独占 | ❌ 会顶掉右栏展开按钮 |
| `conversation.header.leading` | single | root | 会话标题之前的全局导航区，**无会话时也在** | ⚠️ 备选（跨会话常驻），但语义是"导航" |
| `shell.overlay` | list | root | 框架级浮动层，`z-index:20`，**整层 pointer-events:none，子元素自动 auto**，位置 absolute inset:0 | **✅ 展开卡片首选**。popover/弹窗都该放这 |
| `conversation.input.left` | list | session | 输入框工具行左侧 | 备选（`dsh-git-idea` 就放这） |
| `conversation.input.overlay` | list | session | 输入框浮层 | 备选 |
| `sidebar.panellist` | list | root | 侧边栏面板图标（现有插件已在用） | 用于"完整面板"形态 |
| `settings.section` | list | root | 设置页一节 | 用于设置项 |

### 3.2 推荐落点（对齐截图）

```
conversation.session.header.utilities  ← 徽标（收/展两种形态）
        │ 点击展开
        ▼
shell.overlay                          ← 卡片本体（绝对定位锚在徽标下方）
        │ 点「Git 图谱」
        ▼
shell.overlay                          ← 图谱弹窗（Modal）
```

- **收起态**：徽标只显示 `+3365 −38`（绿/红），无改动时显示分支名或「干净」。
- **展开态**：卡片 = 标题行（`Git 工具` + `⋯` 菜单 + 收起按钮）+ 更改行 + 分支下拉行 + 「提交或推送」按钮。**与截图逐像素同构**。
- 展开状态记在 `localStorage`，跨会话保持。
- `shell.overlay` 是 root 级、无 session 绑定，所以 **sessionId / 仓库路径必须由徽标（session 级）经共享 store 传给卡片**——`@happyqu/dsh-plugin-git` 的源码里明确记录了这个坑（见其 `sessionId` 字段注释）。

### 3.3 可复用的官方 UI（第三方插件确实能 require）

`window.__ModuleLoader__` 的 seed 模块（0.2.1 实测 `SZ()` 返回值）**只有这 10 个**：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, zod, @tanstack/react-virtual,
@deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

`dsh-client-ui-primitives` 导出 288 个符号，与本需求相关的高价值项：

| 导出 | 签名要点 |
|---|---|
| `Menu` | `{open, anchor, items, onSelect, onClose, align, side, portal, dense, compact, footer, ...}` |
| `MenuItemButton` | `{children, shortcut, icon, disabled, danger, separatorBefore, onSelect}` |
| `MenuSurface` / `MenuGroup` | 菜单容器与分组 |
| `Modal` | `{open, onClose, title, closeLabel, description, children, footer, headless, backdropBlur, shortcutModal}` |
| `Tooltip` | `{label, side, delayMs, disabled, children}` |
| `HoverCard` / `HoverCardGroup` | 悬停卡 |
| `Pill` / `Button` / `Switch` / `SegmentedControl` / `Input` / `Checkbox` | 基础控件 |
| `DiffBlock` / `diffTotals` / `FileTypeIcon` / `classifyFileType` | **差异渲染与文件类型图标现成** |
| `useAnchoredPosition` | `{open, anchorRef, panelRef, side, align, gap, margin}` → 定位 popover |
| `useDismissOnOutsidePointer` | `(ref, open, onClose, extraRef)` 点外关闭 |
| `useModalLayer` / `closeTopModal` | 模态层管理 |
| `useAnchoredMaxHeight` / `useCodeHighlighter` / `writeClipboard` / `relativeTime` / `fileSizeText` | 杂项 |
| `IconBranchOutlineRegular` / `IconCheckOutlineRegular` / `IconChevronDownOutlineRegular` / `IconEllipsisOutlineRegular` 等 | **图标齐全**，含 Branch / Chevron / Ellipsis / Check / Warning / Refresh / Folder / Code |

> 这是本次调研最有价值的发现：**不用自己画图标、不用自己实现 diff 渲染与 popover 定位**，直接 `require('@deepseek-ai/dsh-client-ui-primitives')` 即可。前提是在 `package.json` 的 `dsh.client.inject` 里声明它（`dsh-git-panel` 就是这么干的）。

### 3.4 Client 模块加载契约

- `window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 里 **同步 require**，只能命中 seed 或已注册的包。
- 手写 bundle、无构建步骤完全可行（现有 `client.js` 8174 行就是手写的）。
- `require('@deepseek-ai/dsh-client-ui-primitives')` 能拿到上面那套组件——**这是官方支持的第三方扩展点**（`dsh-git-panel` 10 处、`dsh-git-idea` 0 处各自验证了两个方向）。

## 4. Host 侧：怎么执行 git

### 4.1 仓库定位（安全关键）

三条路径，推荐第 1 条：

1. **客户端只传 sessionId**（不传路径）→ Host 用 `ctx.get('sessions').get(sessionId)?.header?.cwd` 解析；解析不到再退 `ctx.get('sessionPersistence').stat(id)` 读持久化会话头。**这是 `dsh-git-panel`、`dsh-git-idea`、`dsh-git-badge` 三家一致的做法**，也是唯一没有路径穿越风险的做法。
2. 客户端传 workspaceId → Host 用 workspace 服务解析成路径。
3. 客户端传绝对路径 → 必须自己做 realpath 包含性校验，且要防「任意目录执行命令」。**不推荐**。

`SessionSummary` / `SessionHeader` 里字段名就是 **`cwd`**（`dsh-api-session-controller` 类型确认）。0.2.1 起另有 `workingDirectory` 投影表示"会话现在实际在哪"（工作树场景），优先读投影，退化到 `cwd`。

### 4.2 命令执行

- 正规通道：`ctx.get('subprocess').spawn({ argv, cwd, env, stdio:{...}, graceMs, signal })`，**argv 数组，绝不拼 shell 字符串**。
- `dsh-git-panel` 的 `createGitRunner` 是可直接抄的范本：超时（AbortController）+ 输出上限（collect.maxBytes + spill）+ `GIT_TERMINAL_PROMPT=0`（防止 fetch/pull 卡在凭据提示）+ stdout 溢出时从 spill 文件回读。
- 直接 `node:child_process` 也能跑（Host 进程内），但会绕过 DSH 的沙箱与超时治理；**用 subprocess 服务**。
- `inject: ['shell']` 或 `ctx.get('subprocess')`：`dsh-git-idea` 选了声明 `shell`（因为它的执行器依赖 subprocess+sandbox 就绪），`dsh-git-panel` 选了 `inject: ['subprocess','sessions','sessionPersistence']`。**推荐后者**（声明式等待，不会拿到 undefined）。

### 4.3 HTTP 路由

两种：

- `ctx.inject(['webServer'], scope => scope.webServer.register({ kind:'exact'|'prefix', path, handler }))` — 现有 `dsh-token-metrics` 与 `dsh-git-idea` 都用这个。
- **官方鉴权门**：`ctx.get('connection').requestRejection(request)` — 复用 `/api` 同一条 Host/Origin 围栏 + 浏览器会话认证。**这是 0.2.1 的正确做法**，比自己手写 loopback 检查更可靠（`dsh-git-idea` 的注释明确记录：桌面端由 Electron 主进程代理请求，会删掉 origin，手写「Origin 必须存在」会把桌面端全判 403）。

### 4.4 注册契约

`package.json` 的 `dsh` 字段：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-primitives"
      ]
    }
  }
}
```

`cordis.patch.yml` 里 `insert` 一行即可挂载。Host 入口导出 `name / inject / apply`。

## 5. git 命令选型（按功能）

以下 argv **已从 `@linxin666/dsh-client-ui-git-graph@0.4.8` 的生产代码中逐条核出**（该插件声明 `dsh >=0.2.1-rc.2`，与当前运行时一致），可直接照抄：

```js
// 仓库根 + 短 HEAD（一次 rev-parse，未出生 HEAD 时第二段 exit 128 但第一段已打印）
["rev-parse", "--show-toplevel", "--short", "HEAD"]     // rootAndHeadArgv

// 当前分支（detached 时打印 "HEAD"）
["rev-parse", "--abbrev-ref", "HEAD"]

// 本地分支（\0 分隔，%(HEAD) 当前分支为 "*"）
["for-each-ref", "refs/heads",
 "--format=%(refname:short)%00%(HEAD)%00%(objectname)"]

// 脏文件 / 未跟踪 / 冲突
["status", "--porcelain"]                                // v1 足够；首字符 1/2→改动，?→未跟踪，u→冲突
["diff", "--name-only", "--diff-filter=U"]               // 冲突文件列表

// 进行中操作（一次 spawn 解析全部 marker 路径，再 stat）
["rev-parse", "--git-path", "MERGE_HEAD", "--git-path", "CHERRY_PICK_HEAD",
 "--git-path", "REVERT_HEAD", "--git-path", "BISECT_LOG",
 "--git-path", "rebase-merge", "--git-path", "rebase-apply",
 "--git-path", "sequencer"]

// 提交图谱（自己算 lane，不解析 --graph 的 ASCII）
["log", "--branches", "--tags", "--remotes", "--topo-order", "--parents",
 "--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e", "--max-count", String(limit)]

// 切换分支（--no-guess 防止把远程名猜成本地分支）
["switch", "--no-guess", "--", branch]
["switch", "--no-guess", "-c", name]                     // 新建并切换

// 分支名校验（权威）
["check-ref-format", "--branch", name]
["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]

// worktree（防「目标分支已被其他 worktree 检出」）
["worktree", "list", "--porcelain"]
```

**本需求额外需要、参考实现里没有的：**

| 功能 | 命令 | 要点 |
|---|---|---|
| 每文件增删行 | `["diff", "--numstat", "-z"]` + `["diff", "--cached", "--numstat", "-z"]` | 二进制为 `-\t-`，跳过；未跟踪文件单独 `["ls-files", "--others", "--exclude-standard", "-z"]` 后按行数计 |
| 总 `+3365 −38` | 汇总上一步 | 与截图一致：绿加红减 |
| 提交 | `["add", "-A"]` → `["commit", "-F", "-"]` | **提交信息走 stdin**，避免引号/换行注入；无改动提前短路；hook 失败原样回传 stderr |
| 推送 | `["push"]`；无 upstream → `["push", "-u", "origin", branch]` | `GIT_TERMINAL_PROMPT=0` 防卡在凭据提示；认证失败要显式提示 |
| 单文件 / 单提交 diff | `["diff", "--", path]` / `["show", "--format=", "--patch", sha]` | 拿 `oldText`/`newText` 交给 `DiffBlock` |

**图谱 lane 算法**：`dsh-git-graph/lib/client.js` 与 `dsh-git-graph/lib/index.js` 里有两份现成实现（约 70 行，`lanes` / `maxCols` / `childLane` / `parentLane`）。两种画法：`parallel`（VSCode 风格，各占一列）与 `compact`（git log 风格，共享祖先合并）。用 SVG 画，不引第三方库。

**边界情况清单**：detached HEAD（`branch === "HEAD"`）、unborn HEAD（`oid === "(initial)"`）、无 upstream、rebase/merge/cherry-pick/bisect/sequencer 进行中、子模块、超大数据集（限 N 条 + 分页）、二进制文件、CRLF、`.git/index.lock` 冲突（重试一次）、非仓库目录、git 未安装（`exitCode 127`）、Windows 上需 `git.exe`。

## 5.1 写操作的守卫（照抄 ZCode 语义）

`dsh-git-graph` 已把 ZCode 的守卫实现好了，四种稳定错误码：

- `conflicts-present` — 有未解决冲突
- `operation-in-progress` — 有 merge/rebase 等在进行
- `branch-checked-out-elsewhere` — 目标分支被别的 worktree 检出
- `tracked-changes-would-be-overwritten` / `untracked-changes-would-be-overwritten` — 切换会覆盖本地改动

**本插件取更保守的策略**：切换分支前若有未提交改动，**不自动 stash**，而是提示「先提交或贮藏」；`git switch --no-guess`，不加 `--force`。

## 6. 社区现有插件对比（避免重复造轮子）

| 包 | 版本 | 形态 | 与需求差距 |
|---|---|---|---|
| `dsh-git-idea` | 0.3.0 | 输入框左侧 chip + 点击弹 IDEA 风 VCS 面板（分支树/提交图/变更/暂存/提交/diff）+ 设置页 | **最接近**，但入口在输入框不在右上角；无「收起只剩 +/−」；无独立 Git 图谱弹窗（图谱在面板内） |
| `@xbzbing/dsh-git-panel` | 1.8.2 | 工作区标签页「Git」三栏（分支/历史图/变更）+ 输入框分支标记 + AI 生成提交信息 | 功能最全，但**是标签页不是徽标**；带 5MB mermaid |
| `@happyqu/dsh-plugin-git` | 0.1.23 | 头部 utilities 小徽标 + `shell.overlay` 工作台窗口 | **落点与需求一致**，可参考其 sessionId 跨 slot 传递方案 |
| `dsh-git-badge` | 0.20.1 | 输入框 chip + 侧边栏会话行图标 + hover 卡（含 PR/CI） | 只读徽标，无提交/推送/图谱 |
| `dsh-cool-git` | 0.2.3 | `conversation.view` 标签页 | 形态不符 |
| `dsh-plugin-git-status` | 0.6.0 | 输入框 chip，**只读** | 只读 |
| `dsh-git-plus` | 0.1.56 | 侧边栏面板 | 形态不符 |

**结论**：需求里的「右上角常驻徽标 / 收起只剩 +/− / 卡片 / 图谱弹窗」这套组合**没人做过**。不必从零造轮子，但也确实是一个空位。

## 7. 建议：并入本仓库 vs 新仓库

**建议并入 `dsh-插件` 仓库**（`dsh-token-metrics` 所在的这个），理由：

1. 基础设施全部现成：Host 路由注册、`readJsonBody`/`sendJson`、`ctx.effect` 生命周期、locale 注册、`window.__ModuleLoader__` 手写 bundle、11 个测试脚手架。
2. 本仓库已有自更新 + 自热重载（`src/updater.js`、`src/reload.js`），新插件可直接复用同一套发布流程。
3. 同一 profile 只装一个包，减少「两个插件抢同一个 slot」这类事故（`dsh-git-idea` README 明确警告过）。

**代价**：包名 `dsh-token-metrics` 与 Git 功能语义不符。两个解法：
- (A) 保持包名，插件内部再注册一个 `git-tools` 条目（一个包两个功能，DSH 支持）；
- (B) 拆成 monorepo，`packages/token-metrics` + `packages/git-tools`（干净，但要改构建/发布流程）。

**推荐 (A)**，先把功能做出来；若之后 Git 部分长大到需要独立发布，再拆 (B)。

## 8. 主要风险

1. **版本漂移**：0.2.1-rc.2 是 rc 版，slot 名单与 `dsh.client` 契约都可能变。缓解：所有 slot 注册包 `try/catch`（现有代码已是这个风格），并在 README 标注实测版本。
2. **`shell.overlay` 的 sessionId 断裂**：root 级 seat 拿不到 session 绑定，必须自己用 store 桥接。缓解：徽标与卡片共用一个模块级 store（`dsh-plugin-git` 已验证）。
3. **写操作的安全性**：commit/push/branch 是破坏性操作。缓解：argv 数组 + cwd 锁定仓库根 + 明确二次确认 + 不自动 stash/不 `--force`。
