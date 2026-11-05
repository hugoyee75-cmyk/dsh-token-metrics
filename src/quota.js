/**
 * 订阅额度归因（目前专供 OpenCode Go）。
 *
 * ## 为什么单独一层
 *
 * 「token 用量」和「订阅额度」是两种单位：
 *   - 统计页按 token 记账，订阅按**美元额度**扣减；
 *   - 同一个 token 数，缓存读和输出的额度消耗能差两个数量级。
 *
 * 所以不能拿 token 直接乘一个系数，必须按模型、按 token 类型、按峰谷价
 * 先算「这次调用值多少美元」，再折算成额度百分比。
 *
 * ## 额度公式（实测，2026-11）
 *
 * OpenCode Go 每个模型有独立的月度美元额度（官方文档的 Monthly limit）。
 * 每个响应带 `usage.opencode`：
 *
 *   { list_cost, allowance, tokens: { input, output, cache_read, ... } }
 *
 * 实测 6 个模型后确认：
 *
 *   allowance = list_cost × 60 / 该模型月额度
 *
 * 即每个模型每月名义额度都是 $60，系数 = 60 / 月额度：
 *   DeepSeek V4.1 Flash 月额度 $100 → 0.6
 *   GLM-5.3-Flash       月额度 $60  → 1.0
 *   Grok 4.7 / Kimi K3  月额度 $15  → 4.0
 *
 * 三个窗口分别是月额度的 20% / 50% / 100%（官方文档）。
 *
 * ## DSH 的限制
 *
 * DSH 的 pi-ai 适配器会把 usage 归一化成
 * `{ inputTokens, outputTokens, totalTokens, cacheReadTokens }`，
 * `opencode.allowance` 不会进会话日志。插件拿不到逐次精确值，只能按上面的
 * 公式估算；误差主要来自峰谷时段（DeepSeek）与价目表更新。
 *
 * ## 数据粒度
 *
 * 10 分钟一个桶，key 是桶起点毫秒数，桶内按 `provider/model` 聚合。
 * 保留 33 天（覆盖 30 天滚动月窗口 + 3 天余量）。5h 窗口的第一桶按重叠
 * 比例摊分，其余桶整桶计入。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 目前做额度归因的 provider。以后接入别家订阅时在这里扩展。 */
export const QUOTA_PROVIDERS = ['opencode-go']

/** 账本粒度：10 分钟。 */
export const BUCKET_MS = 10 * 60 * 1000

/** 配额采样最小间隔：同一窗口 5 分钟内只留一条。 */
export const SAMPLE_MIN_INTERVAL_MS = 5 * 60 * 1000

/** 账本保留天数。 */
export const LEDGER_RETENTION_DAYS = 33

/** 采样保留天数。 */
export const SAMPLE_RETENTION_DAYS = 14

/** 单次容量估计最多留这么多条，防止无限增长。 */
const CAPACITY_HISTORY = 50

/** 窗口定义。`share` 是月额度的释放比例（官方文档）。 */
export const WINDOWS = [
  { key: 'rolling', label: '5-hour', durationMs: 5 * 3600 * 1000, share: 0.2 },
  { key: 'weekly', label: 'Weekly', durationMs: 7 * 86400 * 1000, share: 0.5 },
  { key: 'monthly', label: 'Monthly', durationMs: 30 * 86400 * 1000, share: 1 },
]

/**
 * 官方价目与额度（USD / token，额度是美元）。
 *
 * 数据来自 https://opencode.ai/v2/docs/console/go/ 的 Go 档表格。
 * `peak` 只在 DeepSeek 系上存在：峰时价格是谷时的两倍，官方写的是
 * "DeepSeek V4.1 Flash (Peak) $0.30 / Off-Peak $0.15"。
 *
 * 峰时窗口按官方口径就是 UTC：01:00-04:00 与 06:00-10:00（工作日）。
 * 实测 2026-11-05 06:21 UTC 的响应切到 peak 价，与文档一致。早先按
 * UTC+8 解释会在每天 14:00-18:00（北京）少算一半，这里保留偏移常量，
 * 默认 0 = 直接按 UTC。
 */
export const PEAK_TZ_OFFSET_HOURS = 0

/** 峰时窗口（按 PEAK_TZ_OFFSET_HOURS 平移后的小时数，工作日）。 */
const PEAK_WINDOWS = [
  [60, 240], // 01:00-04:00
  [360, 600], // 06:00-10:00
]

const M = 1_000_000

/** model -> 价目（USD/token）+ Go 档月额度 + 可选峰时价。 */
export const RATES = {
  'deepseek-v4.1-flash': {
    cap: 100,
    input: 0.30 / M, output: 1.20 / M, cacheRead: 0.006 / M, cacheWrite: 0,
    peak: { input: 0.30 / M, output: 1.20 / M, cacheRead: 0.006 / M },
    off: { input: 0.15 / M, output: 0.60 / M, cacheRead: 0.003 / M },
  },
  'deepseek-v4-pro': {
    cap: 15,
    input: 1.32 / M, output: 3.96 / M, cacheRead: 0.044 / M, cacheWrite: 0,
    peak: { input: 1.32 / M, output: 3.96 / M, cacheRead: 0.044 / M },
    off: { input: 0.66 / M, output: 1.98 / M, cacheRead: 0.022 / M },
  },
  'glm-5.3-flash': { cap: 60, input: 0.15 / M, output: 0.50 / M, cacheRead: 0.03 / M, cacheWrite: 0 },
  'glm-5.3': { cap: 15, input: 1.40 / M, output: 4.40 / M, cacheRead: 0.26 / M, cacheWrite: 0 },
  'glm-5.2': { cap: 60, input: 1.40 / M, output: 4.40 / M, cacheRead: 0.26 / M, cacheWrite: 0 },
  'kimi-k3.1-pro': { cap: 15, input: 2.00 / M, output: 10.00 / M, cacheRead: 0.20 / M, cacheWrite: 2.00 / M },
  'kimi-k3': { cap: 15, input: 3.00 / M, output: 15.00 / M, cacheRead: 0.30 / M, cacheWrite: 3.00 / M },
  'kimi-k2.7-code': { cap: 60, input: 0.95 / M, output: 4.00 / M, cacheRead: 0.19 / M, cacheWrite: 0 },
  'longcat-2.0': { cap: 60, input: 0.30 / M, output: 1.20 / M, cacheRead: 0.006 / M, cacheWrite: 0 },
  'step-5-preview': { cap: 15, input: 1.00 / M, output: 2.70 / M, cacheRead: 0.10 / M, cacheWrite: 0 },
  'mimo-v2.6-flash': { cap: 60, input: 0.14 / M, output: 0.28 / M, cacheRead: 0.0028 / M, cacheWrite: 0 },
  'mimo-v2.6-pro': { cap: 15, input: 0.435 / M, output: 0.87 / M, cacheRead: 0.003625 / M, cacheWrite: 0 },
  'mimo-v2.5': { cap: 60, input: 0.14 / M, output: 0.28 / M, cacheRead: 0.0028 / M, cacheWrite: 0 },
  'mimo-v2.5-pro': { cap: 15, input: 0.435 / M, output: 0.87 / M, cacheRead: 0.003625 / M, cacheWrite: 0 },
  'minimax-m3.1-flash': { cap: 20, input: 0.15 / M, output: 0.60 / M, cacheRead: 0.015 / M, cacheWrite: 0 },
  'minimax-m3': { cap: 60, input: 0.30 / M, output: 1.20 / M, cacheRead: 0.06 / M, cacheWrite: 0 },
  'muse-spark-1.3-contributor': { cap: 60, input: 0.10 / M, output: 0.20 / M, cacheRead: 0.002 / M, cacheWrite: 0 },
  'muse-spark-1.2-contributor': { cap: 60, input: 0.10 / M, output: 0.20 / M, cacheRead: 0.002 / M, cacheWrite: 0 },
  'qwen3.8-max': { cap: 15, input: 2.00 / M, output: 6.00 / M, cacheRead: 0.25 / M, cacheWrite: 2.50 / M },
  'qwen3.8-flash': { cap: 30, input: 0.15 / M, output: 0.47 / M, cacheRead: 0.016 / M, cacheWrite: 0.20 / M },
  'qwen3.7-plus': { cap: 60, input: 0.40 / M, output: 1.60 / M, cacheRead: 0.04 / M, cacheWrite: 0.50 / M },
  hy4: { cap: 60, input: 0.834 / M, output: 2.501 / M, cacheRead: 0.042 / M, cacheWrite: 0 },
  'hy4-preview': { cap: 30, input: 0.834 / M, output: 2.501 / M, cacheRead: 0.042 / M, cacheWrite: 0 },
  hy3: { cap: 60, input: 0.14 / M, output: 0.58 / M, cacheRead: 0.035 / M, cacheWrite: 0 },
  'grok-4.7': { cap: 15, input: 2.00 / M, output: 6.00 / M, cacheRead: 0.50 / M, cacheWrite: 0 },
  'gpt-6-luna': { cap: 15, input: 0.10 / M, output: 0.50 / M, cacheRead: 0.01 / M, cacheWrite: 0.125 / M },
  'gpt-5.6-luna': { cap: 15, input: 0.20 / M, output: 1.20 / M, cacheRead: 0.02 / M, cacheWrite: 0.25 / M },
  'claude-haiku-5-5': { cap: 15, input: 0.10 / M, output: 0.50 / M, cacheRead: 0.01 / M, cacheWrite: 0.125 / M },
  'gemini-4-argon': { cap: 30, input: 2.00 / M, output: 10.00 / M, cacheRead: 0.10 / M, cacheWrite: 0 },
  'beam-free': { cap: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'iceman-contributor-free': { cap: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

/** Go 档每个模型的月额度（美元）。 */
export const GO_CAPS = Object.fromEntries(
  Object.entries(RATES).map(([model, rate]) => [model, rate.cap]),
)

/**
 * 档位。
 *
 * `k` 是名义额度常数：Go 实测 60，即 allowance = list_cost × k / 月额度。
 * Go Plus / Teams 的每模型月额度官方没有给全表，只能靠探针：
 * 对 DeepSeek 求得 k = factor × 200 / 105，再反推其它模型。
 */
export const PLANS = {
  go: { id: 'go', label: 'Go', priceUsd: 10, k: 60, caps: GO_CAPS, anchor: undefined },
  plus: {
    id: 'plus', label: 'Go Plus', priceUsd: 40, k: null, caps: null,
    anchor: { model: 'deepseek-v4.1-flash', cap: 200 },
  },
  teams: {
    id: 'teams', label: 'Go Teams', priceUsd: 20, k: null, caps: null,
    anchor: { model: 'deepseek-v4.1-flash', cap: 105 },
  },
}

/** 窗口标签归一化：服务器返回 5-hour / Weekly / Monthly。 */
export function windowKeyOf(label) {
  const text = String(label ?? '').trim().toLowerCase()
  if (text === '5-hour' || text === '5h' || text === 'rolling' || text === 'five_hour' || text === 'five-hour') {
    return 'rolling'
  }
  if (text === 'weekly' || text === 'week') return 'weekly'
  if (text === 'monthly' || text === 'month') return 'monthly'
  return undefined
}

/** 是否峰时：按 UTC+8 平移后判断工作日 01:00-04:00 / 06:00-10:00。 */
export function isPeakTime(time, tzOffsetHours = PEAK_TZ_OFFSET_HOURS) {
  const shifted = new Date(time + tzOffsetHours * 3600 * 1000)
  const weekday = shifted.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to)
}

/** 取某模型在某一时刻的单价。 */
export function rateAt(model, at, tzOffsetHours = PEAK_TZ_OFFSET_HOURS) {
  const rate = RATES[model]
  if (rate === undefined) return undefined
  if (rate.off !== undefined && !isPeakTime(at, tzOffsetHours)) {
    return { ...rate.off, cacheWrite: rate.cacheWrite ?? 0 }
  }
  return rate
}

/** 计数器的空值。 */
export function emptyCounters() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

export function addCounters(target, source) {
  target.calls += Number(source?.calls) || 0
  target.inputTokens += Number(source?.inputTokens) || 0
  target.outputTokens += Number(source?.outputTokens) || 0
  target.cacheReadTokens += Number(source?.cacheReadTokens) || 0
  target.cacheWriteTokens += Number(source?.cacheWriteTokens) || 0
  return target
}

/** 按比例摊分计数器。 */
function scaleCounters(counters, ratio) {
  return {
    calls: counters.calls * ratio,
    inputTokens: counters.inputTokens * ratio,
    outputTokens: counters.outputTokens * ratio,
    cacheReadTokens: counters.cacheReadTokens * ratio,
    cacheWriteTokens: counters.cacheWriteTokens * ratio,
  }
}

/** 总 token（输入 + 输出 + 缓存读 + 缓存写）。 */
export function totalTokens(counters) {
  return (counters.inputTokens ?? 0) + (counters.outputTokens ?? 0)
    + (counters.cacheReadTokens ?? 0) + (counters.cacheWriteTokens ?? 0)
}

/**
 * 按官方价目算一次调用的「list cost」（美元）。
 *
 * 传入的计数器是聚合值也可以：成本对 token 是线性的。
 */
export function listCostOf(model, counters, at, tzOffsetHours = PEAK_TZ_OFFSET_HOURS) {
  const rate = rateAt(model, at, tzOffsetHours)
  if (rate === undefined) return 0
  return (counters.inputTokens ?? 0) * (rate.input ?? 0)
    + (counters.outputTokens ?? 0) * (rate.output ?? 0)
    + (counters.cacheReadTokens ?? 0) * (rate.cacheRead ?? 0)
    + (counters.cacheWriteTokens ?? 0) * (rate.cacheWrite ?? 0)
}

/**
 * 某档位下每个模型的实际月额度。
 *
 * Go 有官方表；Plus / Teams 只有 DeepSeek 一个锚点，需要探针测出系数后
 * 反推：k = factor_deepseek × 200（Plus）/ × 105（Teams），cap = k / factor。
 */
export function capsFor(planId, factors = {}) {
  const plan = PLANS[planId] ?? PLANS.go
  if (plan.caps !== null) return plan.caps
  const anchor = plan.anchor
  if (anchor === undefined) return {}
  const anchorFactor = Number(factors[anchor.model])
  if (!Number.isFinite(anchorFactor) || anchorFactor <= 0) return {}
  const k = anchorFactor * anchor.cap
  const caps = {}
  for (const [model, factor] of Object.entries(factors)) {
    const value = Number(factor)
    if (Number.isFinite(value) && value > 0) caps[model] = k / value
  }
  return caps
}

/** 某模型在某档位下的额度系数（allowance = listCost × factor）。 */
export function factorFor(model, planId, factors = {}) {
  const explicit = Number(factors[model])
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const caps = capsFor(planId, factors)
  const cap = Number(caps[model])
  if (Number.isFinite(cap) && cap > 0) {
    const plan = PLANS[planId] ?? PLANS.go
    // Plus / Teams 没有 k 时，用锚点模型反推；拿不到就退回 1，UI 会提示未校准。
    if (plan.k !== null) return plan.k / cap
    const anchor = plan.anchor
    const anchorFactor = Number(factors[anchor?.model])
    if (Number.isFinite(anchorFactor) && anchorFactor > 0) return (anchorFactor * anchor.cap) / cap
  }
  return 1
}

/**
 * 单模型额度换算：假设只用这一个模型，某窗口的额度能买多少 token。
 *
 * 额度预算 = 月额度 × 窗口释放比例（5h 20% / 周 50% / 月 100%）。
 * 纯输入 / 纯输出 / 纯缓存读是三种极端；「按你的结构」用该模型最近 30 天
 * 的真实 token 构成折算，更接近实际能跑多少。
 *
 * DeepSeek 有峰谷价：这里按**谷时**算（token 数最多），峰时数字减半，
 * 页面会提示。Grok / GPT 等有长上下文档位的模型按低档价，页面同样提示。
 */
export function modelCapacity({ model, composition, planId = 'go', factors = {}, percents = {} }) {
  const rate = RATES[model]
  if (rate === undefined) return undefined
  const cap = Number(capsFor(planId, factors)[model] ?? rate.cap)
  if (!(cap > 0)) return undefined
  const base = rate.off !== undefined
    ? { ...rate.off, cacheWrite: rate.cacheWrite ?? 0 }
    : rate
  const total = composition === null || composition === undefined
    ? 0
    : Number(composition.tokens)
      || (Number(composition.inputTokens) || 0)
        + (Number(composition.outputTokens) || 0)
        + (Number(composition.cacheReadTokens) || 0)
        + (Number(composition.cacheWriteTokens) || 0)
  const weight = total > 0
    ? ((composition.inputTokens ?? 0) * (base.input ?? 0)
      + (composition.outputTokens ?? 0) * (base.output ?? 0)
      + (composition.cacheReadTokens ?? 0) * (base.cacheRead ?? 0)
      + (composition.cacheWriteTokens ?? 0) * (base.cacheWrite ?? 0)) / total
    : 0
  const windows = WINDOWS.map((def) => {
    const budget = cap * def.share
    const percent = Number(percents[def.key])
    const remainingRatio = Number.isFinite(percent) ? Math.max(0, 1 - percent / 100) : undefined
    return {
      key: def.key,
      share: def.share,
      budget,
      tokens: {
        input: base.input > 0 ? budget / base.input : undefined,
        output: base.output > 0 ? budget / base.output : undefined,
        cacheRead: base.cacheRead > 0 ? budget / base.cacheRead : undefined,
        mixed: weight > 0 ? budget / weight : undefined,
      },
      remaining: remainingRatio === undefined ? undefined : {
        percent: Math.round(remainingRatio * 1000) / 10,
        tokens: weight > 0 ? (budget * remainingRatio) / weight : undefined,
      },
    }
  })
  return {
    model,
    cap,
    factor: factorFor(model, planId, factors),
    composition: total > 0
      ? { ...composition, tokens: total, calls: Math.round(composition.calls ?? 0) }
      : null,
    peak: rate.off !== undefined,
    tiered: TIERED_MODELS.has(model),
    windows,
  }
}

/** 有长上下文档位的模型：prompt 超过阈值时单价翻倍。 */
export const TIERED_MODELS = new Set([
  'grok-4.7', 'gpt-6-luna', 'gpt-5.6-luna', 'claude-haiku-5-5', 'qwen3.7-plus',
])

/** 空账本。 */
function emptyState() {
  return {
    version: 1,
    /** 用户选择的档位。 */
    plan: 'go',
    /** 探针学到的系数：model -> factor。 */
    factors: {},
    /** 桶：`${bucketStart}` -> `${provider}/${model}` -> counters。 */
    buckets: {},
    /** 配额采样：{ t, site, window, percent, resetsAt }。 */
    samples: [],
    /** 窗口容量：window -> { perPct, at, n }（美元 / 1%）。 */
    capacity: {},
    /** 回扫完成时间；0 表示还没回扫过。 */
    backfilledAt: 0,
    updatedAt: 0,
  }
}

/**
 * 额度账本。
 *
 * 独立于 usage.json：用量快照每 2 秒全量重写的文件已经很大，10 分钟桶
 * 换一个文件、单独的写盘节流，避免拖慢主统计。
 */
export class QuotaLedger {
  /**
   * @param {object} options
   * @param {string} options.path quota.json 的绝对路径
   * @param {(message: string) => void} [options.log]
   * @param {() => number} [options.now]
   * @param {string[]} [options.providers]
   * @param {number} [options.flushDelayMs]
   */
  constructor({ path, log, now, providers, flushDelayMs = 3000 }) {
    this.path = path
    this.log = log
    this.now = now ?? (() => Date.now())
    this.providers = new Set(providers ?? QUOTA_PROVIDERS)
    this.flushDelayMs = flushDelayMs
    this.state = emptyState()
    this.dirty = false
    this.timer = undefined
    /** 回扫进行中（只影响 UI 提示，不参与计算）。 */
    this.backfilling = false
    /** 回扫 Promise：并发调用（启动回扫 + 手动重建）共享同一轮，避免重复写。 */
    this.backfillPromise = undefined
    this.lastPruneAt = undefined
    this.load()
  }

  /** provider 是否属于本账本。 */
  accepts(provider) {
    return typeof provider === 'string' && this.providers.has(provider)
  }

  /** 从磁盘读取。坏文件不阻塞启动，只记一条日志。 */
  load() {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
        if (parsed !== null && typeof parsed === 'object') {
          this.state = { ...emptyState(), ...parsed }
          this.state.buckets = parsed.buckets ?? {}
          this.state.samples = Array.isArray(parsed.samples) ? parsed.samples : []
          this.state.factors = parsed.factors ?? {}
          this.state.capacity = parsed.capacity ?? {}
          if (PLANS[this.state.plan] === undefined) this.state.plan = 'go'
        }
      }
    } catch (error) {
      this.log?.(`token-metrics: 读取额度账本失败（${error?.message ?? error}）`)
      this.state = emptyState()
    }
    return this
  }

  /** 立即写盘（原子替换）。 */
  flush() {
    if (!this.dirty) return
    this.dirty = false
    this.state.updatedAt = this.now()
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      renameSync(tmp, this.path)
    } catch (error) {
      this.dirty = true
      this.log?.(`token-metrics: 保存额度账本失败（${error?.message ?? error}）`)
    }
  }

  markDirty() {
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.flushDelayMs)
    this.timer?.unref?.()
  }

  /** 记一次调用。`dedupe` 只用于回扫去重（实时写入不用）。 */
  record({ time, provider, model, usage, dedupe }) {
    if (!this.accepts(provider) || usage === undefined || usage === null) return false
    const stamp = Number.isFinite(time) ? time : this.now()
    const bucket = Math.floor(stamp / BUCKET_MS) * BUCKET_MS
    const key = `${provider}/${model ?? 'unknown'}`
    const entry = this.state.buckets[bucket] ??= {}
    const counters = entry[key] ??= emptyCounters()
    counters.calls += 1
    counters.inputTokens += finite(usage.inputTokens)
    counters.outputTokens += finite(usage.outputTokens)
    counters.cacheReadTokens += finite(usage.cacheReadTokens)
    counters.cacheWriteTokens += finite(usage.cacheWriteTokens)
    this.lastRecordAt = stamp
    // 裁剪要遍历全部桶；调用密集时每次记录都扫一遍太浪费，最多每 10 分钟一次。
    if (this.lastPruneAt === undefined || this.now() - this.lastPruneAt > 10 * 60 * 1000) {
      this.lastPruneAt = this.now()
      this.prune()
    }
    this.markDirty()
    return true
  }

  /** 最近一次记录的时刻（用于自动采样判断）。 */
  hasRecentUsage(withinMs) {
    return Number.isFinite(this.lastRecordAt) && this.now() - this.lastRecordAt <= withinMs
  }

  /**
   * 清空派生数据（桶 / 采样 / 容量），保留档位与系数。
   *
   * 全量重算时调用：会话日志会重新喂一遍桶；系数是探针测出来的外部事实，
   * 不该被重算清掉。
   */
  reset() {
    this.state.buckets = {}
    this.state.samples = []
    this.state.capacity = {}
    this.state.backfilledAt = 0
    this.lastRecordAt = undefined
    this.markDirty()
  }

  /** 清掉过期桶与采样。 */
  prune() {
    const now = this.now()
    const bucketCutoff = now - LEDGER_RETENTION_DAYS * 86400 * 1000
    for (const key of Object.keys(this.state.buckets)) {
      const start = Number(key)
      if (!Number.isFinite(start) || start < bucketCutoff) delete this.state.buckets[key]
    }
    const sampleCutoff = now - SAMPLE_RETENTION_DAYS * 86400 * 1000
    if (this.state.samples.length > 0 && this.state.samples[0].t < sampleCutoff) {
      this.state.samples = this.state.samples.filter((sample) => sample.t >= sampleCutoff)
    }
    const MAX_SAMPLES = 6000
    if (this.state.samples.length > MAX_SAMPLES) {
      this.state.samples = this.state.samples.slice(this.state.samples.length - MAX_SAMPLES)
    }
  }

  /** 最早一个桶的起点，用于判断窗口是否被完整覆盖。 */
  earliestBucket() {
    const keys = Object.keys(this.state.buckets).map(Number).filter(Number.isFinite)
    return keys.length === 0 ? undefined : Math.min(...keys)
  }

  /** 当前档位与系数。 */
  plan() {
    return this.state.plan
  }

  setPlan(planId) {
    if (PLANS[planId] === undefined) throw new Error(`未知档位：${planId}`)
    this.state.plan = planId
    this.markDirty()
    this.refreshCapacity()
    return planId
  }

  /** 写入探针系数（合并）。 */
  setFactors(factors) {
    for (const [model, factor] of Object.entries(factors ?? {})) {
      const value = Number(factor)
      if (Number.isFinite(value) && value > 0) this.state.factors[model] = value
    }
    this.markDirty()
    this.refreshCapacity()
  }

  /**
   * 聚合某 provider 在 [start, end) 内的用量。
   *
   * 窗口起点所在的桶按重叠比例摊分；其余桶整桶计入——桶内记录本身就是
   * 真实发生的量，不能再按时间比例缩小。
   */
  usageBetween(provider, start, end) {
    const models = {}
    let firstBucket = Math.floor(start / BUCKET_MS) * BUCKET_MS
    for (let bucket = firstBucket; bucket < end; bucket += BUCKET_MS) {
      const entry = this.state.buckets[bucket]
      if (entry === undefined) continue
      const overlapStart = Math.max(start, bucket)
      const overlapEnd = Math.min(end, bucket + BUCKET_MS)
      if (overlapEnd <= overlapStart) continue
      const ratio = (overlapEnd - overlapStart) / BUCKET_MS
      for (const [key, counters] of Object.entries(entry)) {
        const slash = key.indexOf('/')
        const owner = slash === -1 ? key : key.slice(0, slash)
        if (owner !== provider) continue
        const model = slash === -1 ? key : key.slice(slash + 1)
        const scaled = ratio >= 1 ? counters : scaleCounters(counters, ratio)
        const target = models[model] ??= { ...emptyCounters(), listCost: 0 }
        addCounters(target, scaled)
        target.listCost += listCostOf(model, scaled, bucket)
      }
    }
    return models
  }

  /** 把模型级用量折算成额度并算份额。 */
  attribute(models, planId = this.state.plan) {
    const factors = this.state.factors
    const rows = []
    let totalAllowance = 0
    let totalListCost = 0
    let totalTokensValue = 0
    let totalCalls = 0
    for (const [model, counters] of Object.entries(models)) {
      const factor = factorFor(model, planId, factors)
      const allowance = counters.listCost * factor
      totalAllowance += allowance
      totalListCost += counters.listCost
      totalTokensValue += totalTokens(counters)
      totalCalls += counters.calls
      rows.push({ model, counters, listCost: counters.listCost, allowance, factor })
    }
    rows.sort((a, b) => b.allowance - a.allowance)
    for (const row of rows) {
      row.share = totalAllowance > 0 ? row.allowance / totalAllowance : 0
      row.calls = Math.round(row.counters.calls)
      row.tokens = Math.round(totalTokens(row.counters))
    }
    return { rows, totalAllowance, totalListCost, totalTokens: totalTokensValue, totalCalls }
  }

  /** 窗口起点：由 resetsAt 反推；缺失时退回 now - duration。 */
  windowStart(key, resetsAt, now = this.now()) {
    const def = WINDOWS.find((item) => item.key === key)
    if (def === undefined) return now
    const reset = Number(resetsAt)
    if (Number.isFinite(reset) && reset > 0) return reset - def.durationMs
    return now - def.durationMs
  }

  /**
   * 记录一次配额探测结果。
   *
   * 同时更新容量估计：`容量 = 本次窗口额度消耗 / 百分比`。只有账本覆盖到
   * 窗口起点时才采信，否则回扫未完成会把容量估小。
   */
  recordSample(site, result, now = this.now()) {
    if (result?.kind !== 'quota' || !Array.isArray(result.quotas)) return
    const provider = site.provider ?? site.id
    if (!this.accepts(provider)) return
    let changed = false
    for (const entry of result.quotas) {
      const window = windowKeyOf(entry?.label)
      if (window === undefined) continue
      const limit = Number(entry.limit)
      const used = Number(entry.used)
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) continue
      const percent = (used / limit) * 100
      const resetsAt = Number(entry.resetsAt) || 0
      const last = this.lastSample(site.id, window)
      if (last !== undefined && now - last.t < SAMPLE_MIN_INTERVAL_MS && last.resetsAt === resetsAt) continue
      this.state.samples.push({ t: now, site: site.id, window, percent: round(percent, 2), resetsAt })
      changed = true
      this.estimateCapacity(provider, window, percent, resetsAt, now)
    }
    if (changed) {
      this.prune()
      this.markDirty()
    }
  }

  lastSample(siteId, window) {
    for (let index = this.state.samples.length - 1; index >= 0; index -= 1) {
      const sample = this.state.samples[index]
      if (sample.site === siteId && sample.window === window) return sample
    }
    return undefined
  }

  /** 用「窗口内额度 / 百分比」估计该窗口 1% 值多少美元。 */
  estimateCapacity(provider, window, percent, resetsAt, now) {
    if (!(percent > 0)) return
    const start = this.windowStart(window, resetsAt, now)
    const earliest = this.earliestBucket()
    if (earliest === undefined || earliest > start) return
    const models = this.usageBetween(provider, start, now)
    const { totalAllowance } = this.attribute(models)
    if (!(totalAllowance > 0)) return
    const perPct = totalAllowance / percent
    const previous = this.state.capacity[window]
    if (previous === undefined) {
      this.state.capacity[window] = { perPct, at: now, n: 1 }
    } else {
      const n = Math.min((previous.n ?? 0) + 1, CAPACITY_HISTORY)
      // 滑动平均：单次估计受整数百分比影响，平均后稳定得多。
      const value = ((previous.perPct ?? perPct) * (n - 1) + perPct) / n
      this.state.capacity[window] = { perPct: value, at: now, n }
    }
  }

  /** 档位/系数变化后，按最近采样重算一次容量。 */
  refreshCapacity() {
    const entries = new Map()
    for (const sample of this.state.samples) {
      if (sample.percent > 0) entries.set(`${sample.site}/${sample.window}`, sample)
    }
    for (const sample of entries.values()) {
      const provider = this.providerOf(sample.site)
      if (provider === undefined) continue
      this.estimateCapacity(provider, sample.window, sample.percent, sample.resetsAt, sample.t)
    }
  }

  providerOf(siteId) {
    // 账本只关心 provider；站点 id 与 provider 在 OpenCode Go 上一致。
    if (this.providers.has(siteId)) return siteId
    for (const provider of this.providers) {
      if (siteId.startsWith(provider)) return provider
    }
    return undefined
  }

  /** 对外快照。 */
  status(now = this.now()) {
    const planId = this.state.plan
    return {
      plan: planId,
      plans: Object.values(PLANS).map((plan) => ({
        id: plan.id, label: plan.label, priceUsd: plan.priceUsd,
      })),
      factors: { ...this.state.factors },
      caps: capsFor(planId, this.state.factors),
      capacity: { ...this.state.capacity },
      samples: this.state.samples.length,
      backfilledAt: this.state.backfilledAt,
      backfilling: this.backfilling === true,
      providers: [...this.providers],
      updatedAt: now,
    }
  }

  /** 生成某站点的额度归因快照。 */
  summary({ site, quotas, now = this.now() }) {
    const provider = site?.provider ?? site?.id
    const planId = this.state.plan
    const caps = capsFor(planId, this.state.factors)
    const defs = []
    for (const def of WINDOWS) {
      const entry = Array.isArray(quotas)
        ? quotas.find((item) => windowKeyOf(item?.label) === def.key)
        : undefined
      const limit = Number(entry?.limit)
      const used = Number(entry?.used)
      const percent = Number.isFinite(limit) && limit > 0 && Number.isFinite(used)
        ? (used / limit) * 100
        : undefined
      const resetsAt = Number(entry?.resetsAt) || 0
      const start = this.windowStart(def.key, resetsAt, now)
      const models = provider === undefined ? {} : this.usageBetween(provider, start, now)
      const attributed = this.attribute(models, planId)
      const rows = attributed.rows.map((row) => ({
        model: row.model,
        calls: row.calls,
        tokens: row.tokens,
        inputTokens: round(row.counters.inputTokens),
        outputTokens: round(row.counters.outputTokens),
        cacheReadTokens: round(row.counters.cacheReadTokens),
        cacheWriteTokens: round(row.counters.cacheWriteTokens),
        listCost: row.listCost,
        allowance: row.allowance,
        share: row.share,
        points: percent === undefined ? undefined : (row.share * percent),
        factor: row.factor,
        monthlyCap: caps[row.model],
        monthlyUsedPct: caps[row.model] > 0 ? (row.listCost / caps[row.model]) * 100 : undefined,
      }))
      const perPctTokens = percent > 0 ? attributed.totalTokens / percent : undefined
      const perPctUsd = percent > 0 ? attributed.totalAllowance / percent : undefined
      defs.push({
        key: def.key,
        label: def.label,
        share: def.share,
        percent,
        resetsAt,
        startAt: start,
        totals: {
          calls: Math.round(attributed.totalCalls),
          tokens: Math.round(attributed.totalTokens),
          listCost: attributed.totalListCost,
          allowance: attributed.totalAllowance,
        },
        models: rows,
        perPct: { tokens: perPctTokens, usd: perPctUsd },
        remaining: percent === undefined ? undefined : {
          percent: Math.max(0, 100 - percent),
          tokens: perPctTokens === undefined ? undefined : perPctTokens * Math.max(0, 100 - percent),
          usd: perPctUsd === undefined ? undefined : perPctUsd * Math.max(0, 100 - percent),
        },
        // 折合月额度：5h 的 1% 只等于月额度的 0.2%。
        monthlyPoints: percent === undefined ? undefined : percent * def.share,
        partial: this.earliestBucket() !== undefined && this.earliestBucket() > start,
        capacity: this.state.capacity[def.key],
      })
    }
    // —— 单模型额度换算 ——
    // 构成取最近 30 天（覆盖月窗口）；没有用量的模型只给三种极端值。
    const composition = provider === undefined
      ? {}
      : this.usageBetween(provider, now - 30 * 86400 * 1000, now)
    const capsForPlan = caps
    const percents = {}
    for (const item of defs) {
      if (item.percent !== undefined) percents[item.key] = item.percent
    }
    const catalog = []
    const modelCapacityMap = {}
    for (const model of Object.keys(RATES)) {
      const cap = Number(capsForPlan[model] ?? RATES[model].cap)
      if (!(cap > 0)) continue
      catalog.push({ model, cap, factor: factorFor(model, planId, this.state.factors) })
      modelCapacityMap[model] = modelCapacity({
        model,
        composition: composition[model] ?? null,
        planId,
        factors: this.state.factors,
        percents,
      })
    }
    catalog.sort((a, b) => (b.cap - a.cap) || a.model.localeCompare(b.model))

    return {
      ok: true,
      catalog,
      modelCapacity: modelCapacityMap,
      site: site === undefined ? null : {
        id: site.id,
        label: site.label,
        provider: site.provider ?? site.id,
        baseUrl: site.baseUrl,
        lastCheckedAt: site.lastCheckedAt,
        error: site.error,
      },
      generatedAt: now,
      ...this.status(now),
      windows: defs,
    }
  }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function round(value, digits = 0) {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 探针：对站点下每个模型发一条极小请求，读回 `usage.opencode`，
 * 反算额度系数。
 *
 * 一条 2-token 请求的额度消耗约为 $0.00001，整个模型列表跑一遍不到
 * 0.01 美元。只在用户点「校准额度」时执行，不在后台自动跑。
 */
export async function probeFactors({
  baseUrl, apiKey, models, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 20_000,
}) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (base === '') return { ok: false, error: '站点没有 baseURL' }
  if (typeof apiKey !== 'string' || apiKey === '') return { ok: false, error: '该站点没有可用的密钥' }
  const factors = {}
  const details = []
  for (const entry of models ?? []) {
    const model = typeof entry === 'string' ? entry : entry?.id
    if (typeof model !== 'string' || model === '') continue
    if (RATES[model] === undefined) {
      details.push({ model, ok: false, error: '没有内置价目' })
      continue
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'x-opencode-session': 'dsh-token-metrics-probe',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 2,
          stream: false,
        }),
        signal: controller.signal,
      })
      const body = await response.json().catch(() => undefined)
      const usage = body?.usage?.opencode
      if (response.ok !== true || usage === undefined) {
        details.push({ model, ok: false, error: body?.error?.message ?? `HTTP ${response.status}` })
        continue
      }
      const counters = {
        inputTokens: Number(usage.tokens?.input) || 0,
        outputTokens: Number(usage.tokens?.output) || 0,
        cacheReadTokens: Number(usage.tokens?.cache_read) || 0,
        cacheWriteTokens: (Number(usage.tokens?.cache_write_5m) || 0)
          + (Number(usage.tokens?.cache_write_1h) || 0),
      }
      const localCost = listCostOf(model, counters, now)
      // 服务器已经给了 list_cost（它按官方价目、峰谷与档位算好），优先用它。
      // 本地估算只在字段缺失时兜底，并保留 drift 供排查价目/峰谷差异。
      const serverCost = Number(usage.list_cost)
      const listCost = Number.isFinite(serverCost) && serverCost > 0 ? serverCost : localCost
      const allowance = Number(usage.allowance)
      if (!(listCost > 0) || !Number.isFinite(allowance) || allowance <= 0) {
        details.push({ model, ok: false, error: '响应里没有可用的 allowance' })
        continue
      }
      const factor = allowance / listCost
      factors[model] = factor
      const drift = Number.isFinite(serverCost) && serverCost > 0 && localCost > 0
        ? Math.abs(serverCost - localCost) / serverCost
        : undefined
      details.push({
        model,
        ok: true,
        factor,
        listCost,
        allowance,
        localCost: localCost > 0 ? localCost : undefined,
        drift: drift !== undefined && drift > 0.15 ? drift : undefined,
      })
    } catch (error) {
      details.push({ model, ok: false, error: error?.message ?? String(error) })
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: Object.keys(factors).length > 0, factors, details }
}
