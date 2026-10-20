/**
 * Token 用量统计 —— Host 侧。
 *
 * ## 数据模型
 *
 * 会话日志是唯一权威来源（DSH 的既有约束）。每一次完成的模型调用都会在
 * 会话日志里追加一条 `assistant/message` 事件，它带：
 *   - `data.message.source.{provider, model}`
 *   - `data.usage: { inputTokens, outputTokens, totalTokens, cacheReadTokens,
 *                    cacheWriteTokens, reasoningTokens }`
 *   - `data.turn` / `data.step`（天然去重键）
 *   - `event.time`（用于按天分桶）
 *
 * 所以统计口径是「日志里有据可查的每一次模型调用」，这带来三个好处：
 *   1. 实时增量与启动回扫用**同一个去重键**，绝不会重复计数；
 *   2. 子代理 / teammate / workflow 子会话各有自己的会话日志，自动纳入；
 *   3. 进程重启后数据不丢，历史会话可补算。
 *
 * ## 补充通路
 *
 * 少数调用不落 `assistant/message`：会话标题生成（purpose:
 * 'session-title'）和压缩（purpose: 'compaction'），以及其它插件直接
 * `ctx.llm.stream()` 且不带 sessionId 的调用。这些由 `llm/stream`
 * waterfall 补齐，用 (sessionId, purpose, 秒级时间片) 去重。
 *
 * ## 持久化
 *
 * 插件自己的 JSON 文件，位于 `$DSH_HOME/token-metrics/usage.json`。
 * 写入防抖 + 临时文件原子替换，避免每次调用都碰磁盘。
 *
 * ## 单例
 *
 * 宿主热重载会加载第二份模块实例。tracker 挂在 `globalThis` 上按
 * buildId 复用或替换：同一份代码只记一次，源码变更则接管并生效。
 * 详见 {@link acquireTracker}。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { PluginUpdater, parseRepository } from './src/updater.js'
import { isReloading, selfReload, watchPackage } from './src/reload.js'
import { PriceBook, costOf, resolvePrice, isOffPeak } from './src/pricing.js'
import { BalanceBook, probeBalance, normalizeBaseUrl, discoverModels } from './src/balance.js'
import { syncProviderToDsh, defaultKeyEnvName } from './src/sync.js'
import { probeOfficial, detectProvider, loadModelCatalog } from './src/providers.js'
import { createPushHub, evaluateAlerts, evaluateBudgetAlerts, diffAlerts } from './src/push.js'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-token-metrics'

/**
 * 本模块声明的版本。
 *
 * selfReload 在激活前会拿它和「期望版本」比对，确保替换上去的确实是新代码，
 * 而不是缓存里的旧对象。因此这个值必须跟着 package.json 一起更新。
 */
export const version = '0.3.0'

/** 本包目录（file:// URL，带尾斜杠），热重载与自更新用它定位文件。 */
const PACKAGE_URL = new URL('./', import.meta.url).href
const ENTRY_URL = new URL('./index.js', import.meta.url).href
const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * 本次模块实例的构建标识。
 *
 * 宿主热重载时会同时存在新旧两份模块实例。用文件自身的大小与修改时间
 * 派生标识：源码未变 → 标识相同 → 复用同一 tracker（不重复计数）；
 * 源码已变 → 标识不同 → 换上新实例（修改立即生效）。
 */
/**
 * 构建标识：入口文件与 src/ 下所有模块的 (大小, mtime) 汇总。
 *
 * 只看 index.js 的话，改了 src/balance.js 之类的模块后 buildId 不变，
 * 缓存判定会认为「代码没变」而继续跑旧模块——热重载看似成功、行为却是旧的。
 */
const BUILD_ID = (() => {
  const parts = []
  try {
    const entryPath = fileURLToPath(new URL(import.meta.url))
    const entryStat = statSync(entryPath)
    parts.push(`${entryStat.size}:${Math.floor(entryStat.mtimeMs)}`)
    try {
      const srcDir = join(dirname(entryPath), 'src')
      for (const name of readdirSync(srcDir).sort()) {
        if (!name.endsWith('.js')) continue
        const stat = statSync(join(srcDir, name))
        parts.push(`${name}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
      }
    } catch { /* 没有 src 目录就只用入口文件 */ }
    return parts.join('|')
  } catch {
    return 'unknown'
  }
})()

/** 数据文件版本；结构变化时递增，旧文件会被重新初始化。 */
const STORE_VERSION = 1

/**
 * 默认配置。全部可在 cordis.patch.yml 的 `config` 里覆盖，
 * 用户的自定义层在升级后依然保留。
 */
/**
 * 数据结构版本号。
 *
 * 每新增一类分桶（byDayModel / byModelFacets / byDayFacets / byDayPeak …）
 * 就递增。回扫成功补齐后写入 store，之后不再重复判断——靠「桶是否为空」
 * 猜测会把「刚重建完但该时段没有此类调用」误判成「还没迁移」，
 * 每次启动都白跑一次全量回扫。
 */
const SCHEMA_VERSION = 2

const DEFAULTS = {
  /** 落盘防抖（毫秒）。模型调用本身很轻，磁盘写入才是开销。 */
  flushDelayMs: 2000,
  /** 聚合快照的缓存时长（毫秒）。轮询频繁时避免重复计算。 */
  snapshotCacheMs: 3000,
  /** 按天分桶保留天数，0 表示不裁剪。 */
  retentionDays: 400,
  /** 统计页返回的会话明细上限。 */
  maxSessions: 500,
  /**
   * 告警阈值。
   *
   * 余额低于 `balanceLowUsd`、或配额窗口剩余低于 `quotaLowPercent` 时，
   * 通过右下角通知提醒。设为 0 可关闭对应告警。
   */
  alertThresholds: { balanceLowUsd: 5, quotaLowPercent: 10 },

  /**
   * 预算（美元）。设为 0 表示不启用该档。
   *
   * 与「余额」是两回事：余额看账户还剩多少，预算看这段时间花得快不快。
   * 账户里还有 $60，但今天已经花了 $9 / 日预算 $10 —— 只有预算提醒得到。
   *
   * `groups` 支持按模型分组管理预算：一个分组可包含单个或多个模型，
   * 分组内预算是这些模型的合计额度。
   *
   *   groups:
   *     - label: 日常编码
   *       models: [deepseek-flash]
   *       dailyUsd: 3
   *       monthlyUsd: 50
   *     - label: 重活
   *       models: [claude-opus-5, gpt-5.5]
   *       monthlyUsd: 120
   */
  budget: { dailyUsd: 0, monthlyUsd: 0, warnPercent: 80, groups: [] },

  /**
   * 模型别名映射：`{ "qfmodel": "deepseek-v4.1-flash" }`。
   *
   * 部分 provider 上报的是内部队列代号而不是真实模型名，这些代号无法从
   * DSH 元数据反查，只能由用户指定。界面维护的别名会覆盖这里的值。
   */
  modelAliases: {},

  /** 趋势图最多画多少条模型曲线（超出部分聚合为「其他」）。 */
  maxTrendSeries: 6,

  /** 去重表上限。 */
  maxSeenEntries: 200_000,
  /** 是否在页面展示「按会话」明细；默认关闭，会话维度对总量统计意义不大。 */
  showSessions: false,
  /**
   * 是否统计失败请求。
   *
   * 默认关闭：当前所有适配器在失败路径上都只上报全 0 的 usage，所以这个
   * 维度只能给出次数、给不出 token 消耗。等上游开始上报真实用量后再打开。
   */
  trackFailedAttempts: false,
  /** 是否读取登录账号的身份与余额（只读，不碰凭据）。 */
  trackAccount: true,
  /** 是否装配自更新（检查新版本、安装、热重载）。 */
  autoUpdate: true,
  /** 是否在启动时监视包目录、文件变化即热重载（开发用，默认关闭）。 */
  watchFiles: false,
}

/** 读取并规整配置。 */
function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const number = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
  }
  return {
    flushDelayMs: number(source.flushDelayMs, DEFAULTS.flushDelayMs, 250, 60_000),
    snapshotCacheMs: number(source.snapshotCacheMs, DEFAULTS.snapshotCacheMs, 0, 60_000),
    retentionDays: number(source.retentionDays, DEFAULTS.retentionDays, 0, 3650),
    maxSessions: number(source.maxSessions, DEFAULTS.maxSessions, 0, 5000),
    maxTrendSeries: number(source.maxTrendSeries, DEFAULTS.maxTrendSeries, 1, 20),
    // 只接受字符串到字符串的映射，其余忽略
    modelAliases: (() => {
      const raw = source.modelAliases !== null && typeof source.modelAliases === 'object'
        ? source.modelAliases
        : {}
      const out = {}
      for (const [from, to] of Object.entries(raw)) {
        if (typeof from === 'string' && from !== '' && typeof to === 'string' && to !== '') {
          out[from.trim()] = to.trim()
        }
      }
      return out
    })(),
    alertThresholds: (() => {
      const raw = source.alertThresholds !== null && typeof source.alertThresholds === 'object'
        ? source.alertThresholds
        : {}
      return {
        balanceLowUsd: number(raw.balanceLowUsd, DEFAULTS.alertThresholds.balanceLowUsd, 0, 1e6),
        quotaLowPercent: number(raw.quotaLowPercent, DEFAULTS.alertThresholds.quotaLowPercent, 0, 100),
      }
    })(),

    /**
     * 预算（美元）。0 表示该档不启用。
     *
     * 用 float 而不是取整：预算可以是 $2.50 这种小额。
     */
    budget: (() => {
      const raw = source.budget !== null && typeof source.budget === 'object' ? source.budget : {}
      const money = (value, fallback) => {
        const parsed = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(parsed) || parsed < 0) return fallback
        return Math.min(1e7, parsed)
      }
      // 分组预算：每组一个名字 + 模型清单 + 额度。
      // 模型名按「用户填什么就匹配什么」，同时兼容别名后的显示名。
      const groups = Array.isArray(raw.groups)
        ? raw.groups
          .map((entry, index) => {
            if (entry === null || typeof entry !== 'object') return undefined
            const models = Array.isArray(entry.models)
              ? entry.models.filter((name) => typeof name === 'string' && name.trim() !== '')
                .map((name) => name.trim())
              : []
            if (models.length === 0) return undefined
            return {
              id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `group-${index + 1}`,
              label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : `分组 ${index + 1}`,
              models,
              dailyUsd: money(entry.dailyUsd, 0),
              monthlyUsd: money(entry.monthlyUsd, 0),
            }
          })
          .filter((entry) => entry !== undefined)
        : []
      return {
        dailyUsd: money(raw.dailyUsd, DEFAULTS.budget.dailyUsd),
        monthlyUsd: money(raw.monthlyUsd, DEFAULTS.budget.monthlyUsd),
        warnPercent: number(raw.warnPercent, DEFAULTS.budget.warnPercent, 1, 100),
        groups,
      }
    })(),

    maxSeenEntries: number(source.maxSeenEntries, DEFAULTS.maxSeenEntries, 1000, 2_000_000),
    showSessions: source.showSessions === true,
    trackFailedAttempts: source.trackFailedAttempts === true,
    trackAccount: source.trackAccount !== false,
    autoUpdate: source.autoUpdate !== false,
    watchFiles: source.watchFiles === true,
  }
}

/**
 * 插件数据目录。
 *
 * 账本放在 `token-metrics/` 下，与注册 id 保持一致。
 *
 * 目录名变过两次（`token-usage` → `token-usage-stats` → `token-metrics`），
 * 而变化不能丢历史：这里按「新到旧」的顺序找可接管的账本，旧目录下若有本插件
 * 格式的账本、而新目录还是空的，就复制过来。用复制而不是移动，旧文件保留作
 * 备份；接管失败就继续沿用它，宁可沿用旧路径，也不让用量永久消失。
 *
 * 接管前必须确认旧文件确实是本插件的账本：那些目录名并非本插件独占，盲目
 * 复制会把别人的数据当成自己的读。校验方式是本格式独有的字段组合
 * （version + seen + total + byDay），不匹配就当作与己无关，不去碰它。
 */
const DIR_NAME = 'token-metrics'
/** 历史目录名，按从新到旧排列；接管时依次尝试。 */
const LEGACY_DIR_NAMES = ['token-usage-stats', 'token-usage']

/** 旧目录里的文件看起来是不是本插件的账本。 */
function isOwnStore(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object'
      && parsed.version === STORE_VERSION
      && typeof parsed.seen === 'object' && parsed.seen !== null
      && typeof parsed.total === 'object' && parsed.total !== null
      && typeof parsed.byDay === 'object' && parsed.byDay !== null
  } catch {
    return false
  }
}

function dataDir(home) {
  const root = home ?? process.env.DSH_HOME?.trim() ?? join(homedir(), '.dsh')
  const next = join(root, DIR_NAME)
  const nextStore = join(next, 'usage.json')

  // 新目录已有数据 → 正常工作，无需接管。
  if (existsSync(nextStore)) return next

  // 依次尝试历史目录：哪一份是本插件格式的账本，就接管哪一份。
  for (const legacy of LEGACY_DIR_NAMES) {
    const previous = join(root, legacy)
    const previousStore = join(previous, 'usage.json')
    // 没有数据，或那份数据不是本插件的 → 看下一个。
    if (!existsSync(previousStore) || !isOwnStore(previousStore)) continue
    try {
      mkdirSync(next, { recursive: true })
      copyFileSync(previousStore, nextStore)
      return next
    } catch {
      // 接管失败：继续沿用它，不因为目录名不同而让历史消失。
      return previous
    }
  }

  return next
}

function storePath(home) {
  return join(dataDir(home), 'usage.json')
}

/** 空的用量计数器。 */
function emptyCounters() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

/**
 * 缓存命中率。
 *
 * 口径：命中 token / 可缓存输入 token。
 * 可缓存输入 = inputTokens + cacheReadTokens —— inputTokens 是真正新读入
 * 的（未命中）部分，cacheReadTokens 是命中缓存的部分，两者相加才是这次
 * 调用消费的全部输入。cacheWriteTokens 是写入缓存的量，不计入分母，
 * 否则会把命中率压低。
 */
function cacheHitRate(counters) {
  if (counters === undefined || counters === null) return 0
  const read = counters.cacheReadTokens ?? 0
  const input = counters.inputTokens ?? 0
  const denominator = read + input
  if (denominator <= 0) return 0
  return read / denominator
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 把一个 TokenUsage 累加进计数器。 */
function addUsage(counters, usage) {
  if (usage === undefined || usage === null || typeof usage !== 'object') return
  const input = finite(usage.inputTokens)
  const output = finite(usage.outputTokens)
  const cacheRead = finite(usage.cacheReadTokens)
  const cacheWrite = finite(usage.cacheWriteTokens)
  const reasoning = finite(usage.reasoningTokens)
  // 部分适配器不报 totalTokens；用各项之和兜底，避免总量偏小。
  const total = finite(usage.totalTokens) || input + output + cacheRead + cacheWrite
  counters.calls += 1
  counters.inputTokens += input
  counters.outputTokens += output
  counters.cacheReadTokens += cacheRead
  counters.cacheWriteTokens += cacheWrite
  counters.reasoningTokens += reasoning
  counters.totalTokens += total
}

/** 合并计数器（就地修改 target）。 */
function mergeCounters(target, source) {
  if (source === undefined || source === null) return target
  for (const key of Object.keys(emptyCounters())) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) target[key] += value
  }
  return target
}

/** 本地日期键 YYYY-MM-DD（用户本地时区，不是 UTC）。 */
function dayKey(time) {
  const d = new Date(time)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 空存储。 */
function emptyStore(buildId) {
  return {
    version: STORE_VERSION,
    buildId,
    /** 一致性存疑时的标记；回扫重建成功后清除。 */
    needsRebuild: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    /** 去重键 -> 记录时间。只保留键本身，节省空间。 */
    seen: {},
    /** 全部时间总计。 */
    total: emptyCounters(),
    /** day -> counters。 */
    byDay: {},
    /** provider -> counters。 */
    byProvider: {},
    /** `${provider}/${model}` -> counters。明细表按供应商拆分时用它。 */
    byModel: {},
    /**
     * day -> 各维度 -> 名称 -> counters。
     *
     * 供前端把「今日 / 近 7 天 / 全部」应用到供应商、项目、来源、账号
     * 这些明细上。没有它，切时间段时只有指标卡在变，表格和图表不动。
     */
    byDayFacets: {},
    /**
     * day -> `${provider}/${model}` -> { peak, off }。
     *
     * 与 byModelPeak 同构但按天拆分，供「今日/近 7 天」的金额卡片
     * 精确套用峰谷价。
     */
    byDayPeak: {},
    /**
     * `${provider}/${model}` -> { peak, off } 两份 counters。
     *
     * 只对分时段计价的厂商（目前是 DeepSeek 系）记录。成本按两桶分别套用
     * 峰时/谷时单价，否则谷时调用会被按峰时价高估最多一倍。
     */
    byModelPeak: {},
    /**
     * 数据结构版本号，见 loadStore 里的说明。
     *
     * 全新库直接标为当前版本：没有历史数据要迁移，不该触发重建。
     */
    schemaVersion: SCHEMA_VERSION,
    /**
     * 模型名（不含 provider）-> counters。
     *
     * 同一个模型可能挂在多个供应商下（例如 deepseek-v4.1-flash 同时出现在
     * trae / workbuddy / dshlinux）。占比图与趋势图要按「模型」看总量，
     * 因此这里做跨供应商合并；需要拆开时看上面的 byModel。
     */
    byModelName: {},
    /**
     * 按天 × 模型：day -> `${provider}/${model}` -> counters。
     *
     * 用于「每日用量趋势按模型拆分」——只靠 byDay 画不出各模型的曲线。
     * 保留的量级可控：天数（默认 400）× 模型数（通常 <30）。
     */
    byDayModel: {},
    /** 按天 × 模型名（跨 provider 合并），趋势图按模型筛选时用它。 */
    byDayModelName: {},
    /**
     * 按模型名分组的全维度明细。
     *
     * 结构：`modelName -> { provider: {k: counters}, project: {...},
     *                       origin: {...}, account: {...}, day: {...} }`
     *
     * 前端按模型筛选时，明细表与占比图都需要「只属于该模型」的各维度数据。
     * 若不为每个维度各开一套全局桶，筛选后就没有可用的数据源——这正是
     * 「只有卡片刷新、图表和明细不动」的根因。
     */
    byModelFacets: {},
    /** sessionId -> { counters, provider, model, title, parentSession, firstAt, lastAt } */
    bySession: {},
    /** 工作区目录 -> counters。用于回答「这个项目花了多少 token」。 */
    byProject: {},
    /** 会话来源（main / subagent / workflow）-> counters。 */
    byOrigin: {},
    /**
     * 失败请求记录。
     *
     * `assistant/attempt` 是失败重试的中间态，理论上会消耗 token。但目前
     * 所有适配器在这条路径上都只上报全 0 的 usage，所以这里通常只有计数、
     * 没有 token。保留字段是为了适配器将来上报时能直接生效。
     */
    failedAttempts: { count: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    /** 失败尝试的去重表（回扫幂等用），与统计字段分开存放。 */
    failedSeen: {},
    /**
     * 账号用量分段。
     *
     * 日志里没有账号归属，所以历史数据无法回溯到某个账号。这里按「首次
     * 观察到某账号的时间点」分段：切换账号之后新增的调用记到新账号下，
     * 之前的数据保持原样（归属为当时记录的账号或「未知」）。
     */
    accounts: {},
    /** 当前账号快照（由 Host 侧定期刷新，仅用于展示）。 */
    currentAccount: null,
    /**
     * 已回扫会话：sessionId -> { revision, seq }。
     * seq 是已处理到的最大事件序号，重扫时只处理它之后的部分。
     */
    scanned: {},
  }
}

/** 从磁盘读取存储；损坏或版本不符时重建，绝不因此让插件启动失败。 */
function loadStore(logger, home) {
  const path = storePath(home)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== STORE_VERSION) {
      logger?.warn?.(`token-metrics: 数据文件版本不符，重新初始化（${path}）`)
      return emptyStore()
    }
    const base = emptyStore()
    const store = {
      ...base,
      ...parsed,
      total: { ...base.total, ...(parsed.total ?? {}) },
      byDay: parsed.byDay ?? {},
      byProvider: parsed.byProvider ?? {},
      byModel: parsed.byModel ?? {},
      byModelName: parsed.byModelName ?? {},
      byDayModel: parsed.byDayModel ?? {},
      byDayModelName: parsed.byDayModelName ?? {},
      byModelFacets: parsed.byModelFacets ?? {},
      byDayFacets: parsed.byDayFacets ?? {},
      byDayPeak: parsed.byDayPeak ?? {},
      byModelPeak: parsed.byModelPeak ?? {},
      /**
       * 数据结构版本号。新增分桶结构时递增，回扫完成后写入。
       *
       * 用它判断「是否需要为迁移而重建」，避免靠「桶空不空」猜测——
       * 后者会把「刚重建完但该时段恰好没有此类调用」误判成「还没迁移」。
       */
      schemaVersion: Number(parsed.schemaVersion ?? 0) || 0,
      bySession: parsed.bySession ?? {},
      seen: parsed.seen ?? {},
      failedSeen: parsed.failedSeen ?? {},
      scanned: parsed.scanned ?? {},
    }
    // 结构迁移：byDayModel 是后加的桶。老数据文件里 byDay 有内容、byDayModel
    // 却是空的，此时「按模型趋势」只会有新数据那几天。标记待重建，让回扫
    // 把历史按天×模型重新铺一遍；重建失败也不影响已有数据。
    // 判据是**覆盖度**而不是「是否为空」：升级那一刻 byDayModel 里已经有
    // 当天新增的桶，只看空/非空会漏判，历史趋势永远补不回来。
    const dayKeys = Object.keys(store.byDay ?? {})
    const dayModelKeys = new Set(Object.keys(store.byDayModel ?? {}))
    const dayModelNameKeys = new Set(Object.keys(store.byDayModelName ?? {}))
    // byModelFacets 是后加的结构：老文件没有它，筛选功能会拿不到数据。
    const modelNameKeys = Object.keys(store.byModelName ?? {})
    const missingFacets = modelNameKeys.length > 0
      && Object.keys(store.byModelFacets ?? {}).length === 0
    // byDayFacets / byDayPeak 也是后加的桶，判据同上：看覆盖度而非空/非空。
    const dayFacetKeys = new Set(Object.keys(store.byDayFacets ?? {}))
    const dayPeakKeys = new Set(Object.keys(store.byDayPeak ?? {}))
    const missingDayFacets = dayKeys.length > 0
      && (dayKeys.some((day) => !dayFacetKeys.has(day))
        || dayKeys.some((day) => !dayModelKeys.has(day))
        || dayKeys.some((day) => !dayModelNameKeys.has(day)))
    // 峰谷分桶的迁移用**结构版本号**判断，而不是「桶是否为空」。
    //
    // 为什么不用空/非空：桶为空有两种可能——① 老数据从没记过（需要重建）；
    // ② 刚重建完但该时段没有 DeepSeek 调用（不需要重建）。用空/非空会把
    // 后者误判成前者，每次启动都触发一次全量回扫。
    const missingPeak = Number(store.schemaVersion ?? 0) < SCHEMA_VERSION
      && Object.keys(store.byModel ?? {}).length > 0
    if (missingFacets || missingDayFacets || missingPeak) {
      store.needsRebuild = true
      const reasons = []
      if (missingFacets) reasons.push('按模型分组的维度数据缺失')
      if (missingDayFacets) reasons.push(`「按天×模型」不完整（${dayModelKeys.size}/${dayKeys.length} 天）`)
      if (missingPeak) reasons.push('峰谷用量分桶缺失')
      logger?.info?.(`token-metrics: ${reasons.join('、')}，将重建以补齐历史`)
    }

    // 一致性检查：正常情况下 calls 与去重键数严格相等（每次调用写一个键）。
    // 历史版本缺陷（跨进程去重失效）会写出 calls 远大于 seen 的文件。
    //
    // 注意：这里**绝不丢弃数据**。早先的实现直接清零重建，而又依赖
    // sessionPersistence 才重建得回来——一旦该服务不可见，历史就永久丢失。
    // 现在只标记 `needsRebuild`，由回扫在重建成功后覆盖；重建失败则原样保留。
    const seenCount = Object.keys(store.seen).length
    const calls = store.total.calls
    if (calls >= 10 && calls > seenCount * 1.1) {
      store.needsRebuild = true
      logger?.warn?.(
        `token-metrics: 数据一致性存疑（${calls} 次调用 / ${seenCount} 个去重键），`
        + '将在回扫成功后重建；失败则保留现有数据',
      )
    }
    return store
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`token-metrics: 读取数据文件失败，重新初始化：${error?.message ?? error}`)
    }
    return emptyStore()
  }
}

/** 原子写：先写临时文件再 rename，避免进程中断留下半截 JSON。 */
function saveStore(store, logger, home) {
  const path = storePath(home)
  const temp = `${path}.tmp`
  try {
    mkdirSync(dataDir(home), { recursive: true })
    store.updatedAt = Date.now()
    writeFileSync(temp, JSON.stringify(store), 'utf8')
    renameSync(temp, path)
  } catch (error) {
    logger?.warn?.(`token-metrics: 写入数据文件失败：${error?.message ?? error}`)
  }
}

/** 裁剪超出保留期的按天分桶与去重表。 */
function pruneStore(store, retentionDays, maxSeenEntries) {
  if (!retentionDays || retentionDays <= 0) return
  const cutoffDay = dayKey(Date.now() - retentionDays * 86_400_000)
  for (const day of Object.keys(store.byDay)) {
    if (day < cutoffDay) delete store.byDay[day]
  }
  // 按天×模型的桶必须与 byDay 一起裁，否则会随保留期无限增长。
  for (const day of Object.keys(store.byDayModel ?? {})) {
    if (day < cutoffDay) delete store.byDayModel[day]
    if (day < cutoffDay) delete store.byDayFacets[day]
    if (day < cutoffDay) delete store.byDayPeak[day]
  }
  for (const day of Object.keys(store.byDayModelName ?? {})) {
    if (day < cutoffDay) delete store.byDayModelName[day]
  }
  // 按模型明细里的 day 桶与主 day 桶同生命周期。
  for (const facets of Object.values(store.byModelFacets ?? {})) {
    for (const day of Object.keys(facets?.day ?? {})) {
      if (day < cutoffDay) delete facets.day[day]
    }
  }
  // 去重表**不能**按事件时间裁剪：回扫历史会话时写入的是当年的时间戳，
  // 按时间裁会立刻删掉刚建立的键，下一次回扫就重复累加。这里只按条目数量
  // 设上限，超出时丢弃最早写入的一批（对象的插入顺序即写入顺序）。
  const trim = (table) => {
    const keys = Object.keys(table)
    if (keys.length <= maxSeenEntries) return
    const overflow = keys.length - maxSeenEntries
    for (let index = 0; index < overflow; index += 1) delete table[keys[index]]
  }
  trim(store.seen)
  if (store.failedSeen !== undefined) trim(store.failedSeen)
}

/** 统计核心：两条数据通路写进同一份存储。 */
class TokenUsageTracker {
  constructor(logger, buildId, config = resolveConfig()) {
    this.logger = logger
    this.buildId = buildId
    this.config = config
    // 固定数据目录：定时落盘是异步的，若每次都读 process.env，环境变量一变
    // 就会把数据写到别的目录去（测试里真实踩到过）。
    this.home = process.env.DSH_HOME?.trim() ?? join(homedir(), '.dsh')
    /**
     * 价目表：负责模型单价、汇率、手工补价与供应商倍率。
     *
     * 成本核算依赖它。构造时同步加载磁盘缓存（含内置兜底），所以即使
     * 首次启动还没联网，也能立刻算出成本。
     */
    /**
     * pi-ai 的模型目录：给出每个模型的推理能力、思考档位、容量。
     *
     * 这是权威数据，比让用户逐个手填准确——例如 claude-fable-5 只支持
     * xhigh/max 两档，手填很容易填错。读不到时返回空映射，页面退回手填。
     */
    this.modelCatalog = loadModelCatalog({ home: this.home })

    this.priceBook = new PriceBook({
      dataDir: dataDir(this.home),
      log: (message) => logger?.info?.(message),
    }).load()
    /**
     * 第三方余额与订阅额度。
     *
     * 只存站点配置与最近探测结果，密钥交给 DSH 的凭据服务托管——
     * 凭据绝不能落到插件的统计数据文件里。
     */
    this.balanceBook = new BalanceBook({
      dataDir: dataDir(this.home),
      log: (message) => logger?.info?.(message),
    }).loadFrom(join(dataDir(this.home), 'balance.json'))
    // 让落盘文件也带上 buildId，便于排查「哪一版代码写的数据」。
    this.store = loadStore(logger, this.home)
    this.store.buildId = buildId
    this.flushTimer = undefined
    this.dirty = false
    /** 本进程已记录的键，避免 seen 对象无限增长的读放大。 */
    this.liveSeen = new Set()
    /**
     * 快照缓存。
     *
     * `snapshot()` 要遍历按天/按模型/按会话的全部桶并做排序，实测约 3ms。
     * 页面每几秒轮询一次，重复计算纯属浪费。这里按 `snapshotCacheMs`
     * 缓存结果；有新数据写入时用 `storeRevision` 让缓存失效。
     */
    this.cachedSnapshot = undefined
    this.cachedSnapshotAt = 0
    this.cachedSnapshotRevision = -1
    /** 每次成功记录自增，用于判断快照缓存是否过期。 */
    this.storeRevision = 0
    /** pruneStore 不需要每次都跑：记录一下上次执行的时间。 */
    this.lastPruneAt = 0
  }

  /**
   * 记录一次调用；去重后真正记入才返回 true。
   *
   * @param {object} input
   * @param {string} [input.sessionId]
   * @param {string} [input.provider]
   * @param {string} [input.model]
   * @param {number} [input.turn]
   * @param {number} [input.step]
   * @param {object} input.usage
   * @param {number} [input.time]
   * @param {string} [input.purpose]
   * @param {string} [input.parentSession]
   * @param {string} [input.cwd] 会话工作目录，用于按项目归组
   * @param {string} [input.origin] 会话来源：main / subagent / workflow
   * @param {number} [input.delegationDepth] 子代理层级
   * @param {string} [input.accountId] 记录时已知的账号标识
   */
  record({
    sessionId, provider, model, turn, step, usage, time, purpose, parentSession,
    cwd, origin, delegationDepth, accountId,
  }) {
    if (usage === undefined || usage === null) return false
    const stamp = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
    const key = this.dedupeKey({ sessionId, turn, step, time: stamp, purpose })
    // seen 的值是写入时间戳（数字），所以只能用「键是否存在」判断。
    // 早先写成 `=== true` 会让跨进程的去重完全失效，历史回扫因此重复累加。
    if (this.liveSeen.has(key) || Object.hasOwn(this.store.seen, key)) return false
    this.liveSeen.add(key)
    this.store.seen[key] = stamp

    addUsage(this.store.total, usage)

    const day = dayKey(stamp)
    this.store.byDay[day] ??= emptyCounters()
    addUsage(this.store.byDay[day], usage)

    const providerKey = provider || 'unknown'
    this.store.byProvider[providerKey] ??= emptyCounters()
    addUsage(this.store.byProvider[providerKey], usage)

    const modelKey = `${providerKey}/${model || 'unknown'}`
    this.store.byModel[modelKey] ??= emptyCounters()
    addUsage(this.store.byModel[modelKey], usage)

    // 峰谷用量分桶：DeepSeek 系分时段计价，谷时价是峰时的一半。
    // 只对「有谷时价的模型」记录，其余模型不需要这份数据，
    // 避免给所有调用都多存一份计数器。
    const priceForPeak = resolvePrice(model || 'unknown', this.priceBook.table, this.priceBook.overrides)
    if (priceForPeak?.offPeak !== undefined) {
      const bucket = isOffPeak(new Date(stamp), priceForPeak.offPeak.windows) ? 'off' : 'peak'
      this.store.byModelPeak ??= {}
      const peakEntry = this.store.byModelPeak[modelKey] ?? { peak: emptyCounters(), off: emptyCounters() }
      addUsage(peakEntry[bucket], usage)
      this.store.byModelPeak[modelKey] = peakEntry

      // 同一天再拆一份，供按天成本精确计价
      this.store.byDayPeak[day] ??= {}
      const dayPeak = this.store.byDayPeak[day][modelKey] ?? { peak: emptyCounters(), off: emptyCounters() }
      addUsage(dayPeak[bucket], usage)
      this.store.byDayPeak[day][modelKey] = dayPeak
    }

    // 按天 × 模型：趋势图按模型拆分需要它。
    this.store.byDayModel[day] ??= {}
    this.store.byDayModel[day][modelKey] ??= emptyCounters()
    addUsage(this.store.byDayModel[day][modelKey], usage)

    // 模型名（跨 provider 合并）：占比图与筛选后的趋势用它。
    const modelName = model || 'unknown'
    this.store.byModelName[modelName] ??= emptyCounters()
    addUsage(this.store.byModelName[modelName], usage)
    this.store.byDayModelName[day] ??= {}
    this.store.byDayModelName[day][modelName] ??= emptyCounters()
    addUsage(this.store.byDayModelName[day][modelName], usage)

    // —— 按模型名分组的全维度明细（供前端按模型筛选）——
    const facets = this.store.byModelFacets[modelName] ??= {
      provider: {}, project: {}, origin: {}, account: {}, day: {},
    }
    facets.provider[providerKey] ??= emptyCounters()
    addUsage(facets.provider[providerKey], usage)
    if (cwd) {
      facets.project[cwd] ??= emptyCounters()
      addUsage(facets.project[cwd], usage)
    }
    const originName = origin || 'main'
    facets.origin[originName] ??= emptyCounters()
    addUsage(facets.origin[originName], usage)
    facets.day[day] ??= emptyCounters()
    addUsage(facets.day[day], usage)

    // —— 按天 × 维度归组（供前端按时间段过滤各明细）——
    const dayFacets = this.store.byDayFacets[day] ??= {
      provider: {}, project: {}, origin: {}, account: {},
    }
    dayFacets.provider[providerKey] ??= emptyCounters()
    addUsage(dayFacets.provider[providerKey], usage)
    if (cwd) {
      dayFacets.project[cwd] ??= emptyCounters()
      addUsage(dayFacets.project[cwd], usage)
    }
    dayFacets.origin[originName] ??= emptyCounters()
    addUsage(dayFacets.origin[originName], usage)

    // —— 按项目（工作目录）归组 ——
    if (cwd) {
      this.store.byProject[cwd] ??= emptyCounters()
      addUsage(this.store.byProject[cwd], usage)
    }

    // —— 按会话来源归组：主会话 / 子代理 / workflow ——
    const originKey = origin || 'main'
    this.store.byOrigin[originKey] ??= emptyCounters()
    addUsage(this.store.byOrigin[originKey], usage)

    // —— 按账号归组 ——
    // 日志本身不带账号，这里用「记录时已知的当前账号」。切换账号后新增的
    // 调用才会落到新账号下；切换前的历史保持原归属（或 unknown）。
    const accountKey = accountId || this.store.currentAccount?.id || 'unknown'
    this.store.accounts[accountKey] ??= {
      ...emptyCounters(),
      firstAt: stamp,
      lastAt: stamp,
    }
    const accountEntry = this.store.accounts[accountKey]
    addUsage(accountEntry, usage)
    accountEntry.firstAt = Math.min(accountEntry.firstAt ?? stamp, stamp)
    accountEntry.lastAt = Math.max(accountEntry.lastAt ?? 0, stamp)
    // 同步进按模型分组与按天分组的明细，供前端筛选后展示账号维度。
    facets.account[accountKey] ??= emptyCounters()
    addUsage(facets.account[accountKey], usage)
    dayFacets.account[accountKey] ??= emptyCounters()
    addUsage(dayFacets.account[accountKey], usage)

    if (sessionId) {
      const entry = this.store.bySession[sessionId] ?? {
        counters: emptyCounters(),
        provider: providerKey,
        model: model || 'unknown',
        title: undefined,
        parentSession: undefined,
        cwd: undefined,
        origin: undefined,
        delegationDepth: undefined,
        firstAt: stamp,
        lastAt: stamp,
      }
      addUsage(entry.counters, usage)
      entry.firstAt = Math.min(entry.firstAt ?? stamp, stamp)
      entry.lastAt = Math.max(entry.lastAt ?? 0, stamp)
      if (provider) entry.provider = providerKey
      if (model) entry.model = model
      if (parentSession !== undefined) entry.parentSession = parentSession
      if (cwd !== undefined) entry.cwd = cwd
      if (origin !== undefined) entry.origin = origin
      if (delegationDepth !== undefined) entry.delegationDepth = delegationDepth
      this.store.bySession[sessionId] = entry
    }

    this.storeRevision += 1
    this.markDirty()
    return true
  }

  /**
   * 去重键。
   *
   * - 日志事件带 turn/step：`session:turn:step`，实时与回扫完全一致。
   * - 补充通路的内部调用：`session:purpose:秒级时间片`。
   */
  dedupeKey({ sessionId, turn, step, time, purpose }) {
    // 主通路：日志事件天然带 turn/step，实时与回扫完全一致。
    if (sessionId && Number.isInteger(turn) && Number.isInteger(step)) {
      return `${sessionId}:${turn}:${step}`
    }
    // 补充通路：没有 turn/step。用单调递增序号而不是秒级时间片——
    // 同一秒内可能发生多次调用（例如并行子代理），按秒合并会漏计。
    this.fallbackSequence = (this.fallbackSequence ?? 0) + 1
    const slice = Math.floor(time / 1000)
    return `${sessionId ?? 'n/a'}:${purpose ?? 'call'}:${slice}:${this.fallbackSequence}`
  }

  /**
   * 记录一次失败的请求尝试。
   *
   * 只计数，不重复累加 token：失败的 attempt 若带了非零 usage，说明上游
   * 确实计费了，此时把 token 也记进来。当前多数适配器在失败路径上报全 0，
   * 所以通常只有 `count` 增长——这是数据源的限制，不是统计遗漏。
   */
  recordFailedAttempt(usage, dedupeKeyValue) {
    const entry = this.store.failedAttempts
    // 回扫会重复经过同一批事件，必须按 attempt 身份去重，否则失败次数会
    // 随每次启动翻倍。
    if (dedupeKeyValue !== undefined) {
      if (Object.hasOwn(this.store.failedSeen, dedupeKeyValue)) return
      this.store.failedSeen[dedupeKeyValue] = 1
    }
    entry.count += 1
    if (usage !== undefined && usage !== null) {
      const input = finite(usage.inputTokens)
      const output = finite(usage.outputTokens)
      const total = finite(usage.totalTokens) || input + output
      if (input > 0 || output > 0) {
        entry.inputTokens += input
        entry.outputTokens += output
        entry.totalTokens += total
        entry.billable = (entry.billable ?? 0) + 1
      }
    }
    this.storeRevision += 1
    this.markDirty()
  }

  /** 记录当前登录账号快照（仅用于展示，不参与历史归属）。 */
  setCurrentAccount(account) {
    this.store.currentAccount = account
    this.storeRevision += 1
    this.markDirty()
  }

  /** 记录会话标题，供统计页展示。 */
  setTitle(sessionId, title) {
    if (!sessionId || typeof title !== 'string' || title.length === 0) return
    const entry = this.store.bySession[sessionId]
    if (entry === undefined) {
      this.store.bySession[sessionId] = {
        counters: emptyCounters(),
        provider: 'unknown',
        model: 'unknown',
        title,
        parentSession: undefined,
        firstAt: Date.now(),
        lastAt: Date.now(),
      }
    } else if (entry.title !== title) {
      entry.title = title
    } else {
      return
    }
    this.markDirty()
  }

  /** 丢弃全部聚合结果，回到空状态（随后由回扫重建）。 */
  reset() {
    this.store = emptyStore(this.buildId)
    this.cachedSnapshot = undefined
    this.storeRevision += 1
    this.liveSeen = new Set()
    this.fallbackSequence = 0
    this.dirty = true
  }

  markDirty() {
    this.dirty = true
    this.scheduleFlush()
  }

  /** 防抖落盘。 */
  scheduleFlush() {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, this.config.flushDelayMs)
    // 不要让这个定时器拖住进程退出。
    this.flushTimer?.unref?.()
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    // pruneStore 要遍历整张去重表，实测开销随规模增长。它只是清理过期数据，
    // 不需要每次落盘都跑——最多每分钟一次。
    const now = Date.now()
    if (now - this.lastPruneAt > 60_000) {
      this.lastPruneAt = now
      pruneStore(this.store, this.config.retentionDays, this.config.maxSeenEntries)
    }
    saveStore(this.store, this.logger, this.home)
  }

  /**
   * 生成给 Client 的只读快照（带缓存）。
   *
   * 页面轮询很频繁，而聚合结果只在有新调用时才变。缓存命中时直接返回
   * 同一个对象，把每次 3ms 的开销降到接近 0。
   */
  /** 开始一轮回扫，记录总数。 */
  beginScan(total) {
    this.scan = { active: true, done: 0, total, startedAt: Date.now(), finishedAt: 0 }
    this.cachedSnapshot = undefined
    this.storeRevision += 1
  }

  /** 推进回扫进度。 */
  advanceScan() {
    if (this.scan?.active !== true) return
    this.scan.done += 1
  }

  /** 结束回扫。 */
  endScan() {
    if (this.scan?.active !== true) return
    this.scan.active = false
    this.scan.finishedAt = Date.now()
    this.cachedSnapshot = undefined
    this.storeRevision += 1
  }

  snapshot() {
    const now = Date.now()
    const cacheValid = this.cachedSnapshot !== undefined
      && this.cachedSnapshotRevision === this.storeRevision
      && now - this.cachedSnapshotAt < this.config.snapshotCacheMs
    if (cacheValid) return this.cachedSnapshot

    const value = this.buildSnapshot(now)
    this.cachedSnapshot = value
    this.cachedSnapshotAt = now
    this.cachedSnapshotRevision = this.storeRevision
    return value
  }

  /** 真正做聚合的地方。 */
  buildSnapshot(now) {
    const today = dayKey(now)
    const weekStart = dayKey(now - 6 * 86_400_000)

    const sumDaysFrom = (fromDay) => {
      const counters = emptyCounters()
      for (const [day, value] of Object.entries(this.store.byDay)) {
        if (day >= fromDay) mergeCounters(counters, value)
      }
      return counters
    }

    const sessions = Object.entries(this.store.bySession)
      .map(([id, entry]) => ({
        id,
        title: entry.title,
        provider: entry.provider,
        model: entry.model,
        parentSession: entry.parentSession,
        cwd: entry.cwd,
        origin: entry.origin,
        delegationDepth: entry.delegationDepth,
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
        counters: entry.counters,
      }))
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
      .slice(0, this.config.maxSessions)

    const days = Object.keys(this.store.byDay).sort()

    // 各维度都附上命中率，前端不用自己算，口径统一在一处。
    const withRate = (counters) => ({
      ...counters,
      cacheHitRate: cacheHitRate(counters),
    })

    const totals = {
      all: withRate(this.store.total),
      today: withRate(this.store.byDay[today] ?? emptyCounters()),
      week: withRate(sumDaysFrom(weekStart)),
    }

    return {
      generatedAt: now,
      today,
      totals,
      // 供前端画图：按天升序的时间序列。
      trend: Object.fromEntries(
        Object.keys(this.store.byDay)
          .sort()
          .map((day) => [day, withRate(this.store.byDay[day])]),
      ),
      config: {
        showSessions: this.config.showSessions,
        trackFailedAttempts: this.config.trackFailedAttempts,
        snapshotCacheMs: this.config.snapshotCacheMs,
        retentionDays: this.config.retentionDays,
        maxTrendSeries: this.config.maxTrendSeries,
        // 预算配置要传给页面：卡片上的进度条据此渲染
        budget: this.config.budget,
        alertThresholds: this.config.alertThresholds,
      },
      byDay: Object.fromEntries(days.map((day) => [day, this.store.byDay[day]])),
      /**
       * 每个模型的每日序列（跨 provider 合并），不做条数截断。
       *
       * 趋势图的「按模型筛选」需要任意单一模型的完整曲线，而 modelTrend
       * 只保留前几名；这里给出全量，形状：`{ modelName: { day: totalTokens } }`。
       */
      byModelDay: (() => {
        const dayList = Object.keys(this.store.byDayModelName ?? {}).sort()
        const result = {}
        for (const day of dayList) {
          for (const [name, counters] of Object.entries(this.store.byDayModelName[day] ?? {})) {
            result[name] ??= {}
            // 暴露完整计数器（含命中率），前端筛选单一模型后能算出全部指标；
            // 只给 totalTokens 会让输入/输出/缓存/推理在筛选时全变 0。
            result[name][day] = { ...counters, cacheHitRate: cacheHitRate(counters) }
          }
        }
        return result
      })(),
      /**
       * 按模型拆分的每日趋势。
       *
       * 形状：`{ series: [{ key, label, values: { day: token } }], days: [...] }`。
       * 只保留总量靠前的若干模型 + 一个「其他」聚合，否则小模型会把图糊成
       * 几十条线、色板也会循环撞色。
       */
      modelTrend: (() => {
        const dayList = Object.keys(this.store.byDayModelName ?? {}).sort()
        if (dayList.length === 0) return { days: [], series: [] }

        // 以**模型名**为序列（跨 provider 合并）：同一模型挂在多个供应商下时
        // 合并成一条曲线，否则图上会出现多条同名线。按供应商拆分看明细表。
        const modelTotals = new Map()
        for (const day of dayList) {
          for (const [key, counters] of Object.entries(this.store.byDayModelName[day] ?? {})) {
            modelTotals.set(key, (modelTotals.get(key) ?? 0) + (counters.totalTokens ?? 0))
          }
        }
        const ranked = [...modelTotals.entries()].sort((a, b) => b[1] - a[1])
        const topKeys = ranked.slice(0, this.config.maxTrendSeries ?? 6).map(([key]) => key)
        const topSet = new Set(topKeys)
        const hasRest = ranked.length > topKeys.length

        // key 已是模型名（跨 provider 合并），直接作为标签。
        const series = topKeys.map((key) => ({
          key,
          label: key,
          values: Object.fromEntries(dayList.map((day) => [
            day,
            this.store.byDayModelName[day]?.[key]?.totalTokens ?? 0,
          ])),
        }))
        if (hasRest) {
          series.push({
            key: '__rest__',
            label: 'rest',
            values: Object.fromEntries(dayList.map((day) => {
              let sum = 0
              for (const [key, counters] of Object.entries(this.store.byDayModelName[day] ?? {})) {
                if (!topSet.has(key)) sum += counters.totalTokens ?? 0
              }
              return [day, sum]
            })),
          })
        }
        return { days: dayList, series }
      })(),
      byProvider: this.store.byProvider,
      /**
       * 按认证类别聚合：官方 API Key / 余额 / 其他。
       *
       * 用户要求供应商维度固化成这两类——用官方 key 的显示「官方 API Key」，
       * 走余额/账号授权的显示「余额」。判不出来的一律归「其他」，
       * 不隐藏数据。
       */
      byProviderKind: (() => {
        const kinds = { apikey: emptyCounters(), balance: emptyCounters(), unknown: emptyCounters() }
        for (const [providerName, counters] of Object.entries(this.store.byProvider)) {
          // 兼容旧实例：providerKinds 是后加的字段，缺了就视为未知。
          const kind = this.providerKinds?.get?.(providerName) ?? 'unknown'
          mergeCounters(kinds[kind] ?? kinds.unknown, counters)
        }
        // 只返回有数据的类别，避免页面出现全 0 的空行
        return Object.fromEntries(
          Object.entries(kinds)
            .filter(([, counters]) => counters.calls > 0)
            .map(([kind, counters]) => [kind, { ...counters, cacheHitRate: cacheHitRate(counters) }]),
        )
      })(),
      /** 各 provider 路由名的判定结果，供明细表把供应商列换成类别。 */
      providerKinds: Object.fromEntries(this.providerKinds ?? []),
      byModel: this.store.byModel,
      /**
       * 模型别名映射（原始名 -> 显示名）。
       *
       * 部分 provider 上报的是内部代号而非模型名（Qoder 的 qfmodel 是上游
       * 队列 modelKey），这些代号无法从 DSH 元数据反查。页面据此把代号显示成
       * 真实模型名，明细表 / 占比图 / 趋势图统一生效。
       */
      /**
       * 模型能力目录（精简）。
       *
       * 只保留页面需要的四项，不把 1241 个模型的完整条目传过去。
       */
      modelCatalog: this.modelCatalog,
      modelAliases: {
        // 配置里写的别名先铺底，界面维护的优先（用户当场改的应立即生效）
        ...(this.config.modelAliases ?? {}),
        ...(this.priceBook?.aliases ?? {}),
      },
      /**
       * 成本核算。
       *
       * `byModelCost` 给出每个模型的美元成本与所用单价，`totals.cost` 是
       * 汇总。页面按 `fx.usdCny` 换算人民币，切换货币不必重新请求。
       *
       * 没有匹配到价格的模型会出现在 `unpriced` 里——页面据此显示「补价」
       * 入口，而不是静默算成 0 让用户以为免费。
       */
      cost: (() => {
        const book = this.priceBook
        const byModelCost = {}
        let totalUsd = 0
        // 按天成本：前端把「今日/近 7 天」应用到金额卡片时用。
        // 逐天逐模型算，峰谷同样按桶区分（byModelPeak 是按模型全量的，
        // 无法拆到天，所以这里按天重算时用峰时价——日级估算足够，
        // 且不会把谷时调用算成峰时价而高估）。
        const costByDay = {}
        const unpriced = []
        for (const [key, counters] of Object.entries(this.store.byModel)) {
          // key 形如 provider/model
          const slash = key.indexOf('/')
          const providerName = slash === -1 ? 'unknown' : key.slice(0, slash)
          const modelName = slash === -1 ? key : key.slice(slash + 1)
          const price = resolvePrice(modelName, book.table, book.overrides)
          const multiplier = book.multiplierOf(providerName)
          if (price === undefined) {
            unpriced.push({ model: key, tokens: counters.totalTokens ?? 0 })
            byModelCost[key] = { usd: 0, priced: false, multiplier }
            continue
          }
          // 峰谷分桶有数据时分别计价，否则按峰时估一次。
          // DeepSeek 的谷时价是峰时的一半，不区分会让成本高估最多一倍。
          const peakBuckets = this.store.byModelPeak?.[key]
          let usd
          if (peakBuckets !== undefined) {
            usd = costOf(peakBuckets.peak, price, multiplier)
              + costOf(peakBuckets.off, price, multiplier, { offPeak: true })
          } else {
            usd = costOf(counters, price, multiplier)
          }
          totalUsd += usd
          byModelCost[key] = {
            usd,
            priced: true,
            // 单价按每百万 token 展示，这是行业惯例。有谷时价时额外标注。
            inputPerM: (price.input ?? 0) * 1e6,
            outputPerM: (price.output ?? 0) * 1e6,
            cacheReadPerM: (price.cacheRead ?? 0) * 1e6,
            cacheWritePerM: (price.cacheWrite ?? 0) * 1e6,
            matchedName: price.matchedName,
            priceSource: price.source,
            multiplier,
            ...(price.offPeak === undefined ? {} : {
              offPeak: {
                inputPerM: (price.offPeak.input ?? 0) * 1e6,
                outputPerM: (price.offPeak.output ?? 0) * 1e6,
                cacheReadPerM: (price.offPeak.cacheRead ?? 0) * 1e6,
              },
              // 该模型有多少用量落在谷时，供页面说明
              offPeakTokens: peakBuckets?.off?.totalTokens ?? 0,
            }),
          }
        }
        // 按模型名合并（与占比图同一口径），供页面表格直接用
        const byModelNameCost = {}
        for (const [day, byModel] of Object.entries(this.store.byDayModel ?? {})) {
          let dayUsd = 0
          for (const [key, counters] of Object.entries(byModel)) {
            const slash = key.indexOf('/')
            const modelName = slash === -1 ? key : key.slice(slash + 1)
            const providerName = slash === -1 ? 'unknown' : key.slice(0, slash)
            const price = resolvePrice(modelName, book.table, book.overrides)
            if (price === undefined) continue
            // 该天该模型的峰谷桶（若有）
            const buckets = this.store.byDayPeak?.[day]?.[key]
            if (buckets !== undefined) {
              dayUsd += costOf(buckets.peak, price, book.multiplierOf(providerName))
                + costOf(buckets.off, price, book.multiplierOf(providerName), { offPeak: true })
            } else {
              dayUsd += costOf(counters, price, book.multiplierOf(providerName))
            }
          }
          costByDay[day] = dayUsd
        }

        for (const [key, entry] of Object.entries(byModelCost)) {
          const slash = key.indexOf('/')
          const modelName = slash === -1 ? key : key.slice(slash + 1)
          const target = byModelNameCost[modelName] ?? { usd: 0, priced: false }
          target.usd += entry.usd
          target.priced = target.priced || entry.priced === true
          byModelNameCost[modelName] = target
        }
        return {
          totalUsd,
          byDay: costByDay,
          byModel: byModelCost,
          byModelName: byModelNameCost,
          unpriced: unpriced.sort((a, b) => b.tokens - a.tokens),
          fx: {
            usdCny: book.usdCny,
            updatedAt: book.fxUpdatedAt,
            error: book.fxError,
          },
          priceBook: book.status(),
        }
      })(),
      /**
       * 按模型分组的全维度明细（前端筛选用）。
       *
       * 每个模型给出 provider / project / origin / account / day 五个分组，
       * 前端选中若干模型后把这些桶相加，就能同时刷新占比图、明细表与图表，
       * 而不是只有指标卡跟着变。
       */
      /**
       * day -> 各维度 -> counters。前端按时间段重算明细表与图表。
       */
      byDayFacets: this.store.byDayFacets,
      /**
       * day -> `${provider}/${model}` -> counters。
       * 明细表按时间段过滤时用它重新汇总。
       */
      byDayModel: Object.fromEntries(
        Object.entries(this.store.byDayModel ?? {}).map(([day, byModel]) => [
          day,
          Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, withRate(v)])),
        ]),
      ),
      /**
       * day -> 模型名 -> counters。占比图按时间段过滤时用它。
       */
      byDayModelName: Object.fromEntries(
        Object.entries(this.store.byDayModelName ?? {}).map(([day, byName]) => [
          day,
          Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, withRate(v)])),
        ]),
      ),
      byModelFacets: Object.fromEntries(
        Object.entries(this.store.byModelFacets).map(([name, facets]) => [
          name,
          {
            provider: Object.fromEntries(Object.entries(facets.provider ?? {}).map(([k, v]) => [k, withRate(v)])),
            project: Object.fromEntries(Object.entries(facets.project ?? {}).map(([k, v]) => [k, withRate(v)])),
            origin: Object.fromEntries(Object.entries(facets.origin ?? {}).map(([k, v]) => [k, withRate(v)])),
            account: Object.fromEntries(Object.entries(facets.account ?? {}).map(([k, v]) => [k, withRate(v)])),
            day: Object.fromEntries(Object.entries(facets.day ?? {}).map(([k, v]) => [k, withRate(v)])),
          },
        ]),
      ),
      // 模型名合并视图（跨供应商）。占比图与「按模型筛选」用它。
      byModelName: Object.fromEntries(
        Object.entries(this.store.byModelName)
          .map(([name, counters]) => [name, withRate(counters)])
          .sort((a, b) => (b[1].totalTokens ?? 0) - (a[1].totalTokens ?? 0)),
      ),
      // 按项目（工作目录）——回答「这个项目花了多少」
      byProject: Object.fromEntries(
        Object.entries(this.store.byProject)
          .map(([cwd, counters]) => [cwd, withRate(counters)])
          .sort((a, b) => (b[1].totalTokens ?? 0) - (a[1].totalTokens ?? 0)),
      ),
      // 按会话来源——主会话 / 子代理 / workflow 各花了多少
      byOrigin: Object.fromEntries(
        Object.entries(this.store.byOrigin).map(([origin, counters]) => [origin, withRate(counters)]),
      ),
      // 失败尝试：默认不返回。当前适配器在失败路径上报全 0 usage，这个维度
      // 只能给次数、给不出消耗；开启 trackFailedAttempts 后才输出。
      failedAttempts: this.config.trackFailedAttempts
        ? {
          count: this.store.failedAttempts.count,
          inputTokens: this.store.failedAttempts.inputTokens,
          outputTokens: this.store.failedAttempts.outputTokens,
          totalTokens: this.store.failedAttempts.totalTokens,
          billable: this.store.failedAttempts.billable ?? 0,
        }
        : null,
      // 账号用量分段
      accounts: Object.fromEntries(
        Object.entries(this.store.accounts).map(([id, entry]) => [id, { ...entry, cacheHitRate: cacheHitRate(entry) }]),
      ),
      currentAccount: this.store.currentAccount,
      // 会话明细默认不返回：它会多传几百条记录，而会话维度对「总量」统计
      // 参考意义有限。用户可在 cordis.patch.yml 里设 showSessions: true 打开。
      bySession: this.config.showSessions
        ? Object.fromEntries(sessions.map((session) => [session.id, session]))
        : {},
      /**
       * 第三方余额与订阅额度。只含站点配置与最近探测结果，绝不含密钥。
       * 页面据此渲染进度条与「已用 / 总额度」。
       */
      balance: this.balanceBook?.status?.() ?? { sites: [] },
      sessionCount: Object.keys(this.store.bySession).length,
      scannedCount: Object.keys(this.store.scanned).length,
      // 回扫进度：首次安装扫历史会话时前端显示进度提示。
      scan: {
        active: this.scan?.active === true,
        done: this.scan?.done ?? 0,
        total: this.scan?.total ?? 0,
        startedAt: this.scan?.startedAt ?? 0,
        finishedAt: this.scan?.finishedAt ?? 0,
      },
      buildId: this.buildId,
      // 自检：calls 应与去重键数一致。不一致说明累加与去重脱节，页面会据此提示。
      integrity: {
        seenKeys: Object.keys(this.store.seen).length,
        totalCalls: this.store.total.calls,
        consistent: this.store.total.calls === Object.keys(this.store.seen).length,
      },
      storePath: storePath(this.home),
      repositoryUrl: repositoryUrlOf(),
    }
  }
}

/**
 * 直接从磁盘读取会话日志做回扫。
 *
 * 这是 sessionPersistence 不可用时的兜底，也是**唯一不依赖任何 Host 服务**
 * 的通路：DSH 的会话日志是 `.jsonl.zstd`，Node 内置 `zstdDecompressSync`
 * 即可解压，因此即使插件在某个组合里拿不到 persistence，历史数据依然能重建。
 *
 * 只在 persistence 通路不可用（或它读到的会话数为 0）时才跑，避免重复劳动。
 *
 * @returns {Promise<number>} 成功重建的会话数
 */
async function backfillFromDisk(tracker, logger) {
  let sessionsRoot
  try {
    sessionsRoot = sessionsDir()
  } catch {
    return 0
  }
  if (!existsSync(sessionsRoot)) return 0

  let files
  try {
    files = collectSessionFiles(sessionsRoot)
  } catch (error) {
    logger?.warn?.(`token-metrics: 扫描会话目录失败：${error?.message ?? error}`)
    return 0
  }

  let recorded = 0
  let scanned = 0
  // 结构迁移时先清空派生聚合，让历史事件重新累加进新桶。
  const rebuildBackup = prepareFullRebuild(tracker, logger)
  // 让前端能显示进度：首次安装要扫完全部会话，不是瞬间完成。
  tracker.beginScan(files.length)

  for (const file of files) {
    let text
    try {
      text = readSessionLog(file)
    } catch (error) {
      logger?.warn?.(`token-metrics: 读取 ${file} 失败：${error?.message ?? error}`)
      continue
    }
    const { header, events } = parseSessionLog(text)
    const id = header?.id
    if (id === undefined) continue

    const revision = `disk:${events.length}`
    // needsRebuild：结构迁移（例如新增了按天×模型的桶）后必须整段重扫，
    // 否则旧会话会被 scanned 记录跳过，历史维度的数据补不回来。
    const previous = tracker.store.needsRebuild ? undefined : tracker.store.scanned[id]
    if (previous !== undefined && previous.revision === revision) continue
    const fromSeq = typeof previous?.seq === 'number' ? previous.seq : -1
    let maxSeq = fromSeq

    for (const event of events) {
      const seq = typeof event?.seq === 'number' ? event.seq : undefined
      if (seq !== undefined) {
        if (seq <= fromSeq) continue
        if (seq > maxSeq) maxSeq = seq
      }
      if (event?.type === 'assistant/message') {
        const data = event.data ?? {}
        const source = data.message?.source ?? {}
        if (tracker.record({
          sessionId: id,
          provider: source.provider,
          model: source.model,
          turn: data.turn,
          step: data.step,
          usage: data.usage,
          time: event.time,
          parentSession: header.parentSession,
          cwd: header.cwd,
          origin: sessionOrigin(header),
          delegationDepth: header.delegationDepth,
        })) recorded += 1
      } else if (event?.type === 'assistant/attempt') {
        let attemptUsage
        for (const record of event.data?.stream ?? []) {
          const chunk = record?.chunk
          if (chunk?.type === 'usage') attemptUsage = chunk.usage
        }
        tracker.recordFailedAttempt(attemptUsage, `${id}:${event.data?.turn}:${event.data?.step}`)
      } else if (event?.type === 'session/title') {
        tracker.setTitle(id, event.data?.title)
      }
    }
    tracker.store.scanned[id] = { revision, seq: maxSeq }
    scanned += 1
    tracker.advanceScan()
  }
  tracker.endScan()

  // 全量重算没扫到任何数据 -> 回滚，绝不让用户看到一份空统计。
  if (rebuildBackup !== undefined && recorded === 0) {
    rollbackFullRebuild(tracker, rebuildBackup, logger)
  } else if (tracker.store.needsRebuild && scanned > 0) {
    tracker.store.needsRebuild = false
    // 重建完成即视为已迁移到当前结构版本，避免下次启动再判一次。
    tracker.store.schemaVersion = SCHEMA_VERSION
  }
  if (recorded > 0) tracker.flush()
  logger?.info?.(`token-metrics: 磁盘回扫完成：检查 ${scanned} 个会话，补录 ${recorded} 次调用`)
  return scanned
}

/** 会话日志根目录。 */
function sessionsDir() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 递归收集会话日志文件。 */
function collectSessionFiles(root) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(full)
      else if (name.startsWith('session.v') && name.includes('jsonl')) files.push(full)
    }
  }
  walk(root)
  return files
}

/**
 * 读取并解压一个会话日志。
 *
 * 优先用 Node 内置 zstd；不可用时退回系统 `zstd` 命令。
 */
function readSessionLog(file) {
  const raw = readFileSync(file)
  if (typeof zstdDecompressSync === 'function') {
    try {
      return zstdDecompressSync(raw).toString('utf8')
    } catch {
      // 不是 zstd（或损坏），继续尝试按纯文本读。
    }
  }
  try {
    return raw.toString('utf8')
  } catch {
    return ''
  }
}

/** 把日志文本解析成 header + 事件列表。 */
function parseSessionLog(text) {
  let header
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.type === 'session') {
      header = event
      continue
    }
    if (typeof event.seq === 'number') events.push(event)
  }
  return { header, events }
}

/**
 * 从会话日志回扫历史用量。
 *
 * 只处理 `assistant/message`：它是唯一带最终 `usage` 的事件。
 * `assistant/attempt` 是失败重试的中间态，计入会重复。
 *
 * `scanned[sessionId] = { revision, seq }` 让重复启动只处理新增部分：
 * revision 未变直接跳过；变了则从已处理到的 seq 之后继续，配合去重键
 * 保证同一事件无论扫几次都只累加一次。
 */
/**
 * 结构迁移：为「全量重算」准备状态。
 *
 * `needsRebuild` 只让回扫去重扫事件是不够的——去重表里已有对应键，`record()`
 * 会直接 return false，历史事件不会重新累加进新桶（例如后来加的
 * `byDayModel`），趋势数据永远补不回来。所以这里先把派生聚合与去重表清空，
 * 让事件真正重新累加一遍。
 *
 * 安全网：调用方应在扫描结束后判断「是否真的扫到了数据」，没扫到就恢复备份。
 *
 * @returns {object|undefined} 备份的 store，供失败时回滚
 */
function prepareFullRebuild(tracker, logger) {
  if (tracker.store.needsRebuild !== true) return undefined
  const backup = tracker.store
  logger?.info?.('token-metrics: 执行全量重算（清空派生聚合后重扫）')
  tracker.reset()
  return backup
}

/** 全量重算失败时的回滚：把备份装回去，避免留下一份空数据。 */
function rollbackFullRebuild(tracker, backup, logger) {
  if (backup === undefined) return
  tracker.store = backup
  tracker.cachedSnapshot = undefined
  tracker.storeRevision += 1
  tracker.markDirty()
  logger?.warn?.('token-metrics: 全量重算未扫到数据，已回滚到原数据')
}

async function backfillFromLogs(ctx, tracker, logger, persistence) {

  let snapshots
  try {
    snapshots = await persistence.list()
  } catch (error) {
    logger?.warn?.(`token-metrics: 列出会话失败，跳过历史回扫：${error?.message ?? error}`)
    return
  }

  let scanned = 0
  let recorded = 0
  let failed = 0
  // 结构迁移时先清空派生聚合，让历史事件重新累加进新桶。
  const rebuildBackup = prepareFullRebuild(tracker, logger)
  tracker.beginScan(snapshots.length)

  for (const snapshot of snapshots) {
    const id = snapshot.header?.id
    if (id === undefined) continue
    const revision = String(snapshot.revision ?? '')
    const previous = tracker.store.needsRebuild ? undefined : tracker.store.scanned[id]
    // 同一个 revision 说明日志没变，跳过；否则按已处理到的 seq 增量重扫。
    if (previous !== undefined && previous.revision === revision) continue
    const fromSeq = typeof previous?.seq === 'number' ? previous.seq : -1

    let handle
    try {
      handle = await persistence.open(id, 'read')
    } catch {
      failed += 1
      continue
    }
    try {
      const { events } = await handle.read()
      let maxSeq = fromSeq
      for (const event of events) {
        const seq = typeof event?.seq === 'number' ? event.seq : undefined
        if (seq !== undefined) {
          if (seq <= fromSeq) continue
          if (maxSeq === undefined || seq > maxSeq) maxSeq = seq
        }
        if (event?.type === 'assistant/message') {
          const data = event.data ?? {}
          const source = data.message?.source ?? {}
          if (tracker.record({
            sessionId: id,
            provider: source.provider,
            model: source.model,
            turn: data.turn,
            step: data.step,
            usage: data.usage,
            time: event.time,
            parentSession: snapshot.header?.parentSession,
            cwd: snapshot.header?.cwd,
            origin: sessionOrigin(snapshot.header),
            delegationDepth: snapshot.header?.delegationDepth,
          })) recorded += 1
        } else if (event?.type === 'assistant/attempt') {
          // 回扫也要计入失败尝试，否则历史失败次数永远是 0。
          let attemptUsage
          for (const record of event.data?.stream ?? []) {
            const chunk = record?.chunk
            if (chunk?.type === 'usage') attemptUsage = chunk.usage
          }
          tracker.recordFailedAttempt(attemptUsage, `${id}:${event.data?.turn}:${event.data?.step}`)
        } else if (event?.type === 'session/title') {
          tracker.setTitle(id, event.data?.title)
        }
      }
      tracker.store.scanned[id] = { revision, seq: maxSeq }
      scanned += 1
      tracker.advanceScan()
    } catch (error) {
      failed += 1
      logger?.warn?.(`token-metrics: 读取会话 ${id} 失败：${error?.message ?? error}`)
    } finally {
      await handle.close().catch(() => {})
    }
  }

  tracker.endScan()

  // 全量重算没扫到任何数据 -> 回滚，绝不让用户看到一份空统计。
  if (rebuildBackup !== undefined && recorded === 0) {
    rollbackFullRebuild(tracker, rebuildBackup, logger)
  } else if (tracker.store.needsRebuild && scanned > 0) {
    // 扫描成功，清除迁移标记，避免每次启动都全量扫描。
    tracker.store.needsRebuild = false
  }
  if (scanned > 0) tracker.flush()
  logger?.info?.(
    `token-metrics: 历史回扫完成：检查 ${scanned} 个会话，补录 ${recorded} 次调用` +
    (failed > 0 ? `，${failed} 个读取失败` : ''),
  )
  // 返回会话数，供编排层判断 persistence 通路是否为空、要不要走磁盘兜底。
  return scanned
}

/**
 * 进程级 tracker 单例。
 *
 * 宿主在热重载或重新启用插件时会加载出**第二份模块实例**，两份都会各自
 * `apply()` 一次。若每个实例各持一个 tracker，同一事件会被累加两次、
 * 两个实例又互相覆盖对方的落盘结果（`seen` 只剩一份，`calls` 却翻倍）。
 *
 * 把状态挂到 `globalThis` 上，无论模块加载几次都共用同一份：
 *   - 第二个实例复用第一个的 tracker，不再重复记录；
 *   - 落盘防抖定时器也只有一个。
 *
 * 用 Symbol.for 作为键，避免与其它插件撞名。
 */
const TRACKER_KEY = Symbol.for('dsh-token-metrics:tracker')

function acquireTracker(logger, buildId, config) {
  const existing = globalThis[TRACKER_KEY]
  if (existing !== undefined) {
    // 同一份代码的两个实例（热重载时宿主会加载两份）复用同一 tracker，
    // 否则同一事件会被累加两次。
    if (existing.buildId === buildId) {
      if (logger !== undefined) existing.logger = logger
      // 配置可能被用户改过（cordis.patch.yml 热更新），同步到现有实例。
      if (config !== undefined) existing.config = config
      // 复用实例时也要重读余额配置：它是「配置」不是「计数」，
      // 用户在插件外改过文件时，内存里留着旧值会一直显示已删除的站点。
      try {
        existing.balanceBook = new BalanceBook({
          dataDir: dataDir(existing.home),
          log: (message) => logger?.info?.(message),
        }).loadFrom(join(dataDir(existing.home), 'balance.json'))
        existing.cachedSnapshot = undefined
      } catch { /* 读失败保持原对象，不影响统计 */ }
      // 复用时若存在待迁移标记，也要给它一次回扫机会。
      return { tracker: existing, fresh: existing.store.needsRebuild === true }
    }
    // buildId 不同 = 模块源码已变。此时必须换上新实例，否则旧代码会永远
    // 占据单例，热重载对统计逻辑的修改不生效。
    // 交接：旧实例先把内存计数落盘，新实例再从磁盘读回，避免丢数。
    try {
      existing.flush()
    } catch { /* 旧实例落盘失败不阻断替换 */ }
    const replacement = new TokenUsageTracker(logger, buildId, config)
    globalThis[TRACKER_KEY] = replacement
    // 新实例从磁盘重新加载（构造时已做），并把旧实例的去重集合并入，
    // 保证切换瞬间正在处理的事件不会被重复计数。
    for (const key of existing.liveSeen ?? []) replacement.liveSeen.add(key)
    // 换新实例时，如果读到的数据需要结构迁移（needsRebuild），也必须回扫一次；
    // 否则热重载后标志永远没人消费，历史维度补不回来。
    return { tracker: replacement, fresh: replacement.store.needsRebuild === true }
  }
  const tracker = new TokenUsageTracker(logger, buildId, config)
  globalThis[TRACKER_KEY] = tracker
  return { tracker, fresh: true }
}


/**
 * 归一化会话来源。
 *
 * 会话头里 `origin` 只有 `'subagent'` 这一个已知值；普通会话不带该字段。
 * workflow 子会话同样以 subagent 身份出现，用 delegationDepth 区分层级。
 */
function sessionOrigin(header) {
  if (header?.origin === 'subagent') {
    return header?.delegationDepth > 1 ? 'workflow' : 'subagent'
  }
  return 'main'
}

/**
 * 从 package.json 的 repository 解析出可在浏览器打开的仓库主页。
 *
 * 返回 undefined 时（占位符或字段缺失）面板不显示 Star 按钮——一个点了
 * 会 404 的链接比没有链接更糟。
 */
function repositoryUrlOf() {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
    const repo = parseRepository(manifest.repository)
    if (repo === null) return undefined
    // 占位符（未替换的开源模板）不当作有效地址。
    if (repo.owner === 'YOUR_GITHUB_USER') return undefined
    return `https://github.com/${repo.owner}/${repo.repo}`
  } catch {
    return undefined
  }
}

/** 进程退出时落盘的监听器，全局只装一个。 */
const EXIT_FLUSH_KEY = Symbol.for('dsh-token-metrics:exit-flush')

function installExitFlush(tracker) {
  const existing = globalThis[EXIT_FLUSH_KEY]
  if (existing !== undefined) {
    // 已有监听器：让它改为 flush 当前 tracker，而不是再加一个。
    existing.tracker = tracker
    return () => { /* 由最早安装方负责移除 */ }
  }
  const entry = { tracker }
  const listener = () => {
    try {
      entry.tracker?.flush()
    } catch { /* 退出阶段的落盘失败无法上报 */ }
  }
  process.once('beforeExit', listener)
  globalThis[EXIT_FLUSH_KEY] = entry
  return () => {
    process.removeListener('beforeExit', listener)
    if (globalThis[EXIT_FLUSH_KEY] === entry) delete globalThis[EXIT_FLUSH_KEY]
  }
}

export function apply(ctx, rawConfig) {
  const logger = ctx.logger ?? console
  const config = resolveConfig(rawConfig)
  const { tracker, fresh } = acquireTracker(logger, BUILD_ID, config)

  // —— 主通路：会话日志增量 ——
  // 覆盖所有 agent loop 调用，包括子代理 / teammate / workflow 子会话。
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      const header = session?.header
      if (event?.type === 'assistant/message') {
        const data = event.data ?? {}
        const source = data.message?.source ?? {}
        tracker.record({
          sessionId,
          provider: source.provider,
          model: source.model,
          turn: data.turn,
          step: data.step,
          usage: data.usage,
          time: event.time,
          parentSession: header?.parentSession,
          cwd: header?.cwd,
          origin: sessionOrigin(header),
          delegationDepth: header?.delegationDepth,
        })
      } else if (event?.type === 'assistant/attempt') {
        // 失败重试的中间态：只记次数（以及上游真报了 token 时的用量）。
        const stream = event.data?.stream ?? []
        let usage
        for (const record of stream) {
          const chunk = record?.chunk
          if (chunk?.type === 'usage') usage = chunk.usage
        }
        tracker.recordFailedAttempt(usage, sessionId === undefined ? undefined : `${sessionId}:${event.data?.turn}:${event.data?.step}`)
      } else if (event?.type === 'session/title' && sessionId !== undefined) {
        tracker.setTitle(sessionId, event.data?.title)
      }
    } catch (error) {
      logger?.warn?.(`token-metrics: 处理会话事件失败：${error?.message ?? error}`)
    }
  })

  // —— 补充通路：不落 assistant/message 的调用 ——
  // 标题生成、压缩，以及其它插件直接发起的无会话调用。
  // 这是 waterfall：必须调用 next() 拿到真正的流，并原样透传每个 chunk。
  ctx.on('llm/stream', (options, next) => {
    const inner = next()
    const provider = options?.provider
    const model = options?.model
    const sessionId = options?.sessionId
    const purpose = options?.purpose
    // 只在「日志不会记录」的情况下补记，避免与主通路重复。
    const needsSupplement = purpose === 'compaction'
      || purpose === 'session-title'
      || sessionId === undefined

    if (!needsSupplement) return inner

    return (async function* tap() {
      let lastUsage
      for await (const chunk of inner) {
        if (chunk?.type === 'usage' && chunk.usage !== undefined) lastUsage = chunk.usage
        yield chunk
      }
      if (lastUsage === undefined) return
      try {
        tracker.record({
          sessionId,
          provider,
          model,
          usage: lastUsage,
          purpose: purpose ?? 'direct',
          time: Date.now(),
        })
      } catch (error) {
        logger?.warn?.(`token-metrics: 记录补充调用失败：${error?.message ?? error}`)
      }
    })()
  })

  // —— 启动回扫：不阻塞插件激活 ——
  // 只有第一个 tracker 实例负责回扫；后续实例复用同一份状态，不重复扫描。
  // 用 ctx.inject 等 sessionPersistence 就绪：插件加载顺序不保证，直接
  // ctx.get 可能拿到 undefined，回扫就永远不会跑。
  if (fresh) {
    // 回扫编排：三条路并用，谁先成功算谁的，保证历史数据一定被重建。
    //   1. ctx.inject(['sessionPersistence']) —— cordis 的服务就绪回调
    //   2. ctx.get('sessionPersistence') 轮询 —— 覆盖 inject 不回调用的情况
    //   3. 磁盘直读（backfillFromDisk）—— 不依赖任何 Host 服务，永远可用
    let started = false
    const begin = (persistence, source) => {
      if (started || persistence === undefined) return
      started = true
      logger?.info?.(`token-metrics: 通过 ${source} 取得 sessionPersistence，开始回扫`)
      queueMicrotask(() => {
        backfillFromLogs(ctx, tracker, logger, persistence)
          .then((scanned) => {
            // persistence 通路一个会话都没读到，说明它在这个组合里是空的，
            // 交给磁盘直读补齐。
            if (!scanned || scanned === 0) {
              logger?.info?.('token-metrics: persistence 未读到会话，改用磁盘直读')
              return backfillFromDisk(tracker, logger)
            }
            return undefined
          })
          .catch((error) => {
            logger?.warn?.(`token-metrics: 历史回扫异常：${error?.message ?? error}`)
          })
      })
    }

    try {
      ctx.inject(['sessionPersistence'], (scoped) => {
        begin(scoped.sessionPersistence, 'inject')
      })
    } catch (error) {
      logger?.info?.(`token-metrics: inject 不可用（${error?.message ?? error}），改用轮询`)
    }

    const poll = async () => {
      for (let attempt = 0; attempt < 12 && !started; attempt += 1) {
        begin(ctx.get('sessionPersistence'), 'poll')
        if (started) return
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }

    // 约 3 秒内两条活路都没成，就用磁盘直读兜底。
    const diskFallback = async () => {
      for (let attempt = 0; attempt < 12 && !started; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (started) return
      started = true
      logger?.info?.('token-metrics: sessionPersistence 不可用，改用磁盘直读回扫')
      try {
        await backfillFromDisk(tracker, logger)
      } catch (error) {
        logger?.warn?.(`token-metrics: 磁盘回扫异常：${error?.message ?? error}`)
      }
    }

    queueMicrotask(() => { poll() })
    queueMicrotask(() => { diskFallback() })
  }

  // —— 账号快照：用于展示「当前登录账号」与官方用量入口 ——
  // 只读身份与余额，不碰任何凭据；失败静默降级（未登录 / 离线都正常）。
  // 注意：日志本身不带账号归属，所以这里的信息只用于展示和后续归属，
  // 无法回溯已有历史数据的账号。
  if (config.trackAccount) {
    const refreshAccount = async () => {
      try {
        const account = ctx.get('deepseekAccount')
        if (account === undefined) return
        const state = await account.getState()
        if (state?.status !== 'credential-stored') {
          tracker.setCurrentAccount(null)
          return
        }
        const client = {
          version: '0.1.0',
          locale: 'zh',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        }
        const profile = await account.getProfile(client).catch(() => null)
        const balance = await account.getBalance(client).catch(() => null)
        const identity = await account.getDeviceIdentity().catch(() => undefined)
        const id = profile?.status === 'ready' ? (profile.value?.id ?? identity?.userId ?? undefined) : identity?.userId
        tracker.setCurrentAccount({
          id: id === undefined || id === null ? 'signed-in' : String(id),
          name: profile?.status === 'ready' ? (profile.value?.name ?? null) : null,
          balance: balance?.status === 'ready'
            ? (balance.value ?? []).map((wallet) => ({ currency: wallet.currency, balance: wallet.balance }))
            : null,
          bonus: balance?.status === 'ready'
            ? (balance.bonusWallets ?? []).map((wallet) => ({ currency: wallet.currency, balance: wallet.balance }))
            : null,
          usageUrl: state.links?.usageUrl ?? null,
          topUpUrl: state.links?.topUpUrl ?? null,
          refreshedAt: Date.now(),
        })
      } catch {
        // 账号服务不可用（未登录、网络问题）时保持上一次的快照，不清空。
      }
    }
    queueMicrotask(() => { refreshAccount() })
    // 每 10 分钟刷新一次余额；用 ctx.effect 管理定时器，卸载即清理。
    ctx.effect(() => {
      const timer = setInterval(() => { refreshAccount() }, 600_000)
      timer?.unref?.()
      return () => clearInterval(timer)
    }, 'token-metrics: 账号刷新')
  }

  // —— 自更新与热重载 ——
  // 只在第一个 tracker 实例上装配，避免热重载后的第二个实例重复注册路由。
  let updater
  if (config.autoUpdate || config.updateRoutes) {
    updater = new PluginUpdater({
      pkgDir: PACKAGE_DIR,
      dataDir: dataDir(tracker.home),
      log: (message) => logger?.info?.(message),
      runningVersion: version,
    })

    // 显式重载：把运行中的代码换成磁盘上的版本（开发时改一行就能看效果）。
    const reloadFromDisk = async () => {
      if (isReloading()) throw new Error('已有一次重载在进行')
      const result = await selfReload(ctx, {
        logger,
        packageUrl: PACKAGE_URL,
        entryUrl: ENTRY_URL,
      })
      if (!result.ok) throw new Error(result.error)
      return result
    }

    // 可选：监视包目录，文件一变就重载。默认关闭——正式安装不会自己改文件，
    // 开着会让每次落盘都触发一次重载，纯属浪费。
    if (config.watchFiles) {
      ctx.effect(() => watchPackage(PACKAGE_DIR, {
        logger,
        onChange: () => {
          if (isReloading()) return
          logger?.info?.('token-metrics: 监视到文件变化，触发热重载')
          void reloadFromDisk().catch((error) => {
            logger?.warn?.(`token-metrics: 热重载失败（${error?.message ?? error}）`)
          })
        },
      }), 'token-metrics: 文件监视')
    }

    // 更新检查：启动后延迟一次，之后按间隔轮询。
    if (config.autoUpdate) {
      const checkUpdater = async () => {
        try {
          await updater.check()
        } catch (error) {
          logger?.warn?.(`token-metrics: 检查更新失败（${error?.message ?? error}）`)
        }
      }
      ctx.effect(() => {
        const kickoff = setTimeout(() => { void checkUpdater() }, 30_000)
        kickoff?.unref?.()
        const timer = setInterval(() => { void checkUpdater() }, 6 * 3600_000)
        timer?.unref?.()
        return () => {
          clearTimeout(kickoff)
          clearInterval(timer)
        }
      }, 'token-metrics: 更新检查')
    }
  }

  // —— provider 认证类别：官方 API Key / 余额 ——
  //
  // DSH 的 LlmConfigurableProvider 带 `nativeAuth`：oauth=true 表示走账号
  // 授权（余额/订阅），false 表示用环境变量里的 API Key。这正是用户要区分的
  // 两类。但该字段只有插件自己声明时才存在，所以必须容错：取不到就归「其他」。
  const providerKinds = new Map()

  const resolveProviderKinds = () => {
    try {
      const llm = ctx.get('llm')
      if (llm !== undefined) {
        const providers = llm.listConfigurableProviders?.() ?? []
        for (const entry of providers) {
          if (entry?.provider === undefined) continue
          const oauth = entry.nativeAuth?.oauth
          providerKinds.set(entry.provider, oauth === true
            ? 'balance'
            : oauth === false ? 'apikey' : 'unknown')
        }
      }
    } catch {
      // 服务不可用就保持已有映射，下一次再试
    }
  }
  const syncProviderKinds = () => {
    resolveProviderKinds()
    // snapshot 直接读 tracker 的这份映射（缓存随 storeRevision 失效）。
    tracker.providerKinds = providerKinds
    tracker.cachedSnapshot = undefined
    tracker.storeRevision += 1
  }
  syncProviderKinds()
  // 插件可能晚于本插件注册 provider，定期刷新一次即可，开销可忽略。
  // 卸载时关掉所有 SSE 连接，避免残留半开连接
  ctx.effect(() => () => {
    pushHub.close()
    saveAlertState(true)
  }, 'token-metrics: SSE 关闭')

  ctx.effect(() => {
    const timer = setInterval(syncProviderKinds, 60_000)
    timer?.unref?.()
    return () => clearInterval(timer)
  }, 'token-metrics: provider 类别')

  // —— 对 Client 暴露只读快照 ——
  // 用插件自己的同源 HTTP 路由，而不是类型化 Remote：宿主每次刷新都能拿到
  // 最新聚合结果，客户端不需要自己折叠会话事件。
  // —— 通知推送 ——
  // 用 SSE 长连接把告警推到所有打开的页面。DSH 没有通知服务，
  // 但 webServer 允许 handler 持有响应，这正好是 SSE 需要的。
  const pushHub = createPushHub({ logger })

  // 已推送过的告警 id 与时间戳，**必须落盘**：否则每次插件重载都会把
  // 所有告警重新推一遍，用户会看到同一批通知反复弹。
  const alertStatePath = join(dataDir(tracker.home), 'alerts.json')
  const alertState = (() => {
    try {
      if (existsSync(alertStatePath)) {
        const parsed = JSON.parse(readFileSync(alertStatePath, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.sent === 'object') {
          return { sent: parsed.sent ?? {} }
        }
      }
    } catch { /* 读失败就当空的，重新开始 */ }
    return { sent: {} }
  })()

  /** 把告警状态写回磁盘（节流：最多每 5 秒一次）。 */
  let lastAlertSaveAt = 0
  const saveAlertState = (force = false) => {
    const now = Date.now()
    if (!force && now - lastAlertSaveAt < 5000) return
    lastAlertSaveAt = now
    try {
      mkdirSync(dataDir(tracker.home), { recursive: true })
      writeFileSync(alertStatePath, JSON.stringify({ sent: alertState.sent }), 'utf8')
    } catch (error) {
      logger?.warn?.(`token-metrics: 保存告警状态失败（${error?.message ?? error}）`)
    }
  }

  /**
   * 当前花销（今日 / 本月），供预算告警使用。
   *
   * 直接读成本快照：它已经按峰谷分桶算好每天的成本，这里只做累加。
   * 没有快照时返回 undefined —— 调用方据此跳过，不报假的 0。
   */
  const currentSpend = () => {
    try {
      const snapshot = aggregateSnapshot()
      const cost = snapshot?.cost
      if (cost === undefined || cost === null) return undefined
      const byDay = cost.byDay ?? {}
      const today = snapshot.today
      const monthKey = typeof today === 'string' ? today.slice(0, 7) : ''
      let monthUsd = 0
      for (const [day, usd] of Object.entries(byDay)) {
        if (typeof day === 'string' && day.startsWith(monthKey)) monthUsd += Number(usd) || 0
      }
      // 分组花销：把每个分组的模型在今日/本月的成本分别累加。
      // 用 byModelDay（day -> provider/model -> counters）乘单价算，
      // 不能直接用 byModel 的比例 —— 峰谷价会让比例失真。
      const groups = {}
      const budgetGroups = tracker.config?.budget?.groups ?? []
      if (budgetGroups.length > 0) {
        const book = tracker.priceBook
        const modelDay = tracker.store.byDayModel ?? {}
        // 先把「模型名 -> 该名下的成本(按天)」算好，避免重复计价
        const usdByModelDay = {}
        for (const [day, byModel] of Object.entries(modelDay)) {
          for (const [key, counters] of Object.entries(byModel)) {
            const slash = key.indexOf('/')
            const providerName = slash === -1 ? 'unknown' : key.slice(0, slash)
            const rawName = slash === -1 ? key : key.slice(slash + 1)
            const price = resolvePrice(rawName, book.table, book.overrides)
            if (price === undefined) continue
            const buckets = tracker.store.byDayPeak?.[day]?.[key]
            const usd = buckets !== undefined
              ? costOf(buckets.peak, price, book.multiplierOf(providerName))
                + costOf(buckets.off, price, book.multiplierOf(providerName), { offPeak: true })
              : costOf(counters, price, book.multiplierOf(providerName))
            usdByModelDay[rawName] ??= {}
            usdByModelDay[rawName][day] = (usdByModelDay[rawName][day] ?? 0) + usd
          }
        }
        for (const group of budgetGroups) {
          let todayUsd = 0
          let groupMonthUsd = 0
          for (const modelName of group.models ?? []) {
            const byDayForModel = usdByModelDay[modelName] ?? {}
            todayUsd += byDayForModel[today] ?? 0
            for (const [day, usd] of Object.entries(byDayForModel)) {
              if (typeof day === 'string' && day.startsWith(monthKey)) groupMonthUsd += usd
            }
          }
          groups[group.id] = { todayUsd, monthUsd: groupMonthUsd }
        }
      }

      return {
        todayUsd: Number(byDay[today] ?? 0),
        monthUsd,
        todayDay: today,
        monthKey,
        groups,
      }
    } catch {
      return undefined
    }
  }

  /** 当前所有需要提醒的告警。 */
  const currentAlerts = () => {
    const alerts = evaluateAlerts({
      sites: tracker.balanceBook?.sites ?? [],
      thresholds: tracker.config?.alertThresholds ?? {},
    })

    // 预算告警：今日/本月花销对比预算。成本数据来自最近一次快照，
    // 没有快照（刚启动）时跳过——宁可不提醒，也不要报个 0。
    try {
      const budget = tracker.config?.budget ?? {}
      if (budget.dailyUsd > 0 || budget.monthlyUsd > 0) {
        const costSpend = currentSpend()
        if (costSpend !== undefined) {
          alerts.push(...evaluateBudgetAlerts({
            spend: costSpend,
            budget,
            today: costSpend.todayDay ?? '',
            month: costSpend.monthKey ?? '',
          }))
        }
      }
    } catch (error) {
      logger?.warn?.(`token-metrics: 预算告警求值失败（${error?.message ?? error}）`)
    }
    // 插件有新版本：这是全局事件，与站点无关，单独追加。
    try {
      const status = updater?.status?.()
      if (status?.available === true && typeof status.latest === 'string' && status.latest !== '') {
        alerts.push({
          id: `plugin-update:${status.latest}`,
          level: 'ok',
          kind: 'plugin-update',
          siteId: '',
          title: '插件有新版本',
          body: `发现 ${status.latest}（当前 ${status.current}），点右上角版本号升级`,
        })
      }
    } catch { /* updater 未启用时跳过 */ }
    return alerts
  }

  /** 求值并推送「新出现」与「已恢复」的告警。 */
  const publishAlerts = () => {
    const alerts = currentAlerts()
    const { fresh, recovered } = diffAlerts(alerts, alertState)
    const now = Date.now()
    for (const alert of fresh) alertState.sent[alert.id] = now
    for (const alert of recovered) delete alertState.sent[alert.id]
    if (fresh.length > 0) {
      pushHub.broadcast('alert', { alerts: fresh })
      logger?.info?.(`token-metrics: 推送 ${fresh.length} 条告警`)
    }
    if (recovered.length > 0) {
      pushHub.broadcast('alert', { alerts: recovered })
    }
    if (fresh.length > 0 || recovered.length > 0) saveAlertState()
    return { fresh, recovered }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer
    // 同一个 (kind, path) 只能注册一次，重复注册会抛错。第二个模块实例
    // （热重载 / 重新启用）共用同一个 tracker，因此也不需要再挂一遍路由。
    webCtx.effect(() => {
      try {
        return server.register({
          kind: 'prefix',
          path: '/api/dsh-token-metrics',
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const isGet = req.method === 'GET'
            // 每个路由自己校验方法：重载/更新是 POST，不能在这里一刀切成 GET。
            if (url.pathname === '/api/dsh-token-metrics/summary') {
              if (!isGet) {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              sendJson(res, 200, tracker.snapshot())
              return
            }
            if (url.pathname === '/api/dsh-token-metrics/flush') {
              if (!isGet) {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              tracker.flush()
              sendJson(res, 200, tracker.snapshot())
              return
            }
            // —— 版本 / 更新 / 重载 ——
            if (url.pathname === '/api/dsh-token-metrics/version') {
              if (!isGet) {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              sendJson(res, 200, {
                version,
                buildId: tracker.buildId,
                // 开源页地址：面板的「点个 Star」按钮直达这里。
                repositoryUrl: repositoryUrlOf(),
                updater: updater === undefined ? null : updater.status(),
              })
              return
            }
            if (url.pathname === '/api/dsh-token-metrics/update/check') {
              if (!isGet) {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              if (updater === undefined) {
                sendJson(res, 404, { error: 'updater disabled' })
                return
              }
              const status = await updater.check()
              sendJson(res, 200, status)
              return
            }
            if (url.pathname === '/api/dsh-token-metrics/update/apply') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              if (updater === undefined) {
                sendJson(res, 404, { error: 'updater disabled' })
                return
              }
              // 先响应、再执行：更新最后一步是热重载，会注销当前 fiber，
              // 正在处理这个请求的 handler 会被连带销毁。先回 202，让前端
              // 立刻拿到明确结果（而不是连接被中断）。
              sendJson(res, 202, { ok: true, accepted: true })
              setTimeout(() => {
                updater.apply({
                  activate: async (installed) => selfReload(ctx, {
                    logger,
                    packageUrl: PACKAGE_URL,
                    entryUrl: ENTRY_URL,
                    expectedVersion: installed.version,
                  }),
                })
                  .then((result) => {
                    logger?.info?.(`token-metrics: 更新完成 ${String(result?.version ?? '')}`)
                  })
                  .catch((error) => {
                    logger?.warn?.(`token-metrics: 更新失败（${error?.message ?? error}）`)
                    // 202 已经发出去了，前端只能靠轮询 version 得知结果。
                    // 把失败原因与「需重装」标记留在 status 里，让页面能展示。
                    updater.lastFailure = {
                      message: error?.message ?? String(error),
                      reinstall: error?.reinstall === true,
                      at: Date.now(),
                    }
                  })
              }, 50)
              return
            }
            if (url.pathname === '/api/dsh-token-metrics/reload') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              if (isReloading()) {
                sendJson(res, 409, { ok: false, error: '已有一次重载在进行' })
                return
              }
              // 先响应、再交换：重载会注销当前 fiber，正在处理请求的 handler
              // 会被一并销毁。把交换放到独立定时器里，调用方才能拿到确定结果。
              sendJson(res, 202, { ok: true, accepted: true })
              setTimeout(() => {
                selfReload(ctx, { logger, packageUrl: PACKAGE_URL, entryUrl: ENTRY_URL })
                  .then((result) => {
                    if (result.ok !== true) {
                      logger?.warn?.(`token-metrics: 热重载失败（${result.error}）`)
                    }
                  })
                  .catch((error) => {
                    logger?.warn?.(`token-metrics: 热重载异常（${error?.message ?? error}）`)
                  })
              }, 50)
              return
            }

            // 强制重建：丢弃内存与磁盘的聚合结果，从会话日志重新算一遍。
            // 用户手动修数据、或升级后想确保口径一致时使用。
            // —— 余额：列表 / 配置 / 删除 / 探测 ——
            // —— 通知：SSE 长连接 ——
            // 客户端用 EventSource 订阅，收到 alert 事件就弹 toast。
            if (url.pathname === '/api/dsh-token-metrics/events') {
              if (!isGet) {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              // 连上时先告诉客户端当前已有的告警，避免错过连接前发生的
              pushHub.attach(req, res, {
                alerts: currentAlerts(),
                version: BUILD_ID,
              })
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/alerts') {
              if (!isGet) {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              sendJson(res, 200, { alerts: currentAlerts() })
              return
            }

            // —— 供应商：模型发现 / 同步回 DSH ——
            if (url.pathname === '/api/dsh-token-metrics/supplier/models') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              try {
                const body = await readJsonBody(req)
                const baseUrl = String(body.baseUrl ?? '')
                if (baseUrl === '') {
                  sendJson(res, 400, { error: '缺少 baseUrl' })
                  return
                }
                let apiKey = String(body.apiKey ?? '')
                if (apiKey === '' && body.id !== undefined) {
                  const site = tracker.balanceBook.sites.find((entry) => entry.id === body.id)
                  if (site !== undefined) apiKey = await resolveSiteKey(ctx, site)
                }
                sendJson(res, 200, await discoverModels({ baseUrl, apiKey, fetchImpl: globalThis.fetch }))
              } catch (error) {
                sendJson(res, 400, { error: error?.message ?? String(error) })
              }
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/supplier/sync') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              try {
                const body = await readJsonBody(req)
                const site = body.site ?? {}
                const saved = tracker.balanceBook.upsertSite(site)
                if (saved === undefined) {
                  sendJson(res, 400, { error: '供应商缺少 id' })
                  return
                }
                tracker.balanceBook.saveTo(join(dataDir(tracker.home), 'balance.json'))
                const result = await syncProviderToDsh({
                  ctx,
                  site: saved,
                  apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
                })
                // 同步确定了最终的凭据引用名，回写到站点记录，
                // 否则下次「查询余额」找不到密钥。
                if (result.ok === true && typeof result.keyEnv === 'string' && result.keyEnv !== '') {
                  tracker.balanceBook.upsertSite({ ...saved, keyEnv: result.keyEnv })
                  tracker.balanceBook.saveTo(join(dataDir(tracker.home), 'balance.json'))
                }
                sendJson(res, result.ok ? 200 : 400, { ...result, ...tracker.balanceBook.status() })
              } catch (error) {
                sendJson(res, 400, { error: error?.message ?? String(error) })
              }
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/pricing/alias') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              try {
                const body = await readJsonBody(req)
                const model = String(body.model ?? '')
                if (model === '') {
                  sendJson(res, 400, { error: '缺少 model' })
                  return
                }
                tracker.priceBook.setAlias(model, body.alias ?? null)
                tracker.cachedSnapshot = undefined
                tracker.storeRevision += 1
                sendJson(res, 200, { ok: true, aliases: { ...tracker.priceBook.aliases } })
              } catch (error) {
                sendJson(res, 400, { error: error?.message ?? String(error) })
              }
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/balance') {
              if (!isGet) {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              sendJson(res, 200, {
                ...tracker.balanceBook.status(),
                // 余额接口本身不知道 provider 的 baseURL，这里把 DSH 里
                // 已配置的 provider 一并给出，供页面「一键采纳」。
                discovered: discoverProviderEndpoints(ctx),
              })
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/balance/site') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              try {
                const body = await readJsonBody(req)
                const site = tracker.balanceBook.upsertSite(body ?? {})
                if (site === undefined) {
                  sendJson(res, 400, { error: '缺少 id' })
                  return
                }
                tracker.balanceBook.saveTo(join(dataDir(tracker.home), 'balance.json'))
                sendJson(res, 200, { ok: true, ...tracker.balanceBook.status() })
              } catch (error) {
                sendJson(res, 400, { error: error?.message ?? String(error) })
              }
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/balance/remove') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              try {
                const body = await readJsonBody(req)
                const removed = tracker.balanceBook.removeSite(String(body.id ?? ''))
                tracker.balanceBook.saveTo(join(dataDir(tracker.home), 'balance.json'))
                sendJson(res, 200, { ok: true, removed, ...tracker.balanceBook.status() })
              } catch (error) {
                sendJson(res, 400, { error: error?.message ?? String(error) })
              }
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/balance/probe') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              try {
                const body = await readJsonBody(req)
                const id = String(body.id ?? '')
                const site = tracker.balanceBook.sites.find((entry) => entry.id === id)
                if (site === undefined) {
                  sendJson(res, 404, { error: '没有这个站点' })
                  return
                }
                // 密钥从凭据服务取，页面不传、也不回显。
                const apiKey = await resolveSiteKey(ctx, site)
                // 先看是不是已知的官方平台：它们的接口与中转站完全不同，
                // 用通用探测只会得到 404。识别不出才回退到通用探测。
                const platform = detectProvider(site.baseUrl)
                let result
                if (platform !== undefined) {
                  result = await probeOfficial({
                    baseUrl: site.baseUrl,
                    apiKey,
                    fetchImpl: globalThis.fetch,
                    provider: platform,
                  })
                } else {
                  result = await probeBalance({
                    baseUrl: site.baseUrl,
                    apiKey,
                    fetchImpl: globalThis.fetch,
                    // 用户指定了接口类型就不自动探测，少走弯路
                    balanceKind: site.balanceKind,
                  })
                }
                tracker.balanceBook.recordResult(id, result)
                // 把识别出的平台存回站点：下次即使还没查询，
                // 页面也能据此判断该站点是余额型还是订阅型。
                if (platform !== undefined) {
                  tracker.balanceBook.upsertSite({ ...site, provider: platform })
                }
                tracker.balanceBook.saveTo(join(dataDir(tracker.home), 'balance.json'))
                // 余额变了就重新求值告警：可能刚刚跌破阈值，或刚恢复
                publishAlerts()
                sendJson(res, 200, {
                  ok: result.ok,
                  result,
                  ...tracker.balanceBook.status(),
                })
              } catch (error) {
                sendJson(res, 400, { error: error?.message ?? String(error) })
              }
              return
            }

            // —— 成本核算：手工补价 / 供应商倍率 / 刷新价目表 ——
            if (url.pathname === '/api/dsh-token-metrics/pricing/override') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              try {
                const body = await readJsonBody(req)
                const model = String(body.model ?? '')
                if (model === '') {
                  sendJson(res, 400, { error: '缺少 model' })
                  return
                }
                // price 为 null 表示删除该补价，恢复自动匹配
                tracker.priceBook.setOverride(model, body.price ?? null)
                tracker.cachedSnapshot = undefined
                tracker.storeRevision += 1
                sendJson(res, 200, { ok: true, priceBook: tracker.priceBook.status() })
              } catch (error) {
                sendJson(res, 400, { error: error?.message ?? String(error) })
              }
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/pricing/multiplier') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              try {
                const body = await readJsonBody(req)
                const provider = String(body.provider ?? '')
                if (provider === '') {
                  sendJson(res, 400, { error: '缺少 provider' })
                  return
                }
                tracker.priceBook.setMultiplier(provider, body.multiplier)
                tracker.cachedSnapshot = undefined
                tracker.storeRevision += 1
                sendJson(res, 200, { ok: true, priceBook: tracker.priceBook.status() })
              } catch (error) {
                sendJson(res, 400, { error: error?.message ?? String(error) })
              }
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/pricing/refresh') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              // 拉取可能耗时数秒（价目表约 3MB），先回 202，由前端轮询。
              sendJson(res, 202, { ok: true, accepted: true })
              setTimeout(() => {
                Promise.all([
                  tracker.priceBook.refresh(),
                  tracker.priceBook.refreshFx(),
                ]).then(() => {
                  tracker.cachedSnapshot = undefined
                  tracker.storeRevision += 1
                  logger?.info?.('token-metrics: 价目表与汇率已刷新')
                }).catch((error) => {
                  logger?.warn?.(`token-metrics: 刷新价目表失败（${error?.message ?? error}）`)
                })
              }, 20)
              return
            }

            if (url.pathname === '/api/dsh-token-metrics/rebuild') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'POST required' })
                return
              }
              tracker.reset()
              tracker.flush()
              const persistence = ctx.get('sessionPersistence')
              if (persistence !== undefined) await backfillFromLogs(ctx, tracker, logger, persistence)
              tracker.flush()
              sendJson(res, 200, tracker.snapshot())
              return
            }
            sendJson(res, 404, { error: 'not found' })
          },
        })
      } catch (error) {
        logger?.info?.(`token-metrics: 统计接口已存在，跳过重复注册（${error?.message ?? error}）`)
        return () => {}
      }
    }, 'token-metrics: 统计接口')
  })

  // 测试钩子：让集成测试能验证单例契约与内存态。
  if (process.env.DSH_TOKEN_USAGE_TEST_HOOK === '1') {
    ctx.effect(() => {
      globalThis.__dshTokenUsageInternals = { acquireTracker, BUILD_ID }
      return () => {
        delete globalThis.__dshTokenUsageInternals
      }
    }, 'token-metrics: 单例钩子')
  }

  // 测试钩子：让集成测试能在同一进程内模拟「重启」（清空内存去重集合）。
  if (process.env.DSH_TOKEN_USAGE_TEST_HOOK === '1') {
    ctx.effect(() => {
      globalThis.__dshTokenUsageTracker = tracker
      return () => {
        if (globalThis.__dshTokenUsageTracker === tracker) {
          delete globalThis.__dshTokenUsageTracker
        }
      }
    }, 'token-metrics: 测试钩子')
  }

  // —— 卸载/退出前落盘 ——
  // 进程退出监听只装一次：热重载会多次 apply，每次都装会触发
  // MaxListenersExceededWarning，而且旧实例的监听器还会拖住已废弃的 tracker。
  ctx.effect(() => installExitFlush(tracker), 'token-metrics: 落盘')
}

/**
 * 从 DSH 的配置里找出各 provider 的站点地址。
 *
 * 余额接口挂在站点根路径下，而 DSH 配置里保存的是 `baseURL`（常常带 `/v1`）。
 * 这里把能拿到的都列出来，页面据此给出「一键采纳」，省得用户手抄地址。
 *
 * 只用公开配置，不碰任何密钥。
 */
function discoverProviderEndpoints(ctx) {
  const out = []
  const seen = new Set()
  try {
    const editor = ctx.get('configEditor')
    if (editor === undefined) return out
    const rows = editor.configuration()
    for (const row of rows) {
      const id = row?.entry?.options?.id ?? ''
      // 配置有两层：用户 override 与继承值。两者都要看，否则会漏掉
      // 写在 profile 里的 providers（实测就是这种情况）。
      for (const layer of [row?.override, row?.inherited]) {
        if (layer === null || typeof layer !== 'object') continue
        const providers = layer.providers
        if (providers !== null && typeof providers === 'object') {
          for (const [name, entry] of Object.entries(providers)) {
            const base = entry?.baseURL ?? entry?.baseUrl ?? entry?.base_url
            if (typeof base !== 'string' || base === '') continue
            if (seen.has(name)) continue
            seen.add(name)
            out.push({
              id: name,
              label: String(entry?.displayName ?? entry?.display_name ?? name),
              baseUrl: normalizeBaseUrl(base),
              configRow: id,
            })
          }
        }
        // 单 provider 形态：baseURL 直接挂在配置顶层
        const direct = layer.baseURL ?? layer.baseUrl ?? layer.base_url
        if (typeof direct === 'string' && direct !== '' && id !== '' && !seen.has(id)) {
          seen.add(id)
          out.push({
            id,
            label: String(layer.displayName ?? id),
            baseUrl: normalizeBaseUrl(direct),
            configRow: id,
          })
        }
      }
    }
  } catch {
    // configEditor 不可用就返回空列表，页面仍然支持手工填写
  }
  return out
}

/**
 * 取某个站点要用的访问令牌。
 *
 * 优先级：
 *  1. 凭据服务里以 `keyRef` 存的记录（插件自己写入的）
 *  2. 环境变量（用户可能已经在 shell 里导出过）
 *
 * 找不到就返回空串，让探测报「没有可用的访问令牌」而不是崩掉。
 */
/**
 * 取某个站点要用的访问令牌。
 *
 * 关键点（都是踩过的坑）：
 *  - `CredentialRef` 是 **branded string**，传 `{ name }` 对象会被当成一个
 *    不存在引用的名字，describe 永远返回 configured: false。
 *  - 站点上可能有两个名字：`keyEnv`（同步进 DSH 模型配置的那个）与
 *    `keyRef`（插件自己早期写的那个）。两个都要试。
 *  - 最后回落到进程环境变量，覆盖用户自己 export 的情况。
 */
async function resolveSiteKey(ctx, site) {
  const candidates = []
  for (const name of [site?.keyEnv, site?.keyRef]) {
    if (typeof name === 'string' && name !== '' && !candidates.includes(name)) {
      candidates.push(name)
    }
  }
  // 同步时还会自动生成一个默认名，也试一下
  if (typeof site?.id === 'string' && site.id !== '') {
    const fallback = defaultKeyEnvName(site.id)
    if (!candidates.includes(fallback)) candidates.push(fallback)
  }

  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    for (const name of candidates) {
      try {
        const info = await credentials.describe?.(name)
        if (info?.configured !== true) continue
        const resolved = await credentials.resolve?.(name)
        if (typeof resolved?.value === 'string' && resolved.value !== '') {
          return resolved.value
        }
      } catch { /* 换下一个候选名 */ }
    }
  }

  for (const name of candidates) {
    const value = process.env[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 带大小上限：补价请求体只有几十字节，给 64KB 足够，同时避免恶意/异常
 * 请求把内存吃满。上限内也要求 content-type 是 JSON，减少意外的表单提交。
 */
async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) {
      const error = new Error(`请求体过大（超过 ${limitBytes} 字节）`)
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.statusCode = 400
    throw error
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}
