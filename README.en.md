# dsh-token-metrics

[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)](package.json)

[中文](README.md) | **English**

A DeepSeek Harness plugin that records every model call that goes through DSH and gives you a Token usage panel in the sidebar.

Once installed, you can see the following metrics:

- Token totals for today, the last 7 days, and all time, plus the trend direction
- Usage ranking by model and by provider
- Cache hit rate — whether you are paying to re-read the same input
- Token spend by project and by subagent

The data comes from DSH's own session logs. The plugin sends no extra requests and uploads nothing.

## Install

From inside DSH:

```
plugin_manager install_bundle /path/to/dsh-token-metrics
```

Or add it to your profile's `package.json` by hand:

```json
{
  "dsh": { "profile": { "bundles": ["dsh-token-metrics"] } },
  "dependencies": { "dsh-token-metrics": "link:/path/to/dsh-token-metrics" }
}
```

Restart DSH and a "Token Usage Stats" icon appears in the sidebar.

The first time you open the panel, the plugin backfills your existing session logs so your earlier usage shows up too.

## Screenshot

The "Token Usage Stats" page in the sidebar: time range and model filters on top, eight summary metrics below them, then the trend chart and model-share donut, and finally a detail table you can switch between model / origin / project / provider / account / date views.

![Token usage stats page](docs/images/panel.png)

## What the panel shows

- **Totals**: input / output / cacheRead / cacheWrite / reasoning / total / call count / cache hit rate
- **Time ranges**: today, last 7 days, all time
- **Charts**: one switchable main trend chart (total / hit rate / input breakdown / **by model** — smooth curves, hover for exact values) plus a donut chart of model share
- **Model filter**: a multi-select dropdown — pick one model, several, or clear the selection; metric cards and the trend chart refresh together
- **Model merging**: the donut and trend merge by **model name** across providers, while the detail table still splits by provider
- **Chart colors**: category colors ship light and dark values and follow the theme
- **Version indicator**: the version number in the top-right corner is itself a button — click it to check for updates and get the result in a dialog (with a one-click update when one exists, or the current version when up to date). The status light reads green = up to date / blue = update available / grey = not checked
- **Detail tables**: switch between model / origin / project / provider / account / date views. Per-session detail is hidden by default and can be enabled
- **Account bar**: the signed-in account, its balance, and a link to the official usage page
- **Failed requests**: hidden by default; enable `trackFailedAttempts` to see them
- **Startup backfill**: on first install it scans existing session logs to fill in history, showing scan progress
- **Persistence**: nothing is lost across restarts, totals accumulate across sessions
- **Localization**: follows the DSH language setting, switches instantly
- **Self-update**: check for a new version, install, hot-reload, and roll back on failure
- **Zero runtime dependencies**: no build step, no `npm install`

## Configuration

Every option has a default. To change one, add an override with the same id in your own profile's `cordis.patch.yml`:

```yaml
- id: token-metrics
  config:
    showSessions: true
    snapshotCacheMs: 5000
```

Note that an override with the same id **replaces the whole `config`** rather than merging field by field. If you set a few keys, write out the rest too, or keep to the keys you need and let the others fall back to defaults.

| Option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `flushDelayMs` | `2000` | 250–60000 | Disk write debounce in ms. Recording a call is cheap; writing to disk is the real cost |
| `snapshotCacheMs` | `3000` | 0–60000 | How long to cache the aggregate snapshot. `0` recomputes every time |
| `retentionDays` | `400` | 0–3650 | Days of per-day buckets to keep. `0` means never prune |
| `maxSessions` | `500` | 0–5000 | Cap on session detail rows returned to the panel |
| `maxTrendSeries` | `6` | 1–20 | Max model lines drawn in the trend chart; the rest fold into "other" |
| `maxSeenEntries` | `200000` | 1000–2000000 | Cap on the dedupe table |
| `showSessions` | `false` | — | Whether to show the per-session detail view |
| `trackFailedAttempts` | `false` | — | Whether to track failed requests. See "Failed requests" below |
| `trackAccount` | `true` | — | Read the signed-in account and balance (read-only, never touches credentials) |
| `autoUpdate` | `true` | — | Enable self-update |
| `watchFiles` | `false` | — | Watch the package directory and hot-reload on file changes. For development |

## HTTP endpoints

The service runs inside the host process on the DSH port. The panel has buttons for all of these, but you can call them directly:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/dsh-token-metrics/summary` | Aggregate snapshot; the panel's data source |
| `GET` | `/api/dsh-token-metrics/flush` | Flush to disk immediately and return a fresh snapshot |
| `GET` | `/api/dsh-token-metrics/version` | Current version and update status |
| `GET` | `/api/dsh-token-metrics/update/check` | Check for a new version |
| `POST` | `/api/dsh-token-metrics/update/apply` | Install a new version and hot-reload |
| `POST` | `/api/dsh-token-metrics/reload` | Hot-reload the code currently on disk |
| `POST` | `/api/dsh-token-metrics/rebuild` | Recompute all statistics from session logs |

Manual recompute:

```bash
curl -X POST http://127.0.0.1:53414/api/dsh-token-metrics/rebuild
```

## How counting works

The source of truth is DSH's session log. Every completed model call appends an `assistant/message` event carrying:

- `data.message.source.{provider, model}` — what was called
- `data.usage` — `inputTokens` / `outputTokens` / `totalTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`
- `data.turn` / `data.step` — a natural dedupe key
- `event.time` — for per-day bucketing

So the coverage is:

| Case | Counted | Why |
| --- | --- | --- |
| Main session turns | Yes | The log has `assistant/message` |
| Subagents / teammates | Yes | Each has its own session log |
| workflow sub-sessions | Yes | Same as above |
| Compaction | Yes | Captured via the `llm/stream` fallback |
| Session title generation | Yes | Captured via the `llm/stream` fallback |
| Failed request attempts | No | `assistant/attempt` is a retry intermediate state; counting it would double-count |

## Cache hit rate

```
hit rate = cacheReadTokens / (cacheReadTokens + inputTokens)
```

`inputTokens` is the newly read, uncached portion and `cacheReadTokens` is the cached portion; the two together are the call's full input. `cacheWriteTokens` is what was written into the cache and is **not** part of the denominator — including it would understate the hit rate.

## Account attribution

**Historical usage cannot be attributed to an account.** In the session log, the structured fields of `assistant/message` are only `turn / step / message / usage / stream`, and `message.source` only has `kind / provider / model / replayState`. There is no `accountId`, `userId`, or `keyId`. That is a hard limit of the data source.

So the account dimension works like this:

- The plugin reads the signed-in account (`deepseekAccount.getProfile` / `getBalance`, **read-only, never touches credentials**), shows it at the top of the panel, and links to the official usage page
- Each recorded call carries the account known *at that time*, so usage **after** switching accounts lands on the new account
- Usage from before the switch is grouped as "unknown"
- The `usageUrl` page is the billing reference; local statistics are for trends and attribution

Set `trackAccount: false` to stop the plugin reading account information.

## Localization

The panel text is registered through the host's locale service, so it follows the DSH language setting (Chinese / English) and **switches instantly at runtime** with no page reload.

Two easy traps, both handled:

- The current-language field of `LocaleSnapshot` is **`active`** (not `locale` or `id`). An earlier version read the wrong field, so the language always fell back to the default and never followed the setting.
- Reading the language once at registration time is not enough: the panel must subscribe to `ctx.locale.subscribe`, otherwise an already-open page will not re-render when the language changes.

## Model scope: merged vs split

The same model can sit under several providers (for example `deepseek-v4.1-flash` appears under trae / workbuddy / dshlinux / workbuddy-ai). The plugin keeps two scopes:

| View | Scope | Purpose |
| --- | --- | --- |
| `byModelName` / donut chart / trend chart | **Merged by model name** | Several curves for one model collapse into one; otherwise the chart shows four identically named lines and the share gets split apart |
| `byModel` / detail table | **Split by provider** | Use this when you need to tell which channel the money went to |

The two scopes always total exactly the same — they are just different groupings of the same events.

## Cross-platform support

The plugin never calls a shell or a system command and builds every path with `node:path`, so **macOS, Windows, Linux, and DSH on the web all work**:

| Platform | Supported | Notes |
| --- | --- | --- |
| macOS | ✅ | Development and verification environment |
| Windows | ✅ | `rename` retries during updates, see below |
| Linux | ✅ | `fs.watch(recursive)` needs Node ≥ 20; `engines` already requires ≥ 22.19 |
| DSH on the web | ✅ | Only depends on the host's `webServer` route; everything else still works without it |

**Windows-specific handling**: a running Node process locks module files, so a plain `rename` throws `EPERM`/`EACCES` (macOS/Linux do not). The updater retries such locks with backoff and still throws non-retryable errors rather than masking real problems.

Session logs are read with Node's built-in `zstdDecompressSync` (a cross-platform pure JS/C++ implementation), not the system `zstd` command.

## When the "Reload plugin" button appears

It is **hidden by default** and shows in exactly one case: **the code on disk has changed but the running instance is still the old version** (`versionMismatch: true`).

The reason: the update flow already includes a hot reload (download → replace → automatic `selfReload`), so the button would be redundant day to day. Its real purpose is **recovery** — for example a failed activation after an update, or a manual edit to `index.js` on disk, where an explicit reload is needed to load the new code.

The signal comes from the host's `updater.status().versionMismatch`: it compares the version the module declares and runs against the version in `package.json` on disk, and a difference means a reload is needed.

## Chart colors

Chart category colors deliberately avoid the `--dsw-alias-*` semantic tokens: those express **state** (success / warning / error), not categories, and in dark themes `brand-primary` renders nearly white, which would draw a white arc in the donut chart.

Category colors therefore use the plugin's own `--tu-c1..7`, with light and dark values in the stylesheet (`[data-theme='dark']` overrides). Light mode gets medium saturation and dark mode is brightened overall, so adjacent colors stay distinguishable.

## Failed requests

`assistant/attempt` is the intermediate state of a failed retry and should in theory consume tokens. But every adapter currently reports `{0,0,0}` usage on that path — across 259 observed failed attempts and 243 usage records, all zero.

So failed requests normally have a **count** and no tokens. The channel is kept open: if upstream ever starts reporting non-zero usage, those tokens will appear in the panel automatically with no code change. The panel labels this limit explicitly so you do not mistakenly think failed requests are free.

The section is hidden by default and the count is still accumulated internally. To see it, set `trackFailedAttempts` to `true`: once upstream reports real usage, the data appears on its own.

## FAQ

**The panel is empty.**
The first open waits for the backfill scan — a few seconds, up to tens of seconds depending on how many sessions you have. See "Startup backfill" above.

**Where did my history go after switching accounts?**
It is grouped as "unknown". See "Account attribution" above: the log has no account field, so it cannot be recovered.

**The numbers do not match the official bill.**
Local statistics count from session logs; the official bill counts actual charges. Different definitions. Trust the official page for billing, use the local panel for trends.

**What if an update fails?**
The plugin reports the error clearly and rolls back. Hot reload depends on Cordis internals and may break after a DSH or Node upgrade; restart DSH in that case.

**Does it slow DSH down?**
No. See "Performance" below.

## Performance

Counting has two paths with very different costs:

| Path | Trigger | Measured cost |
| --- | --- | --- |
| `record()` one call | Every model step | ~0.9 µs |
| Unrelated events (tool/call, etc.) | The vast majority of the log | ~0.02 µs |
| `snapshot()` cache hit | Every panel poll | ~0.0002 µs |
| `snapshot()` cold compute | First time after new data | ~3–5 ms |
| `flush()` to disk | Every 2 s (debounced) | ~6 ms |

The optimizations:

- **Snapshot cache**: the aggregate only changes when a new call arrives; caching it takes polls from 3 ms to nearly zero
- **Write debounce**: many calls coalesce into one disk write
- **Slower pruning**: clearing expired data walks the whole dedupe table, so it runs at most once a minute
- **Tunable polling**: 10 s / 30 s / 1 min / 5 min / off, remembered in localStorage; polling stops while the page is hidden

So the real cost of "live statistics" is disk and polling, not counting — and both are bounded.

## Startup backfill: how history is filled in

**Usable the moment you install.** On startup the plugin scans all existing session logs, so you see your past usage immediately instead of accumulating from zero.

Scan progress appears in the panel: a spinner plus "Scanning past sessions" and an `12 / 27 scanned` progress bar. When the total is unknown the bar uses a looping animation to mean "in progress" rather than pretending to know a percentage.

Three scan paths (whichever one is available finishes the scan):

1. `sessionPersistence` — read through the host service, the fastest
2. Polling the same service — covers the case where it comes up late
3. **Reading from disk** — decompressing `.jsonl.zstd` session logs directly, depending on no host service, so history is always recoverable even if the first two are unavailable

The scan is incremental: each session records the sequence number it has processed (`scanned[id].seq`), so later startups only handle new events instead of rescanning everything.

## Data file

```
$DSH_HOME/token-metrics/usage.json
```

**History is never discarded when consistency is in doubt.** An earlier implementation zeroed and rebuilt whenever the `calls` count disagreed with the dedupe key count — but rebuilding depends on `sessionPersistence`, and if that service is invisible in some combination, the history is lost forever. The current behavior:

1. Mark `needsRebuild` and **keep the existing data as-is**
2. Rebuild and clear the flag once the rescan succeeds; keep accumulating on the existing data if the rescan fails
3. The rescan has three paths, **one of which reads session logs straight from disk** (decompressing `.jsonl.zstd` with Node's built-in `zstdDecompressSync`), depending on no host service — so history can always be rebuilt

Writes use a 1.5 s debounce plus atomic replacement via a temp file, so calls do not touch the disk every time and an interrupted process never leaves half-written JSON. A corrupt file or version mismatch reinitializes cleanly instead of failing plugin startup.

Per-day buckets are kept for 400 days; the dedupe table holds at most 200,000 keys.

## Implementation notes

**Two data paths, one dedupe key.** The main path listens on `session/event` and captures `assistant/message` and `session/title`. The fallback wraps the `llm/stream` waterfall and only handles calls that never hit the log (compaction, title generation, session-less direct calls); everything else is passed straight through with `return next()`.

Both paths dedupe on `(sessionId, turn, step)`, so live increments and the startup backfill never double-count, a repeated event delivery still counts once, and a post-restart rescan is idempotent.

**The backfill is incremental by seq.** `scanned[sessionId] = { revision, seq }`: an unchanged revision is skipped; a changed one resumes after the last processed seq instead of rescanning the whole session.

**A process-level singleton.** Host hot reload loads a second module instance that also calls `apply()`. If each instance kept its own tracker, the same event would be counted twice and the two instances would overwrite each other's flushes. So the tracker lives on `globalThis` and is reused or replaced based on `buildId` (derived from `index.js`'s own size and mtime): unchanged code is reused and does not double-count, changed code hands over to a new instance immediately.

**Self-check and self-heal.** Normally `total.calls` strictly equals the dedupe key count. The API returns `integrity` for the panel to judge; a historical file off by more than 10% is discarded at startup and rebuilt from session logs rather than accumulating on top of bad data.

**The exit flush installs one listener only.** Hot reload calls `apply()` many times, and installing `beforeExit` each time would accumulate listeners and hold on to discarded trackers. There is now one global listener pointing at the current tracker.

## Self-update and hot reload

The plugin ships an update channel that does not depend on pnpm:

```
check for a new version → download → verify → backup → replace → hot reload → roll back on failure
```

The safety design:

- **The update source is fixed to `package.json`'s `repository`** and accepts no URL from configuration or a request. Letting a config option point anywhere is one step from "write a field" to "execute arbitrary code in the host process"
- Version comparison uses real semver precedence (prereleases before releases)
- Extracting the downloaded tarball checks for path traversal and rejects `..` and absolute paths
- The whole package directory is backed up before replacement; a failed activation rolls back both disk and runtime instead of leaving a half-installed state
- Hot reload verifies the version of the replacement code with `expectedVersion`, ensuring the new code actually runs rather than a stale cached object

### The limits of hot reload

Hot reload depends on Cordis internals (`loader.internal`, `registry`, `fiber`). With no official "reload this plugin" API in DSH, this is the only path not blocked by `already-installed`. If a Node upgrade changes the shape of the module cache, `reload` **fails loudly and says why** instead of quietly keeping the old code — restart DSH in that case.

## Development

```bash
npm run check    # syntax check + all three test suites
npm test         # host + client + updater
npm run verify   # independent comparison against real session logs (needs the host running)
```

The host suite drives `apply()` with a fake ctx and covers event signatures, dedupe, historical backfill, cross-restart idempotence, the hot-reload singleton, buildId handover, and dedupe-table pruning. The client suite drives the factory with a fake ModuleLoader and fake React and covers slot registration, bilingual text key parity, and theme-token-only styling. The updater suite covers version comparison, repository parsing, tarball extraction safety, and backup/rollback.

No runtime dependencies, no `npm install` needed, no build step.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host side: listeners, aggregation, backfill, account snapshot, HTTP endpoints |
| `client.js` | Client side: sidebar entry + statistics panel |
| `src/updater.js` | Self-update: version check, download verification, backup and rollback |
| `src/reload.js` | Hot reload: module cache purge and fiber replacement |
| `cordis.patch.yml` | Bundle patch that inserts the plugin row |
| `locale/{zh,en}.json` | Title and description shown in Plugin Manager |
| `icon.svg` | Plugin icon |
| `test/` | Suites: host integration, client smoke, updater, metadata, log comparison |

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). For security reports, see [SECURITY.md](SECURITY.md).

If this plugin is useful to you, a Star ⭐ is the most direct way to support the project.

## License

[MIT](LICENSE)

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
