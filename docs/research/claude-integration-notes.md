# Claude Code (CLI + VS Code extension): token accounting & config injection

Research date: 2026-10-28. Machine: macOS (darwin-arm64), Claude Code **2.1.312** extension
(`~/.vscode/extensions/anthropic.claude-code-2.1.312-darwin-arm64/`), CLI versions observed in
transcripts 2.1.197 → 2.1.310.

Citation conventions used below:

- `SCHEMA` = `~/.vscode/extensions/anthropic.claude-code-2.1.312-darwin-arm64/claude-code-settings.schema.json`
- `EXTJS` = `~/.vscode/extensions/anthropic.claude-code-2.1.312-darwin-arm64/extension.js`
- `DOC:<page>` = `https://code.claude.com/docs/en/<page>` (fetched 2026-10-28)
- `CCUSAGE` = `https://github.com/ryoppippi/ccusage` @ `main`, path given per claim
- Local transcripts = `~/.claude/projects/**/*.jsonl` (22 files, 11,111,733 bytes of JSONL;
  `du -sh` reports 18 MB for the whole `projects/` tree including `memory/` and block overhead)

> **Note on one premise in the brief.** The brief said `~/.claude.json` does not exist on this
> machine. It **does** exist (77,661 bytes, mtime 2026-10-28 10:16). See §1.4 — this matters,
> because it is the richest on-disk source of *already-computed* per-session cost.

---

## 1. Config files & precedence

### 1.1 The four settings files

| Scope | Path | Notes |
|---|---|---|
| User | `~/.claude/settings.json` | every project on the machine |
| Shared project | `<repo>/.claude/settings.json` | committed; read from the session's **primary working directory** |
| Project local | `<repo>/.claude/settings.local.json` | Claude Code adds `**/.claude/settings.local.json` to your global git excludes the first time *it* writes the file |
| Managed | `managed-settings.json` (+ `managed-settings.d/`), MDM, or server-managed | see §1.2 |

Sources: `DOC:settings`. Windows: `~/.claude` means `%USERPROFILE%\.claude`.

One subtlety worth planning for: the local file is anchored at the **git repository root**
(v2.1.211+), not the launch directory. If you start in a subdirectory, Claude Code reads/writes
the local file at the repo root, and in a worktree at the *main checkout's* root. It reverts to
the starting directory when: outside a git repo, when the repo root is `$HOME`, on Windows, or
when the root/`.git`/`.claude` entry isn't owned by your user (`DOC:settings`).

### 1.2 Enterprise managed settings paths (per OS)

From `DOC:managed-settings`:

- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
- Linux & WSL: `/etc/claude-code/managed-settings.json`
- Windows: `C:\Program Files\ClaudeCode\managed-settings.json`

The system *directory* may also contain `managed-settings.d/` and `managed-mcp.json`.
**The legacy Windows path `C:\ProgramData\ClaudeCode\managed-settings.json is not read.**
Symlinks are allowed and followed even outside the system dir (with a `/status` + `claude doctor`
warning).

On this machine none of these exist — `/Library/Application Support/ClaudeCode` is absent — so
`modelPricing`, `availableModels`, `deniedModels`, `allowedProviders` etc. are **not in force**.

MDM on macOS is a managed plist; on Windows, `HKLM\SOFTWARE\Policies\ClaudeCode`. Server-managed
settings come from the claude.ai admin console. `managedSourcesBehavior` (`"first-wins"` default
vs `"merge"`) controls how those three compose (`SCHEMA`).

### 1.3 `CLAUDE_CONFIG_DIR`, `--settings`

- `CLAUDE_CONFIG_DIR`: relocates settings, **session history, and plugins** to that dir instead of
  `~/.claude` (`DOC:settings`). ccusage supports a *list* of dirs here and accepts either a config
  dir containing `projects/` or the `projects/` dir itself (`CCUSAGE:rust/adapters/claude/src/paths.rs`,
  `claude_paths()` / `normalize_claude_config_path()`).
- `--settings <file-or-json>`: per-session layer that sits **above** user/project/local and
  **below** managed. It "can set any key your user settings file can set; it can't set Managed or
  Global config keys" (`DOC:settings`). Notably it is **not** a path for `modelPricing` (§3b).

### 1.4 What lives in `~/.claude.json` — and where 2.x state actually went

`~/.claude.json` **exists here** and is written by Claude Code itself ("it writes for itself; you
don't need to edit it" — `DOC:settings`). Verified top-level keys on this machine (46 keys), notably:

- account/onboarding: `hasCompletedOnboarding: true`, `lastOnboardingVersion: "2.1.183"`,
  `oauthAccount`-adjacent account state, `numStartups: 156`, `firstStartTime`, `installMethod: "native"`
- identity: `userID`, `machineID`
- **`projects` (10 entries)** — per-project state keyed by the *real absolute cwd*, containing
  `hasTrustDialogAccepted`, `allowedTools`, `mcpServers`, `enabledMcpjsonServers`, and — importantly
  for us — **`lastCost`, `lastAPIDuration`, `lastTotalInputTokens`, `lastTotalOutputTokens`,
  `lastTotalCacheCreationInputTokens`, `lastTotalCacheReadInputTokens`, `lastTotalWebSearchRequests`,
  `lastModelUsage`, `lastSessionId`, `lastStartTime`**
- `mcpServers`, `disabledMcpServers`
- caches: `cachedGrowthBookFeatures` (987 entries), `tipsHistory`, `pluginUsage`, `skillUsage`

So the 2.x answer is **both**: identity/trust/MCP/global-config stayed in `~/.claude.json`, while
*newer* runtime state moved into `~/.claude/` subdirs:

| Path | Content (verified) |
|---|---|
| `~/.claude/state/` | `mcp-discover-verdicts.json` — protocol discovery cache, keyed `stdio:<hash>` |
| `~/.claude/sessions/<pid>.json` | **live session registry**: `{pid, sessionId, cwd, startedAt, version, entrypoint, messagingSocketPath, name, nameSource, peerFeatures…}`. 1 file here, for the running 2.1.312 session. |
| `~/.claude/session-env/<sessionId>/` | per-session scratch dir. 25 dirs here, **all empty**. |
| `~/.claude/history.jsonl` | 125 KB prompt history |
| `~/.claude/backups/` | `claude.json.backup.<epochMs>` rotation + `official-login-restore-*` dirs |
| `~/.claude/.last-cleanup`, `.last-update-result.json` | housekeeping markers |
| `~/.claude/stats-cache.json`, `security/`, `file-history/`, `tasks/`, `teams/`, `plugins/`, `ide/` | ancillary |

`~/.claude/sessions/<pid>.json` is the cheapest way for an external extension to discover *live*
sessions and their `cwd`/`entrypoint` without parsing transcripts.

### 1.5 Precedence (highest → lowest)

Verbatim order from `DOC:settings` §"Settings precedence":

1. **Managed settings** — "Nothing in your own settings files or `--settings` overrides a managed key"
2. **Command line** (`--settings <file-or-json>`) — session only
3. **Project local** `.claude/settings.local.json`
4. **Shared project** `.claude/settings.json`
5. **User** `~/.claude/settings.json`

Two rules that trip people up:

- **Lists merge instead of overriding.** `permissions.allow` etc. combine across files. But
  `fallbackModel` (ordered chain) takes the *whole* value from the highest file that defines it;
  `modelPicker` "never merges rows from two sources … takes the whole value from the highest of
  managed settings, `--settings`, and user settings that defines it, and **ignores the key in
  project and local settings**" (v2.1.242+); `availableModels` from managed is applied as-is,
  ignoring user additions.
- **Env vars are NOT a level in this stack.** "which one applies is decided per pair, not by
  level: `ANTHROPIC_MODEL` exported in your shell applies over the `model` key from any file, while
  `ANTHROPIC_DEFAULT_MODEL` applies only when no file sets `model`. An `env` block inside a
  settings file is an ordinary key and follows the levels above." (`DOC:settings`)

Security-sensitive keys have a "stricter value from a lower level wins" exception (sandbox locks,
`allowManagedPermissionRulesOnly` family) — see `DOC:settings` §"Exceptions to managed settings
precedence".

### 1.6 Which file should an external tool edit to route to a custom gateway?

**`~/.claude/settings.json`, `env` block.** That is what this machine already does:

```
ANTHROPIC_BASE_URL  = http://127.0.0.1:15721          ← cc-switch local proxy
ANTHROPIC_AUTH_TOKEN = <REDACTED len=13>
ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL      = ccs-claude-p178650--claude-opus-5-5[1M]
ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL_NAME = claude-opus-5-5
CLAUDE_CODE_EFFORT_LEVEL = max
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = 1
CLAUDE_CODE_AUTO_MODE_SERVER = 0
```

(Rendered redacted; the token is a 13-char opaque value, not a JWT.)

Why user settings and not something else:

- `.claude/settings.json` (project) — **works** for `env`, but it's shared/committed; wrong blast radius.
- `.claude/settings.local.json` — works, but per-repo; you'd have to write every repo.
- `managed-settings.json` — works and is the *only* place some keys are honored, but requires
  root-owned write to `/Library/Application Support/ClaudeCode/`. Overkill for gateway routing.
- `--settings` at launch — fine but requires controlling the spawn.
- `~/.claude.json` — **wrong**; it's Claude Code's own file, not a settings source.

For `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_DEFAULT_*_MODEL`, **user settings
`env` is honored** — confirmed empirically by the live config above and by the extension's own
schema treating `env` as a plain `{string: string}` map (`SCHEMA`, `env` →
`additionalProperties: {"type":"string"}`).

Caveat: docs warn Claude Code *ignores* the OTel exporter vars in project/local settings
(`DOC:env-vars`), i.e. key-specific carve-outs exist. For the gateway keys there is no such
carve-out in user settings.

---

## 2. The `env` block

`SCHEMA` defines it minimally: `"env": {"description": "Environment variables to set for Claude
Code sessions", "type": "object", "additionalProperties": {"type": "string"}}`. So **any** env var
name is schema-legal; the semantic list comes from `DOC:env-vars`.

### 2.1 Gateway routing & model aliasing

| Key | Semantics (doc-verbatim where quoted) |
|---|---|
| `ANTHROPIC_BASE_URL` | "Override the API endpoint to route requests through a proxy or gateway." v2.1.196+: Remote Control is disabled when this isn't `api.anthropic.com`. **Changes where requests go, not which model answers** (`DOC:model-config`). |
| `ANTHROPIC_AUTH_TOKEN` | "Custom value for the `Authorization` header (the value you set here will be prefixed with `Bearer`)" |
| `ANTHROPIC_API_KEY` | Sent as `X-Api-Key`. "When set, this key is used instead of your … subscription even if you are logged in." In `-p` always used; interactive prompts once. |
| `ANTHROPIC_MODEL` | "Name of the model setting to use". Applies **over** `model` from any settings file. |
| `ANTHROPIC_DEFAULT_MODEL` | Default for new sessions (v2.1.236+). Applies only when **no file** sets `model`. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL` / `_FABLE_MODEL` | What the `opus`/`sonnet`/`haiku`/`fable` alias resolves to; also `opusplan`'s two halves; Haiku also drives "background functionality". |
| `…_MODEL_NAME` | Display name for that pinned model in the `/model` picker |
| `…_MODEL_DESCRIPTION` | Picker row description (default begins "Custom Opus model") |
| `…_MODEL_SUPPORTED_CAPABILITIES` | Comma-separated capabilities, e.g. `effort,thinking` |
| `API_TIMEOUT_MS` | Per-attempt time-to-response-headers, **default 600000**, max 2147483647; `0` removes the limit (v2.1.305+, non-streaming still capped at 300 s locally) |
| `API_FORCE_IDLE_TIMEOUT` | 5-min body-idle watchdog; `0` disables (useful for slow local models) |
| `CLAUDE_CODE_*` | Very large family. On this machine: `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_AUTO_MODE_SERVER`. Relevant to us: `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_PROMPT_CACHE_TTL` (overrides `promptCacheTtl`), `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `CLAUDE_CODE_ENTRYPOINT` |

`ANTHROPIC_SMALL_FAST_MODEL` is **deprecated** in favour of `ANTHROPIC_DEFAULT_HAIKU_MODEL`.

### 2.2 Precedence for `env`

`env` is an ordinary settings key, so it follows §1.5 file precedence. Independently, a value
already exported in the *shell* and a *settings key* interact **per-pair** (`DOC:settings`,
§"Settings precedence"). Practically, for a tool that wants deterministic routing:

- Write `env` into `~/.claude/settings.json` (highest user-writable layer), **and**
- make sure the user's shell doesn't export a conflicting `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_MODEL`, because the shell wins for `ANTHROPIC_MODEL` but loses to files for
  `ANTHROPIC_DEFAULT_MODEL`. This asymmetry is the single most likely cause of "my gateway config
  didn't take".

`/config` writes into user settings too, so a `/config` change and your tool both mutate the same
file — see §7 collision risk.

---

## 3. The authoritative settings schema

`SCHEMA` header (ground truth):

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
 "$id":"https://www.schemastore.org/claude-code-settings.json",
 "type":"object",
 "additionalProperties":{},
 "title":"Claude Code Settings",
 "$comment":"Generated on 2026-10-27T16:56:58.031Z"}
```

**180 top-level properties** (counted). Root `additionalProperties` is the *empty schema* `{}`,
i.e. **unknown top-level keys are permitted by the schema** (no `additionalProperties: false`
anywhere at root). Nested maps: `env` → `{string:string}`, `hooks` → enum-restricted
`propertyNames` + array-of-handler objects, `permissions` and `sandbox` → `additionalProperties: {}`.

### 3a. Provider / gateway routing keys

**`model`** — `{"description":"Override the default model used by Claude Code","type":"string"}`.
Managed `model` "is a starting default, not a lock; the locks are `availableModels` and
`deniedModels`" (`DOC:settings`). Read **once at session start** — use `/model` mid-session.

**`fallbackModel`** (array of string) — "Fallback model(s) tried in order when the primary model is
overloaded or unavailable. Each element accepts a model name or alias; `"default"` expands to the
default model. **CLI `--fallback-model` takes precedence.**" Takes its *whole* value from the
highest file that sets it (no merge).

**`availableModels`** (array) — "Allowlist of models that users can select. Accepts family aliases
(`"opus"` allows any opus version), version prefixes (`"opus-4-5"` allows that version and any
model ID that extends it, so `"claude-opus-5"` also allows `"claude-opus-5-5"`), and full model
IDs. If undefined, all models are available. **If empty array, only the default model is
available.** Typically set in managed settings by enterprise administrators."

**`enforceAvailableModels`** (bool) — "When true and `availableModels` is a non-empty array, the
Default model selection is also constrained: if the default model for the user tier is not in
`availableModels`, Default resolves to the first allowed `availableModels` entry instead. Has no
effect when `availableModels` is unset or an empty array."

**`availableModelsMatch`** (`"prefix"` default | `"exact"`) — "With `"exact"` and a list that names
at least one model, the Default option also uses only a listed model; **if none can be used, Claude
Code will not start.** … Read from managed settings only." (`"prefix"`: `claude-opus-5` allows
`claude-opus-5-5`; `"exact"`: it allows dated and `-fast` IDs but *not* Opus 5.5.)

**`deniedModels`** (array) — "Models users cannot select, even when `availableModels` allows them.
A family alias blocks that family. A model ID blocks that version in every spelling: dates, `-fast`
and provider prefixes are ignored … **The Default option steps down past a blocked model; if the
Default has no allowed model to step down to, Claude Code will not start.** Read from managed
settings only."

**`modelOverrides`** (object → string) — "Override mapping from Anthropic model ID (e.g.
`"claude-opus-4-6"`) to provider-specific model ID (e.g. a Bedrock inference profile ARN).
Typically set in managed settings."

**`modelPicker`** (`{options[], replaceBuiltInOptions?}`) — "Curate the `/model` picker: an ordered
list of models with your own labels, independent of the built-in lineup and of Claude Code
releases. `availableModels` still applies to these rows. **Honored from managed, `--settings`/SDK,
and user settings only (not from a project checkout); the highest-precedence of those that defines
`modelPicker` wins outright (no merging across sources).**"

Row fields: `model` (**required**; "taken verbatim: an alias, an Anthropic model ID, or a
provider-format ID (Vertex, Bedrock, gateway). Same values `--model` accepts."), `label`,
`description`, `behavesAs` ("For a model this version of Claude Code does not know: the ID of a
model it does know … whose client-side handling — prompt profile, capability and effort defaults —
applies to it. Changes neither the row's label nor the model ID sent.").
`replaceBuiltInOptions: true` hides built-in lineup, gateway-discovered models and
`ANTHROPIC_CUSTOM_MODEL_OPTION`.

This machine's `~/.claude/settings.json` uses exactly this: `modelPicker.replaceBuiltInOptions: true`
with **18 options** (`SCHEMA`-valid), e.g. `ccs-claude-p178650--claude-opus-5-5[1M]` labelled
`claude-opus-5-5（「林夕」公益站）`. That is the extension's *documented* integration point for a
gateway's custom model IDs.

**`modelSettings`** (`{model → {effortLevel, maxEffortLevel, autoCompactWindow}}`) — "Per-model
settings keyed by canonical model name." `effortLevel` enum `low|medium|high|xhigh`;
`maxEffortLevel` adds `max` and "across settings files the **lowest** applicable value wins";
`autoCompactWindow` is `100000–1000000` or `"auto"`. "The canonical model name as key also matches
its dated, `[1m]`, Bedrock and Vertex spellings" — which is why `claude-opus-5` and
`ccs-claude-pmyclau--glm-5.3-flash` coexist here.

**`allowedProviders`** — **managed only.** "The API providers Claude Code may use on this machine:
`"anthropic"` … `"bedrock"`, `"vertex"`, `"foundry"`, `"anthropicAws"`, `"mantle"` …,
**`"customEndpoint"` (the Anthropic API or a cloud provider's API sent to some other host —
`ANTHROPIC_BASE_URL` … such as an LLM gateway; admitted only for the value pinned in the `"env"`
block of the same managed source)**, or `"gateway"` (the Cloud gateway sign-in). A session on a
provider that is not listed is **refused at startup, at login, and when it next contacts the API**…
Unset allows every provider; an empty array allows none."

→ Design consequence: a fleet that pins `ANTHROPIC_BASE_URL` through managed settings must also
list `"customEndpoint"`, and the URL must match byte-for-byte. If a tool rewrites the `env` URL in
user settings while managed settings pin a different one, the managed value wins and the URL
mismatch means `customEndpoint` is *not* admitted.

**`forceLoginMethod`** — `"claudeai" | "console" | "gateway"`.
**`forceLoginGatewayUrl`** — "Cloud gateway URL to pre-fill during login, alongside
`forceLoginMethod: "gateway"`. **Honored from admin-controlled managed settings … and, on a machine
with none of those, from your own user settings; ignored in project, local, flag, and
remote-delivered settings.**" → on this machine (no managed settings) user settings works.
**`forceLoginOrgUUID`** — UUID or array; when managed, login fails if account isn't in the org.

**`apiKeyHelper`** — `{"description":"Path to a script that outputs authentication values","type":"string"}`.
**`proxyAuthHelper`** — "Shell command that outputs a `Proxy-Authorization` header value (EAP)".
**`otelHeadersHelper`** — "Path to a script that outputs OpenTelemetry headers".
These three are in the extension's credential-helper set
(`EXTJS`: `xn0 = [...Rn0,"otelHeadersHelper","proxyAuthHelper"]`, `Rn0 = ["apiKeyHelper",
"awsAuthRefresh","awsCredentialExport","gcpAuthRefresh"]`) and are **reloadable mid-session**
("including edits to `permissions`, `hooks`, and credential helpers such as `apiKeyHelper`" —
`DOC:settings`). `apiKeyHelper` also gates `ANTHROPIC_BASE_URL` handling
(`EXTJS`: `B35={apiKeyHelper:["ANTHROPIC_BASE_URL","_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"],…}`).

### 3b. `modelPricing` — full shape + the managed-only question

**Schema shape** (`SCHEMA`, verbatim description):

> "Price usage at your organization's contracted rates instead of list price. Affects every spend
> figure Claude Code reports — `/cost`, the status line, the SDK `total_cost_usd`,
> `--max-budget-usd`, and the OpenTelemetry cost metric and events — which remain USD estimates,
> not an invoice (the per-Mtok price labels in `/model` stay at list). `"overrides"` maps a model ID
> to its USD-per-million-token rates (`input`, `output`, `cacheRead`, `cacheWrite` — **all four
> required**, each 0 to 10000; `cacheWrite` prices both 5-minute and 1-hour cache writes). A
> matching row is charged exactly as written; fast-mode and US-data-residency surcharges are not
> added on top. **A key Claude Code itself uses for a built-in model — its ID such as
> `"claude-sonnet-4-6"`, or its first-party, Bedrock (any or no region prefix), Vertex or Foundry
> ID — covers every dated and provider form of that model; any other key — a gateway model alias,
> or a spelling Claude Code does not itself use — matches that model ID only (case-insensitive),
> and such an exact match wins over a built-in row.** On Bedrock an application inference profile is
> matched by its backing model. An invalid row or multiplier is reported and skipped; the rest still
> apply. `"multiplier"` in (0, 10] scales every computed cost, overridden or not (0.85 = 85% of the
> price, 1.2 = 120%). **Only honored from managed settings (server-managed, MDM / OS policy, or
> `managed-settings.json`), or — when none of those sets it — when supplied by a host application
> that manages the model provider; ignored in user, project, local and `--settings` sources.**"

JSON shape:

```json
{"modelPricing": {
   "multiplier": 1.2,                                  // number, exclusiveMinimum 0, maximum 10
   "overrides": {
     "claude-sonnet-4-6": {"input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75},
     "ccs-claude-pmyclau--glm-5.3-flash[1m]": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
   }}}
```

`overrides.*` has `required: ["input","output","cacheRead","cacheWrite"]` and each is
`minimum 0, maximum 10000`.

**Precedence / scope rules** (all from the description above):

1. **Scope**: managed only (server-managed / MDM / `managed-settings.json`), **plus** a
   host-application escape hatch. Explicitly **ignored** in user, project, local, and `--settings`.
2. **Key matching — two tiers.** A key that Claude Code itself uses for a built-in model is
   *normalizing*: it covers every dated and provider spelling (first-party, Bedrock with any/no
   region prefix, Vertex, Foundry). Any other key (a gateway alias like
   `ccs-claude-pmyclau--glm-5.3-flash[1m]`, or a spelling CC doesn't use) matches **that model ID
   only, case-insensitively** — and **an exact match wins over a built-in row**.
3. **`multiplier`** applies on top of everything, including overridden rows, range `(0, 10]`.
4. **Surcharges are not stacked**: fast-mode and US-data-residency multipliers are not added when a
   row matched.
5. **Bad rows are skipped, not fatal**: "An invalid row or multiplier is reported and skipped; the
   rest still apply." `EXTJS` confirms the reporting granularity: it emits per-field warnings
   (`modelPricing.multiplier`: `'"multiplier" must be a number greater than 0 and at most 10. It was
   ignored.'`; `modelPricing.overrides.<key>`: `Invalid pricing row was ignored (<path>: <msg>).`)
   and it `delete`s the offending key rather than rejecting the file.
6. **Consumers**: `/cost`, statusLine `cost.total_cost_usd`, SDK `total_cost_usd`,
   `--max-budget-usd`, OTel `claude_code.cost.usage` + cost events. `/model` price *labels* stay at
   list price.

Cross-check from `DOC:costs` §"Report spend at your contracted rates": "**Claude Code ignores the
key in user, project, and local settings and in `--settings`.**" and "Requires Claude Code v2.1.242
or later" (markup multiplier requires v2.1.271+).

**What "a host application that manages the model provider" means for a VS Code extension.**
The embedding host can inject an entire admin-tier settings document. Concretely, the extension
spawns the CLI/SDK and forwards its own `managedSettings` option as a CLI flag
(`EXTJS`: `if(this.options.managedSettings)i.push(...le("--managed-settings",this.options.managedSettings))`
and `managedSettings: K?d4(K):void 0` into the SDK options). That is the same tier as
`managed-settings.json` — `parentSettingsBehavior` in `SCHEMA` says so explicitly: *"Controls whether
the SDK parent tier (**`Options.managedSettings` / `--managed-settings`**) layers under this admin tier."*

So for a VS Code extension, "host application that manages the model provider" ≈ *the extension
supplies `Options.managedSettings` (or `--managed-settings`) containing `modelPricing`, because it
is the thing that chose/owns the provider (gateway/Vertex/Bedrock) the user is talking to*.
**UNVERIFIED**: whether Anthropic's shipping VS Code extension actually ever supplies
`modelPricing` itself. `modelPricing` *is* present in the extension's managed-tier key list
(`EXTJS`: `c35=[["model"],["fallbackModel"],["advisorModel"],["modelOverrides"],["modelPricing"],…]`),
which is consistent with it being a key the host lays down as policy — but I found no call site that
populates a pricing table, and on this machine nothing supplies one (`hasUnknownModelCost: true` in
`cost-state` records, §4.4).

**Bottom line for the engineering plan:** a third-party extension **cannot** set `modelPricing`
through `~/.claude/settings.json`, `.claude/settings.local.json`, `--settings`, or the SDK's
ordinary `settings` option. Its only legal channel is
`Options.managedSettings` / `--managed-settings` — i.e. it must act as the embedding host. If it
only edits `~/.claude/settings.json`, plan to compute costs **yourself** from `message.usage` (§4)
and not rely on `cost.total_cost_usd`.

### 3c. `statusLine`

Schema (`SCHEMA`): required `["type","command"]`; `type` const `"command"`; `command` string;
`padding` number; `refreshInterval` number `minimum: 1`; `hideVimModeIndicator` boolean.

- `refreshInterval`: "Re-run the status line command every **N seconds** in addition to
  event-driven updates" (min 1). Docs add: "Set this when your status line shows time-based data
  such as a clock, or when background subagents change git state while the main session is idle."
- `padding`: extra horizontal spacing in characters, default 0.
- `hideVimModeIndicator`: suppresses the built-in `-- INSERT --` when your script renders `vim.mode`.

Not in `SCHEMA` but real: `subagentStatusLine` = `{type:"command", command}` only — "Custom
per-subagent status line shown in the agent panel; receives row context as JSON on stdin".

Trigger/refresh model (`DOC:statusline`): runs once at session start (incl. resume), then on: new
assistant message, `/compact` finishes, permission-mode change, vim-mode toggle, `command` change,
`refreshInterval` tick, a `rate_limits` window reaching `resets_at`, or a warm `prompt_cache`
reaching `expires_at`. Debounced at 300 ms; a `command` change skips the debounce; a new trigger
**cancels the in-flight script**. Runs locally, consumes no tokens. `COLUMNS`/`LINES` env vars carry
terminal size. Gated by `disableAllHooks` (per `SCHEMA`: "Disable all hooks and statusLine
execution") and by `allowManagedHooksOnly`.

See §6 for the full stdin contract.

### 3d. `sandbox`, `hooks`, `cleanupPeriodDays`

**`cleanupPeriodDays`**: `integer`, `exclusiveMinimum 0`, max `9007199254740991`. "Number of days
to retain chat transcripts before automatic cleanup (**default: 30**). Minimum 1. Use a large value
for long retention; use `--no-session-persistence` to disable transcript writes entirely."
→ Directly affects how much JSONL history a usage tool can read. On this machine transcripts reach
back to ≥ 2026-06-18 (`firstStartTime`), so a non-default retention is in effect **or** cleanup
hasn't run; `~/.claude/.last-cleanup` exists (mtime 2026-10-28 10:26). UNVERIFIED which.

**`sandbox`** (object, `additionalProperties: {}`): properties `enabled` (default false),
`failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands` (default true),
`network{allowedDomains, deniedDomains, strictAllowlist, allowManagedDomainsOnly,
allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup…}`,
`filesystem`, `credentials`, `ignoreViolations`, `enableWeakerNestedSandbox`,
`allowNestedUserNamespaces`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `bwrapPath`,
`ripgrep`, `socatPath`.

Precedence detail worth quoting: "*When managed settings or a `--settings` file set
`allowUnsandboxedCommands: false`, or managed settings set `network.allowManagedDomainsOnly: true`,
and managed, `--settings` or user settings set `true`, **false from project settings
(`.claude/settings.json` and `.claude/settings.local.json`) is ignored** (true there still
applies).*" And `network.strictAllowlist`: "Only honored from user, managed/policy, or CLI
(`--settings`) settings — project settings … are ignored."

**`hooks`** (object): `propertyNames.enum` is the **authoritative event list** — 33 events:
`PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit,
UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied,
Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange,
WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded,
MessageDisplay`.

Each event maps to an **array** of `{matcher?, hooks:[handler…]}`; handler `oneOf` five types:
`command` (required `type`,`command`; optional `args` exec-form, `if` permission-rule filter,
`shell: bash|powershell`, `timeout`, `onFailure: continue|block`, `statusMessage`, `once`, `async`,
`asyncRewake`), `prompt` (required `prompt`; optional `model`, `continueOnBlock`), `agent`
(required `prompt`; optional `model`), `http` (required `url`; optional `headers`,
`allowedEnvVars`), `mcp_tool` (required `server`,`tool`).

Note the brief's list is the *documented subset*; the schema is 33, not 9.

---

## 4. JSONL session log structure

### 4.1 Location & naming

`~/.claude/projects/<slug>/<sessionId>.jsonl`. Slug = the session's cwd with path separators
replaced by `-` **and every non-`[A-Za-z0-9-]` character also replaced** — so `/` and any CJK or
space character all become `-`. Verified: 22 files, all at depth 2 (no `subagents/` dirs on this
machine — 0 subagent transcript files exist here).

### 4.2 The slug is **lossy and unrecoverable**

Proof from this machine (`cwd` values recovered from record bodies vs. slug):

| slug | cwd values actually found inside |
|---|---|
| `-Users-hugoyu-Desktop-------` | `/Users/hugoyu/Desktop/物业管理平台`, `/Users/hugoyu/Desktop/物业管理平台/docs/项目治理` |
| `-Users-hugoyu-Desktop------` | `/Users/hugoyu/Desktop/无纸化平台`, `/Users/hugoyu/Desktop/无纸化平台/frontend` |
| `-Users-hugoyu-Desktop--Agent--` | `/Users/hugoyu/Desktop/多Agent协同` |
| `-private-var-folders-2v-s9w6nhnx1rv-6csnzv-s7t0m0000gn-T-claude-sandbox-status-Nela3T` | `/private/var/folders/2v/s9w6nhnx1rv_6csnzv_s7t0m0000gn/T/claude-sandbox-status-Nela3T` |

The two CJK project names (`物业管理平台` 5 chars, `无纸化平台` 4 chars) both collapse to
`-------` / `------`. **Information is destroyed, not just encoded** — you cannot invert it. Note
the `_` in the `/private/var` path also became `-`, so even ASCII is unrecoverable in general.

ccusage does **not** recover the path either: `extract_project()` returns the slug directory name
verbatim (`CCUSAGE:rust/adapters/claude/src/paths.rs`), and `parse_project_name()` in
`crates/ccusage-core/src/project_names.rs` does *cosmetic* shortening only (strip leading
`-Users-<name>-`, cut `--<worktree>`, truncate long dash runs). Its `project_path` is the slug, not
a real path.

**Correct consumer strategy — recover the path from records, not the slug.** Every conversational
record carries `cwd` (2,539 of 3,971 records here) and records are the ground truth. Algorithm:
group by `sessionId`, take the **modal or first** `cwd`, and additionally note that a session can
span multiple `cwd`s (`/Users/hugoyu/Desktop/0226NewJD` appears with 5 distinct cwds: the root,
`wwwroot`, `wwwroot/js/templates`, `wwwroot/js/templates/admin`, `wwwroot/styles`) because of
`/cd` and `workspace.added_dirs`. If you need one label per project, use the **shallowest common
prefix** of a session's cwds, or the first record's `cwd`. `~/.claude.json`'s `projects` map is
keyed by *real absolute paths* and is a good secondary index (§1.4), as is
`~/.claude/sessions/<pid>.json`'s `cwd` for live sessions.

5 of 10 slugs here map to >1 `cwd` — never assume a 1:1 slug→project mapping.

### 4.3 Record `type` values actually observed

Counts across all 22 files:

```
assistant 1098 · user 756 · api-request 487 · system 418 · attachment 267
last-prompt 182 · atis-latch 133 · queue-operation 120 · ai-title 106
mode 93 · custom-title 76 · permission-mode 41 · file-history-snapshot 41
api-request-blob 39 · cost-state 30 · file-history-delta 17
api-request-shape 9 · agent-name 4
```

`system.subtype` values: `api_error 367`, `stop_hook_summary 39`, `turn_duration 10`,
`informational 1`, `away_summary 1`.

The brief's guessed list (`custom-title`, `ai-title`, `queue-operation`, `last-prompt`, `mode`,
`atis-latch`) is all real, but there are many more. **Only `assistant` carries `message.usage`.**
Newer 2.1.3xx adds non-transcript bookkeeping records (`api-request`, `api-request-shape`,
`api-request-blob`, `api-request-blob.hash`, `atis-latch`, `cost-state`, `file-history-*`,
`permission-mode`) that a naive reader will either choke on or double-count.

A `system`/`api_error` record is *retry telemetry*, not usage: `{subtype:"api_error", level, error,
retryInMs, retryAttempt, maxRetries, …}` → these inflate record counts but carry no tokens.

### 4.4 `assistant` record anatomy (verified, 1,098 records)

**`model` is at `message.model`, NOT at the record level.** I checked all 1,098: `record.model`
present in **0** records; `message.model` present in **1,098**. The brief's hypothesis that newer
versions moved `model` to the record level is **false** for 2.1.197–2.1.310. (ccusage reads
`data.message.model` — `CCUSAGE:rust/crates/ccusage-core/src/cost.rs` line 11.)

```json
{
  "parentUuid": "b2a31f26-…",
  "isSidechain": false,
  "message": {
    "type": "message", "role": "assistant",
    "model": "z-ai/glm-5.3-flash",
    "id": "chatcmpl-7f0143ba-…",
    "content": [ … ],
    "stop_reason": "tool_use", "stop_details": null,
    "usage": {
      "input_tokens": 2654,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 32000,
      "output_tokens": 501,
      "output_tokens_details": {"thinking_tokens": 0},
      "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
      "service_tier": "standard",
      "cache_creation": {"ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0},
      "inference_geo": "",
      "iterations": [],
      "speed": "standard",
      "fallback_credit": null
    }
  },
  "apiBlockIndex": 1,
  "requestRef": "c9656df3-…",
  "requestedModel": "ccs-claude-pmyclau--glm-5.3-flash[1m]",
  "attributionSkill": "hugo-collaboration-flow",
  "type": "assistant",
  "uuid": "e91c5296-…",
  "timestamp": "2026-10-26T05:53:37.726Z",
  "effort": "max", "perTurnEffort": null,
  "userType": "external", "entrypoint": "claude-vscode",
  "cwd": "/Users/hugoyu/Desktop/无纸化平台",
  "sessionId": "8eebf297-8ba5-4fe3-a5e9-74014ee5f5b7",
  "version": "2.1.310", "gitBranch": "main"
}
```

**`message.usage` field presence** (of 1,098):

| field | count | notes |
|---|---|---|
| `input_tokens` | 1098 | always |
| `output_tokens` | 1098 | always |
| `cache_creation_input_tokens` | 1084 | 14 absent (synthetic) |
| `cache_read_input_tokens` | 1084 | 14 absent |
| `cache_creation` | 1055 | **always** `{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` (both keys always present together — 1055/1055) |
| `service_tier` | 1052 | `"standard"` ×1014, `null` ×84 |
| `iterations` | 1052 | **always `[]`** on this machine (`{0:1014}` non-null); non-empty only for advisor/`type:"message"` multi-model turns |
| `speed` | 1052 | `"standard"` |
| `server_tool_use` | 1052 | `{web_search_requests, web_fetch_requests}` |
| `inference_geo` | 1052 | `""` |
| `output_tokens_details` | 488 | `{thinking_tokens}` |
| `fallback_credit` | 300 | `null` |
| `claude_cache_creation_5_m_tokens` | 29 | **legacy/alternate flat spelling** — appears on 29 older records alongside/instead of `cache_creation` |
| `claude_cache_creation_1_h_tokens` | 29 | same |

⚠️ The dual spelling matters: 29 records carry `claude_cache_creation_{5m,1h}_tokens` at the
`usage` level. A reader that only looks at `usage.cache_creation.ephemeral_*` will silently treat
those cache writes as zero (→ under-billed). Handle both.

**`message` keys overall**: `id, type, role, content, model, stop_reason, stop_sequence, usage` plus
optional `stop_details` (1040), `diagnostics` (23), `container` (38), `context_management` (38).

**Record-level fields** the brief asked about, with verified presence:

| field | present | semantics |
|---|---|---|
| `model` | **0** | use `message.model` |
| `requestedModel` | 315 | the **gateway alias actually requested** (`ccs-…-glm-5.3-flash[1m]`) vs `message.model` = resolved upstream model (`z-ai/glm-5.3-flash`). All 315 differ. Useful for attributing spend to a *picklist row* vs. a *provider model*. |
| `timestamp` | ISO-8601 UTC `…Z`, ms precision |
| `cwd` | 2539 | real absolute path — the only reliable project identity |
| `gitBranch` | 2539 | `"main"` etc. |
| `sessionId` | 3859 | also on non-message records |
| `version` | 3035 | CLI semver; 11 distinct values here (2.1.197→2.1.310) |
| `isSidechain` | 2539 | **all `false`** here → no subagent traffic in this dataset |
| `agentId` | 0 | **all `None`** — not emitted on this machine's records (subagent attribution comes from `subagents/` file paths + `agentId` only when subagents run) |
| `parentUuid` | 2539 | message-tree parent |
| `uuid` | 2539 | this record's id |
| `entrypoint` | 2539 | `claude-desktop-3p` 584, `claude-vscode` 395, `cli` 104, `sdk-cli` 9, `sdk-py` 6 |
| `userType` | 2539 | `"external"` |
| `requestId` | 169 | only on a minority — **this is the strongest dedup key when present** |
| `effort` / `perTurnEffort` | 825 / 339 | `"max"` etc. |
| `apiBlockIndex`, `requestRef`, `attributionSkill` | 325 / 315 / 101 | |

### 4.5 Deduplication — the hard part

**Measured on this machine (all 22 files, 1,098 assistant records):**

| | records | input | output | cache write | cache read |
|---|---|---|---|---|---|
| naive sum | 1098 | 14,760,825 | 737,744 | 22,192,594 | 74,263,302 |
| dedup by `message.id`, keep max-output | 514 | 5,603,645 | 272,924 | 7,755,135 | 36,768,934 |

→ **Naive summing overstates input by 2.6×, output by 2.7×, cache write by 2.9×, cache read by
2.0×.** 514 unique `message.id`s; 259 ids appear >1 time covering 843 records; up to **12 copies**
of one id. Duplicates are not all identical: 4 groups have *growing* `output_tokens` (streaming
partials flushed at intervals), the rest are byte-identical re-writes.

Why duplicates exist:

1. **One line per content block.** Claude Code writes a record per streamed block, all sharing
   `message.id`. Docs/ccusage describe exactly this: *"Claude Code writes one line per content block
   with the same `message.id` but distinct timestamps"* (`CCUSAGE:…/claude/src/lib.rs`, doc-comment
   on `usage_dedupe_hash`).
2. **Streaming partials** with increasing `output_tokens` → keep the **last/largest**.
3. **Resume / fork replay** — the same turn re-appended after `--resume`, and sidechain replay.
4. **Gateway placeholder IDs** — the killer for this machine. `message.id` here is
   `chatcmpl-…` / `ocgo`, **not** `msg_…`. Gateways reuse one placeholder id for many responses.

**How ccusage solves it** (`CCUSAGE:rust/adapters/claude/src/lib.rs`, `usage_dedupe_hash` +
`should_replace_deduped_entry`):

- Dedup key = `(message_id, request_id, session_id?, timestamp?)` where:
  - if `request_id` is present → key is `(message_id, request_id)` (global, strongest);
  - if **absent** → add `session_id`, **and additionally `timestamp` unless
    `is_anthropic_message_id(message_id)`**.
- `is_anthropic_message_id()` = `starts_with("msg_") || starts_with("resp_")`. Documented rationale:
  *"Real Anthropic message IDs are unique per response, unlike the placeholder IDs gateways reuse
  for every response … only a request ID proves two lines belong to one response, so a gateway that
  reused a `msg_`-shaped placeholder would collapse to one entry per session."* **This is exactly
  the trap on this machine** (`chatcmpl-…`): treating identical ids as "one response" would delete
  genuinely distinct responses. Hence timestamp re-enters the key.
- On collision, `should_replace_deduped_entry` prefers, in order: non-sidechain over sidechain;
  then **higher `usage_token_total`** (= input+output+cache_creation+cache_read); then the entry with
  `speed` set. So "keep the last" ≈ "keep the largest" for growing streamed partials.
- Separately, two sidechain-replay hash routes (`"sidechain-replay"` / `"sidechain-replay-entry"`)
  plus a *session-alias* mechanism absorb the same message replayed under a different session id.
- `<synthetic>`: `model == "<synthetic>"` is rewritten to `model: null` (`lib.rs` ~line 538), and
  synthetic records carry all-zero usage (verified: 38 records, every token field 0) → they
  contribute nothing but must not be counted as a "model" (they'd otherwise appear as an
  unpriceable model name). Filter them out of per-model breakdowns.
- Validity gates before counting: reject non-semver `version`, empty `sessionId`, empty `requestId`.
- `iterations`: ccusage only extracts `type == "advisor_message"` iterations as *separate*
  `AdvisorUsage` rows (different model, own usage) — it does not double-count plain
  `type:"message"` iterations, which mirror the parent usage.

**Cost calculation** (`CCUSAGE:rust/crates/ccusage-core/src/cost.rs`):

- Price map is LiteLLM-shaped: `input_cost_per_token`, `output_cost_per_token`,
  `cache_creation_input_token_cost`, `cache_read_input_token_cost`, plus
  `*_above_200k_tokens` tier fields, `long_context_threshold`, `fast_multiplier`.
- **Cache-write multipliers**: 5-minute writes are billed at `pricing.cache_create`; **1-hour writes
  at `input × 2.0`** — `const CACHE_CREATE_1H_INPUT_MULTIPLIER: f64 = 2.0` and
  `cache_create_1h_cost = pricing.input * CACHE_CREATE_1H_INPUT_MULTIPLIER`. When `usage.cache_creation`
  is absent it falls back to `(cache_creation_input_tokens, 0)` i.e. all-5m.
- Where `cache_create` isn't published, it is **derived as `input × 1.25`** (`pricing.rs`:
  *"Whether `cache_create` came from published data rather than the derived `input * 1.25` default"*).
  So: **5m = 1.25×input, 1h = 2.0×input** — the 1.25×/2× the brief mentions, confirmed in source.
- Two-stage long-context pricing: if `long_context_threshold` is set and
  `input + cache_read + cache_5m + cache_1h > threshold`, **every bucket** is billed at that tier's
  rate (not marginal). Otherwise `tiered_cost()` uses marginal semantics above a 200,000 default.
- `CostMode`: `Auto` trusts a stored `cost_usd` when present else computes; `Calculate` always
  computes; `Display` never computes. → **prefer stored cost when present.**
- fast mode multiplies by `pricing.fast_multiplier`.

### 4.6 Already-computed cost on disk — `cost-state` (30 records)

The best source for *dollars* without a price table. Session-level snapshots:

```json
{"type":"cost-state","sessionId":"8eebf297-…","totalCostUSD":5.776088,
 "totalAPIDuration":6887826,"totalAPIDurationWithoutRetries":5462321,
 "totalToolDuration":390630,"totalLinesAdded":79,"totalLinesRemoved":1,
 "totalDuration":154580241,"startTime":1792993703091,
 "modelUsage":{
   "ccs-claude-p178650--claude-opus-5-5[1M]":{"inputTokens":9488,"outputTokens":17,
     "thinkingTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,
     "webSearchRequests":0,"costUSD":0.038292},
   "ccs-claude-pmyclau--glm-5.3-flash[1m]":{"inputTokens":371214,"outputTokens":42407,
     "thinkingTokens":0,"cacheReadInputTokens":17024000,"cacheCreationInputTokens":0,
     "webSearchRequests":0,"costUSD":5.737796}},
 "hasUnknownModelCost":true}
```

Notes: `modelUsage` is keyed by the **`requestedModel` alias** (picklist row), and
`hasUnknownModelCost: true` here means Claude Code could **not** price something — consistent with
no `modelPricing` table being in force (§3b) and a gateway alias it doesn't recognize. Also note
`totalCostUSD` (5.776) ≠ sum of `modelUsage` (5.776) — it does reconcile here. `startTime` is epoch
ms; `totalDuration` ms. Also mirrored per-project in `~/.claude.json` →
`projects[<abs cwd>].lastCost` / `lastTotal*Tokens` / `lastModelUsage`.

---

## 5. OpenTelemetry

**Enablement** (`DOC:monitoring-usage`, `DOC:env-vars`):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1          # required, set to 1
export OTEL_METRICS_EXPORTER=otlp              # otlp | prometheus | console | none
export OTEL_LOGS_EXPORTER=otlp                 # otlp | console | none
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer …"
export OTEL_METRIC_EXPORT_INTERVAL=10000       # ms, default 60000
export OTEL_LOGS_EXPORT_INTERVAL=5000          # ms, default 5000
```

Also `OTEL_RESOURCE_ATTRIBUTES`, signal-specific variants, `ANT_OTEL_EXPORTER_OTLP_*`
(`EXTJS` shows the recognized prefixes `OTEL_EXPORTER_OTLP_` and `ANT_OTEL_EXPORTER_OTLP_`).

**Scope carve-out that matters for a repo-local tool:** "Claude Code **ignores the OpenTelemetry
exporter variables in a repository's `.claude/settings.json` and `.claude/settings.local.json`**, so
a repository can't use them to turn telemetry on, choose where it goes, or capture content. Set them
in managed settings, or have each developer set them in their shell or `~/.claude/settings.json`.
A repository can still turn a signal **off** by setting its exporter selector, such as
`OTEL_LOGS_EXPORTER`, to `none`." And `CLAUDE_CODE_ENABLE_TELEMETRY` is "Ignored in project and
local settings". `OTEL_RESOURCE_ATTRIBUTES` and export interval/timeout/compression vars **do**
still apply from project/local.

**Metrics** (`DOC:monitoring-usage`): `claude_code.session.count`, `claude_code.lines_of_code.count`,
`claude_code.pull_request.count`, `claude_code.commit.count`, `claude_code.cost.usage` (unit USD),
`claude_code.token.usage` (unit tokens), `claude_code.code_edit_tool.decision`,
`claude_code.active_time.total` (unit `s`).

- `claude_code.token.usage` attributes: **`type` ∈ `input | output | cacheRead | cacheCreation`**
  — "The `input` type excludes tokens read from or written to the prompt cache … The
  `cacheCreation` type counts cache writes with the five-minute and one-hour cache lifetimes
  **together**" (⇒ **OTel cannot distinguish 5m vs 1h cache writes**, so it cannot reproduce the
  1.25×/2× split), plus `model`, `query_source` (`main|subagent|auxiliary`), `speed`, `effort`,
  and attribution `agent.name`, `skill.name`, `plugin.name`, `marketplace.name`,
  `mcp_server.name`, `mcp_tool.name` (user-defined names redacted to `"custom"`/`"third-party"`
  unless `OTEL_LOG_TOOL_DETAILS=1`).
- `claude_code.cost.usage`: same attributes + `model`, `query_source`.
- `claude_code.session.count`: `start_type` ∈ `fresh|resume|continue|agents_view`.

**Standard attributes** on all metrics/events: `session.id`, `ccr.session.id`, `organization.id`,
`user.account_uuid`, `user.account_id`, `user.id`, **`user.email`**, `terminal.type`, and
optionally `app.version` (`OTEL_METRICS_INCLUDE_VERSION`, default false),
`app.entrypoint` (`OTEL_METRICS_INCLUDE_ENTRYPOINT`, default false), `vcs.*`
(`OTEL_METRICS_INCLUDE_REPOSITORY`, default false, v2.1.269+), `OTEL_RESOURCE_ATTRIBUTES` keys
(`OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES`, default true), `session.id`
(`OTEL_METRICS_INCLUDE_SESSION_ID`, default true), `user.account_uuid`/`user.account_id`
(`OTEL_METRICS_INCLUDE_ACCOUNT_UUID`, default true).

⚠️ `user.id` is documented as "Random anonymous identifier generated on first run and **persisted in
`~/.claude.json`**" — verified: `userID` exists there (64 hex chars). Note this contradicts §1.4's
"what moved" narrative only mildly; `user.id` stayed put.

**Events** (OTEL logs): `user_prompt`, `assistant_response`, `tool_result`, `api_request`,
`api_error`, `api_refusal`, `api_request_body`, `api_response_body`, `tool_decision`, `safety`,
`permission_mode_changed`, `auth`, `mcp_server_connection`, `internal_error`, `plugin_installed`,
`plugin_loaded`, `skill_activated`, `at_mention`, `api_retries_exhausted`, `hook_registered`,
`hook_execution_start`, `hook_execution_complete`, `hook_plugin_metrics`, `compaction`,
`subagent_completed`, `feedback_survey`, `retention_sweep`, `managed_settings_resolved`.
Events add `prompt.id` (correlates a whole prompt; matches statusLine `prompt_id` and hook
`prompt_id`), `agent_id`/`parent_agent_id` (v2.1.310+), `workflow.run_id`/`workflow.name`.

**Is OTel a viable alternative data source for a VS Code extension?** Partly — and only
deliberately.

| | OTel | JSONL parsing |
|---|---|---|
| Setup | needs `CLAUDE_CODE_ENABLE_TELEMETRY=1` + exporter + a collector the extension can reach | zero config, already on disk |
| Timeliness | near-real-time push (min interval ~1 s) | polling; transcript writes are async and "may lag" (hooks doc) |
| Granularity | per-API-request metrics + per-prompt events, `query_source` subagent/auxiliary split | per-record, full fidelity incl. `message.id` |
| Cache-write TTL split | ❌ merged into `cacheCreation` | ✅ `ephemeral_5m/1h` (+ legacy flat fields) |
| Dedup | ✅ server-side counters, no duplicate problem | ❌ must reimplement ccusage's id heuristic |
| Historical backfill | ❌ only from enablement onward | ✅ full retained history |
| Privacy | ⚠️ ships `user.email`, `organization.id`, `user.account_uuid` to a collector | stays local |
| User-visible footprint | writes env vars into settings — high blast radius, and project-local can't enable it | reads only |
| Multi-tool coverage | CC only | CC + any other JSONL tool |

**Recommendation for the plan:** treat OTel as an *optional* second source for a daemon/enterprise
mode; make **JSONL the primary** because (a) it's already there, (b) it has the 5m/1h split needed
for correct cache pricing, (c) enabling OTel means writing `env` into user/managed settings — the
exact file another agent may be fighting over (§7). Also: `claude_code.cost.usage` is subject to
`modelPricing` — which a third-party extension can't set (§3b) — so OTel cost will be list price.

---

## 6. Hooks + statusLine as live-usage surfaces

### 6.1 Hook events

Authoritative list = `SCHEMA.hooks.propertyNames.enum` (33 events, §3d). The ones useful for live
usage accounting:

| Event | Why it matters for usage |
|---|---|
| `SessionStart` | session boundary; **only event that can receive a `model` field** (and "doesn't always") |
| `SessionEnd` | flush final totals; carries `reason` |
| `Stop` | **per-turn boundary** — best place to emit a turn's usage; carries `last_assistant_message`, `stop_hook_active` |
| `SubagentStop` | subagent boundary — attribute subagent spend |
| `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` | tool-level attribution |
| `PreToolUse` | can block; can also just record |
| `UserPromptSubmit` | turn start; can inject context |
| `PreCompact` / `PostCompact` | compaction events reset context; `/compact` also triggers a statusLine re-run |
| `PreModelSwitch` / `PostModelSwitch` | **follow model changes mid-session** (`from_model`/`to_model`) — the documented remedy for "there is no `$CLAUDE_MODEL`" |
| `Notification` | not a usage surface, but fires on permission/idle prompts |
| `ConfigChange` | **fires for each settings-file change Claude Code detects** — useful to detect a competing tool rewriting settings |

**Common stdin JSON fields** (`DOC:hooks` §"Common input fields"): `session_id`, `prompt_id`,
`transcript_path`, `cwd`, `scratchpad_dir` (v2.1.257+), `permission_mode`
(`default|plan|acceptEdits|auto|dontAsk|bypassPermissions`), `effort{level}`, `hook_event_name`,
`agent_id`, `agent_type`. Plus per-event fields.

Critical caveat, quoted: **"`transcript_path` … The transcript file is written asynchronously and
may lag the in-memory conversation, so it may not yet include the current turn's most recent
messages when a hook fires. Hooks that need the final assistant text of the current turn should use
`last_assistant_message` on `Stop` and `SubagentStop` instead of reading the transcript."**
⇒ **A hook that reads the JSONL to report usage will systematically under-report the current turn.**
That is the decisive design constraint for a hook-based live meter: prefer the statusLine (which
carries precomputed `cost.total_cost_usd` and `context_window.current_usage`) for "now", and the
JSONL for "history".

Hooks are reloadable mid-session (`ConfigChange` fires), run as subprocesses, inherit the parent env
**minus `OTEL_*` exporter vars** (and minus credentials when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`).

### 6.2 statusLine stdin contract (full)

`DOC:statusline` §"Available data" + "Full JSON schema". Verified field list:

```
cwd, session_id, session_name?, prompt_id?, transcript_path,
model{id, display_name},
workspace{current_dir, project_dir, added_dirs[], git_worktree?, repo{host,owner,name}?},
version,
output_style{name},
cost{total_cost_usd, total_duration_ms, total_api_duration_ms,
     total_lines_added, total_lines_removed},
context_window{total_input_tokens, total_output_tokens, context_window_size,
     used_percentage, remaining_percentage,
     current_usage{input_tokens, output_tokens,
                   cache_creation_input_tokens, cache_read_input_tokens}},
exceeds_200k_tokens,
prompt_cache{warm, caching_observed, ttl, expires_at, requests, misses,
     expected_rebuilds, hit_ratio, cache_write_tokens, miss_recache_tokens,
     last_miss_at, last_miss_cause{causes[],tools_added,tools_removed},
     miss_causes{tools_changed}, recache_tokens_if_cold},
fast_mode,
effort{level},
thinking{enabled},
rate_limits{five_hour{used_percentage,resets_at},
     seven_day{used_percentage,resets_at},
     spend_limit{used_percentage,resets_at,used_usd,limit_usd,period}},
vim{mode}, agent{name}, pr{number,url,review_state,kind?},
worktree{name,path,branch,original_cwd,original_branch}
```

Corrections to the brief's guess:
- it is **`exceeds_200k_tokens`**, not `exceed_200k_tokens` (plural "exceeds");
- **`cost.total_cost_usd`** exists but there is **no `cost.total_tokens`** — the token totals live
  under `context_window` (`total_input_tokens` / `total_output_tokens`) and
  `context_window.current_usage`;
- `workspace` has `current_dir`/`project_dir`/`added_dirs`/`git_worktree`/`repo`, not a single path;
- `rate_limits` **does** exist, but only "for claude.ai Pro and Max subscribers, or behind a Claude
  apps gateway that sets a spend limit", and only after the first API response in the session.
  `.spend_limit` requires v2.1.251+ / v2.1.284+.

`context_window.total_input_tokens` "is the sum of `input_tokens`, `cache_creation_input_tokens`,
and `cache_read_input_tokens`" — so cache components are folded in; use `current_usage` if you want
them separate. `context_window.current_usage` is `null` before the first API call and after
`/compact`. `used_percentage`/`remaining_percentage` may be `null` early.

`cost.total_cost_usd`: "**Estimated session cost in USD, computed client-side at list price unless a
`modelPricing` table is in effect.** May differ from your actual bill. **Resets to $0 when `/clear`
starts a new session**."

### 6.3 Can an extension inject a statusLine that reports back to itself?

**Yes, mechanically** — `statusLine` is schema-valid in user settings, is honored from user settings
(not managed-only), and reloads without restart ("You change the `command` in your `statusLine`
settings" is an explicit re-run trigger; docs also note "Claude Code reloads settings automatically
and runs your script as soon as you save the file"). The script receives the JSON on stdin and can
append it to a file / POST it to `127.0.0.1:<port>` / write to a unix socket — exactly what
`ccline` (present at `~/.claude/ccline/ccline`, a 7.1 MB binary with `themes/*.toml`) does.

So a statusLine is the **best live-usage tap**: it hands you `cost.total_cost_usd`,
`context_window.current_usage`, `rate_limits`, `session_id`, `transcript_path`, `prompt_id`, and
`model.id` — every tick, already deduplicated and already priced.

**Risks — this is the important part:**

1. **Clobbering.** `statusLine` is a single object, not a list. There is no merge and no chaining.
   Writing your own command **overwrites** whatever was there (here: nothing in
   `~/.claude/settings.json` today — verified `statusLine` absent — but `ccline` is installed and a
   user could re-enable it, and `~/.claude/settings.local.json` could hold one).
   Booking-obvious mitigation: *wrap, don't replace* — read the existing `statusLine.command`, and if
   it exists, install a multiplexer that runs the old command with the same stdin and prints its
   output verbatim, tee-ing the JSON to your sink. Restore on uninstall.
2. **`disableAllHooks` kills it.** "Disable all hooks and statusLine execution" (`SCHEMA`). A user
   who sets that silently turns off your telemetry.
3. **`allowManagedHooksOnly`** can restrict hook execution in managed fleets; the statusLine is in
   the same gated set (`EXTJS` lists `statusLine` and `subagentStatusLine` alongside the credential
   helpers in the managed/keyed lists).
4. **Blocking.** "If a new update triggers while your script is still running, Claude Code
   **cancels** the in-flight script" — a slow reporter is killed mid-write; writes must be atomic
   (append + fsync, or write-temp-then-rename). `refreshInterval` min 1 s; 300 ms debounce.
5. **No terminal size, no TTY.** Output is captured; use `COLUMNS`/`LINES`.
6. **Trust.** Statusline scripts are subject to workspace-trust and the same trust gates as hooks.
7. **It only runs when a session runs.** Not a substitute for reading history.
8. **Prefer `subagentStatusLine` for per-subagent rows** — it gets a `tasks[]` array (fields `id`,
   `name`, `type`, `agentType`, `status`, `description`, `label`, `startTime`, …) once per refresh
   tick, which is the cleanest subagent-attribution surface. Same trust/`disableAllHooks`/
   `allowManagedHooksOnly` gates.

---

## 7. Risk list for an external tool rewriting `~/.claude/settings.json`

### 7.1 Does Claude Code reject unknown keys?

**No.** `SCHEMA` root is `"additionalProperties": {}` — the empty schema, which permits anything.
So an unknown top-level key is schema-legal and will not be flagged.

But "not rejected" ≠ "no consequence":

- **Wrong-typed *known* keys are skipped**, not fatal: "**Settings Warning**: only individual
  entries fail, such as a malformed permission rule or an unknown hook event name. Claude Code skips
  those values and keeps the rest of the file in effect." (`DOC:settings`)
- **Invalid JSON / a value the schema rejects** → "**Settings Error**: … At the start of an
  interactive session Claude Code shows a dialog that lets you fix the file with Claude's help, exit,
  or continue without the broken settings." That is a user-facing modal — the worst failure mode for
  a background tool. `claude doctor` lists rejected entries.
- `EXTJS` shows the extension *self-heals* known keys: it `delete`s malformed `modelPricing` rows
  and surfaces `severity:"warning"` diagnostics rather than throwing.
- A broken `~/.claude.json` (different file) is worse: it's copied to
  `~/.claude/backups/.claude.json.corrupted.<ts>` and the user is asked to exit-and-fix or reset.

⇒ **Rule: validate against `SCHEMA` before writing, and never write invalid JSON.** A half-written
file is a modal on next launch.

### 7.2 Does Claude Code rewrite the file?

**Yes, routinely** — this is the central coexistence risk.

- "When you save a choice for new sessions from inside Claude Code, such as a default model with
  `/model`, Claude Code writes it to your user settings file, `~/.claude/settings.json`."
- `/config` writes user settings; "A few `/config` options, including Show tips, save to
  `.claude/settings.local.json`".
- Permission approvals write `allow` rules to `.claude/settings.local.json` at the repo root.
- `~/.claude.json` is rewritten constantly (5 rotated backups in `~/.claude/backups/` today, latest
  2026-10-28 10:16).
- Docs even anticipate our exact scenario: *"If you can't write to that file, for example because
  **another tool generates it or links it to a read-only copy**, the change applies to the current
  session and is gone in the next one. Set the key in the tool that generates the file, or replace
  the file with one you can write to."*

⇒ Claude Code does **not** preserve comments or key order for files it writes; a round-trip through
Claude Code will reformat. **Do not store comments or non-settings metadata in
`~/.claude/settings.json`.** And do **read-modify-write atomically** (temp file in the same dir +
`rename`) so a concurrent `/config` write can't interleave into corrupt JSON.

### 7.3 Hot reload vs startup-only

Mostly **hot**: "Claude Code watches your settings files and reloads them when they change, so it
applies most edits to the running session without a restart, including edits to `permissions`,
`hooks`, and credential helpers such as `apiKeyHelper`. Claude Code also loads a settings file you
create mid-session if its folder existed when the session started." It runs the `ConfigChange` hook
per detected change.

**Startup-only keys** (explicitly called out): `model` ("use `/model` to switch mid-session"),
`effortLevel` and `modelSettings` ("use `/effort`"). Also admin keys like `requiredMinimumVersion`.
Managed settings delivered by MDM/console "reach a running session on a schedule rather than on save".

⇒ **`env`-block changes:** the docs do not say `env` is live-reloaded. Since `env` is materialized
into `process.env` at spawn, assume **new sessions only**; an already-running session keeps its old
`ANTHROPIC_BASE_URL`. State this as **UNVERIFIED for `env` specifically** (docs list `permissions`,
`hooks`, credential helpers as live; `model`/`effortLevel`/`modelSettings` as not). Practical plan:
write `env`, then tell the user to start a new session; don't promise mid-session gateway switching.

### 7.4 OAuth / credential interactions

- **`~/.claude/.credentials.json` does not exist here** (verified absent). On macOS the credential
  lives in the **login Keychain** as generic password service `"Claude Code-credentials"` (verified
  via `security find-generic-password -s "Claude Code-credentials"` → keychain
  `~/Library/Keychains/login.keychain-db`, class `genp`).
- Consequence: **a tool that "backs up credentials" by copying a file will find nothing**; don't
  assume a file. Never read/dump the Keychain item's data — treat it as opaque.
- **Mixing auth methods silently changes who bills you.** `ANTHROPIC_API_KEY` "is used **instead of**
  your Claude Pro/Max/Team/Enterprise subscription **even if you are logged in**"; in interactive
  mode you're prompted once. `ANTHROPIC_AUTH_TOKEN` sets the `Authorization` header wholesale. On
  this machine `ANTHROPIC_AUTH_TOKEN` + a localhost `ANTHROPIC_BASE_URL` means the proxy holds the
  real upstream credential — so whoever owns 127.0.0.1:15721 owns billing.
- `forceLoginMethod`/`forceLoginOrgUUID`/`forceLoginGatewayUrl` can pin or forbid a login path; a
  tool writing `forceLoginMethod` into user settings changes the login UX on next start.
- Anthropic's privacy posture: Remote Control is disabled when `ANTHROPIC_BASE_URL` isn't
  `api.anthropic.com` (v2.1.196+), and `allowedProviders` can *refuse* a custom endpoint at startup
  (§3a) — an external tool can lock a user out by mismatching these.

### 7.5 Backup conventions (observed on this machine)

- Claude Code: `~/.claude/backups/claude.json.backup.<epochMs>` — **five most recent** retained;
  docs' recovery instruction is literally "copy back one of the five most recent
  `.claude.json.backup.<timestamp>` files".
- Corruption: `~/.claude/backups/.claude.json.corrupted.<timestamp>`.
- Ad-hoc user backups: `~/.claude/backups/before-cli-restore-from-official-20260619083803/`,
  `official-login-restore-20260619083328/`.
- **cc-switch:** `~/.cc-switch/backups/db_backup_<YYYYMMDD_HHMMSS>.db` (SQLite, ~3–5 MB each, daily).

⇒ Before writing `~/.claude/settings.json`, snapshot to
`~/.claude/backups/settings.json.<tool>.<epochMs>.bak` (outside the `.claude.json` rotation so you
don't push Claude Code's own 5-deep rotation off a cliff), and keep a pruned set.

### 7.6 ⚠️ Coexistence with `cc-switch` — highest-severity risk on this machine

Verified facts:

- `cc-switch` **is running** (PID 25107) and **listening on `127.0.0.1:15721`** (`lsof -nP
  -iTCP:15721 -sTCP:LISTEN`). That is exactly the `ANTHROPIC_BASE_URL` in
  `~/.claude/settings.json`.
- `~/.cc-switch/live-state.json` → `apps.claude = {mode: "proxy", attached: true,
  proxy_route: "林夕公益站-1786504621868", contract:{version:1, key:<64-char>, exclusive:
  {CLAUDE_CODE_AUTO_MODE_SERVER: 0}}, stack:{enabled: true, members:[5], keys:{`axis-ai-deepseek-ccswitc`,
  `p178650`, `p7ec475`, `pmyclau`, `psub2ap`}}}`.
  So cc-switch runs a **multi-provider "stack"** behind one local proxy, and it explicitly claims
  `CLAUDE_CODE_AUTO_MODE_SERVER` as **exclusive**.
- `~/.cc-switch/settings.json`: `enableLocalProxy: true`, `sessionAutoSyncEnabled: true`,
  `enableFailoverToggle: true`, `enableClaudePluginIntegration: true`, `usageDashboardRefreshIntervalMs:
  60000`, `currentProviderClaude: "sub2api-1787541346952"`.
- **`~/.claude/settings.json` mtime `Oct 27 09:20:25` == `~/.cc-switch/live-state.json` mtime
  `Oct 27 09:20:25`** (settings.json written 23 s *before* `~/.cc-switch/settings.json` at
  `09:20:48`). Strong evidence **cc-switch generates `~/.claude/settings.json`**.
- The generated content is *not* a minimal patch: it rewrites all four
  `ANTHROPIC_DEFAULT_*_MODEL{,_NAME}` pairs (all pointing at one Opus alias), sets
  `CLAUDE_CODE_*`, and maintains an 18-row `modelPicker` with `replaceBuiltInOptions: true` plus
  `modelSettings` and `enabledPlugins`/`extraKnownMarketplaces`.
- It keeps its own state in a 3.6 MB SQLite db `~/.cc-switch/cc-switch.db` with tables `settings`,
  `providers`, `provider_endpoints`, `mcp_servers`, `skills`, `skill_repos`, `prompts` — i.e.
  **`~/.claude/settings.json` is a derived artifact**.

**Assessment:**

| Action by our tool | Risk |
|---|---|
| Append/modify `env.ANTHROPIC_BASE_URL` | **Very high.** cc-switch will regenerate the file on next provider switch and revert it; worse, a stale URL pointing at a proxy route that cc-switch no longer serves yields opaque 4xx/connection errors. |
| Add `statusLine` | **Medium.** Plausibly survives (cc-switch doesn't currently set `statusLine`), but a regeneration pass may drop unknown keys. Needs re-assertion + idempotency. |
| Add `hooks` | **Medium.** Same; and this user already has a `~/.claude/hooks/` dir. Use a *distinct* event+matcher and merge arrays rather than replacing. |
| Add `modelPricing` | **No-op** (§3b — ignored outside managed settings anyway). |
| Add `modelPicker` rows | **High.** Direct conflict: cc-switch owns all 18 rows and `replaceBuiltInOptions: true`; a merge means your gateway rows vanish or cc-switch's do. |
| Write `~/.claude/settings.local.json` | **Low** for per-project overrides — cc-switch doesn't appear to touch it (mtime Jul 7). Best "safe" channel for project-scoped keys, but `modelPicker` is ignored there. |
| Write `managed-settings.json` | **Low collision, high privilege.** Requires root to `/Library/Application Support/ClaudeCode/`; would strictly *override* cc-switch's user-level routing. Do not do this. |

**Recommended posture** (put this in the plan):

1. **Read-only by default** on `~/.claude/settings.json`; detect cc-switch (sentinel:
   `ANTHROPIC_BASE_URL` pointing at `127.0.0.1:<port>` in `~/.cc-switch/live-state.json`'s
   `apps.claude.proxy_route`, or the presence of `~/.cc-switch/cc-switch.db`) and **degrade to
   read-only** with an explicit message, rather than fighting it.
2. If you must write, write **`hooks` and `statusLine` only**, with **merge semantics**
   (preserve existing arrays/objects; never replace `modelPicker` or the `ANTHROPIC_DEFAULT_*`
   family), and re-assert idempotently on a timer because cc-switch may regenerate.
3. **Never** own `env.ANTHROPIC_BASE_URL`. If the tool needs a custom gateway, either let cc-switch
   own it, or write to `managed-settings.json` deliberately and take responsibility for
   `allowedProviders: ["customEndpoint"]` + pinning the URL in the same managed `env`.
4. Watch `ConfigChange` hooks to learn when someone else rewrote the file, and re-merge.
5. Back up before every write (§7.5) and validate against `SCHEMA` (§7.1).
6. Churn: `EXTJS` fingerprints
   `sha256([pluginDirs, userSettings, processWrapper, managedSettingsMtimeMs, managedDropIns])
   .slice(0,16)` where `userSettings` is *only* `userPluginSettings()` =
   `[enabledPlugins, env.CLAUDE_CODE_PLUGIN_DIRS]` — **not** the whole file. So rewriting `env`'s
   model/base-URL keys does *not* invalidate that particular cache; rewriting `enabledPlugins` does.
   Corollary: `enabledPlugins` is effectively the most cache-sensitive key in this file — leave it
   alone. Still rewrite rarely, atomically, and with stable key ordering.

---

## 8. What I could not verify (flagged)

- Whether Anthropic's VS Code extension ever supplies `modelPricing` via `Options.managedSettings`.
  (Schema + `EXTJS` key lists are consistent with it; no call site found.)
- Whether an `env`-block change hot-reloads. Docs name `permissions`/`hooks`/credential helpers as
  live and `model`/`effortLevel`/`modelSettings` as startup-only; `env` is unstated.
  **Assume new-session-only.**
- The exact `cleanupPeriodDays` in force here (default 30; transcripts reach back to June, so
  retention is longer or cleanup is disabled/lagging).
- Whether sidechain/subagent transcripts exist under `subagents/` on machines that run subagents —
  **0 such files on this machine** (all 22 are depth-2 `projects/<slug>/<sessionId>.jsonl`), so the
  `…/<sessionId>/subagents/<agentId>.jsonl` layout is documented by ccusage's
  `extract_session_parts()` (which special-cases `relative[-2] == "subagents"`) but **not
  reproducible from local data**.
- `claude_code.token.usage` / `cost.usage` exact OTLP *types* (they're counters per
  "Incremented after each API request"; assume monotonic sums).

---

## Appendix: quick reference for the implementer

**Cheapest correct token accounting from JSONL**

```
for each file in ~/.claude/projects/*/*.jsonl:
  for each line: parse JSON; skip if type != "assistant"
  skip if message.model == "<synthetic>"          # all-zero usage
  key = (message.id, requestId) if requestId else
        (message.id, sessionId,
         timestamp unless message.id startswith msg_|resp_)
  keep the record with the LARGER
       input+output+cache_creation+cache_read      # handles streamed partials
  bill: input                 * p.input
      + output                * p.output
      + cache_read            * p.cache_read
      + cache_5m              * p.cache_create     # default input*1.25
      + cache_1h              * p.input * 2.0      # CACHE_CREATE_1H_INPUT_MULTIPLIER
  where cache_5m/1h come from usage.cache_creation.ephemeral_{5m,1h}_input_tokens
  ... and fall back to the legacy flat usage.claude_cache_creation_{5,1}_h_tokens
      when usage.cache_creation is absent (29 records here)
  project path = cwd from records, NOT the <slug> directory
```

**Three live/latent surfaces, ranked**

1. `statusLine` (push, precomputed cost, dedup'd, has `rate_limits`) — but single-slot; wrap, don't
   replace.
2. `~/.claude.json` → `projects[<abs cwd>].lastCost` / `lastTotal*Tokens` (already aggregated,
   survives even if you never parse a transcript).
3. OTel (push, real-time, but no 5m/1h split, requires settings writes, ships `user.email`).
