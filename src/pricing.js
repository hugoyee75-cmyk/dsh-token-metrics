/**
 * 模型价格与成本核算。
 *
 * 数据来源是 LiteLLM 维护的公开价目表
 * （https://github.com/BerriAI/litellm 的 model_prices_and_context_window.json），
 * 它汇总了各家官方公布的价格，是社区里事实上的标准。
 *
 * 三条设计约束：
 *
 * 1. **零运行时依赖**：只用 Node 内置模块，不引入任何 npm 包。
 * 2. **离线可用**：拉取失败就用磁盘缓存；缓存也没有就用内置的最小价目表。
 *    成本核算不能因为网络问题而完全失效。
 * 3. **用户可覆盖**：中转站的模型名往往是自定义的（`qfmodel`）、且会加价，
 *    所以必须允许手工补价与倍率，否则算出来的数字没有意义。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** LiteLLM 价目表地址。 */
export const PRICE_LIST_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** 汇率接口：open.er-api.com 免费、无需 key。 */
export const FX_URL = 'https://open.er-api.com/v6/latest/USD'

/**
 * 内置兜底价目表（每 token 美元）。
 *
 * 只在「拉取失败 + 无缓存」时使用，覆盖最主流的几个模型，保证成本核算
 * 至少不会彻底空白。数值取自各厂商公开定价，按每百万 token 换算。
 */
export const BUILTIN_PRICES = {
  'deepseek-chat': { input: 0.28e-6, output: 0.42e-6, cacheRead: 0.028e-6, cacheWrite: 0 },
  'deepseek-reasoner': { input: 0.28e-6, output: 0.42e-6, cacheRead: 0.028e-6, cacheWrite: 0 },
  'gpt-4o': { input: 2.5e-6, output: 10e-6, cacheRead: 1.25e-6, cacheWrite: 0 },
  'gpt-4o-mini': { input: 0.15e-6, output: 0.6e-6, cacheRead: 0.075e-6, cacheWrite: 0 },
  'claude-3-5-sonnet': { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 },
  'claude-3-5-haiku': { input: 0.8e-6, output: 4e-6, cacheRead: 0.08e-6, cacheWrite: 1e-6 },
}

/** 默认美元兑人民币汇率（拉取失败时用）。 */
export const DEFAULT_USD_CNY = 7.2

/**
 * 把模型名归一化，用于宽松比对。
 *
 * 中转站的模型名常带渠道前缀（`z-ai/glm-5.3-flash`）、大小写不一、
 * 用 `-`/`_`/`.` 混排。这里统一成「小写、连字符分隔、去掉渠道前缀」。
 */
export function normalizeModelName(name) {
  if (typeof name !== 'string' || name === '') return ''
  // 去掉最后一个 `/` 之前的部分（渠道前缀），但保留形如 `deepseek-ai/x` 的信息
  const tail = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  return tail
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * 从 LiteLLM 的原始价目表里挑出可用的条目。
 *
 * 只保留 chat 类、且有 input/output 单价的条目——embedding、image 等
 * 与 token 计费无关，混进来只会让匹配误命中。
 *
 * @returns {Record<string, {input:number,output:number,cacheRead:number,cacheWrite:number}>}
 */
export function extractChatPrices(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [name, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.mode !== undefined && entry.mode !== 'chat') continue
    const input = numberOrUndefined(entry.input_cost_per_token)
    const output = numberOrUndefined(entry.output_cost_per_token)
    if (input === undefined || output === undefined) continue
    const price = {
      input,
      output,
      cacheRead: numberOrUndefined(entry.cache_read_input_token_cost) ?? input,
      // 缓存写入价缺失时按输入价算——这是多数厂商的实际策略，
      // 比当作 0（免费）更接近真实账单。
      cacheWrite: numberOrUndefined(entry.cache_creation_input_token_cost) ?? input,
    }
    // 峰谷定价：少数厂商（目前只有 DeepSeek 系）分时段计价，
    // 谷时价通常是峰时的一半。LiteLLM 用 off_peak_pricing 表达，
    // 附带 windows 时段定义，这里原样保留供成本计算按调用时刻取用。
    const offPeak = parseOffPeak(entry.off_peak_pricing)
    if (offPeak !== undefined) price.offPeak = offPeak
    out[name] = price
  }
  return out
}

/**
 * 渠道可信度评分，用于在多个同名条目间挑出最权威的那个。
 *
 * 同一模型在 LiteLLM 里会有十几条记录（各大云厂商与转售商），价格能差
 * 几十倍。直接按字典序或『第一个命中』取会随机落到某个转售商身上，
 * 算出来的成本毫无参考价值。
 *
 * 评分规则：官方直营最高，其次是主流云，转售聚合最低。
 */
const CHANNEL_TRUST = {
  // 官方直营（键名形如 `openai/xxx` 里的 provider 段）
  openai: 100,
  anthropic: 100,
  deepseek: 100,
  google: 95,
  gemini: 95,
  vertex_ai: 90,
  mistral: 90,
  cohere: 90,
  meta: 90,
  qwen: 90,
  dashscope: 90,
  xai: 90,
  moonshot: 90,
  zai: 90,
  // 主流云
  azure: 80,
  azure_ai: 80,
  bedrock: 80,
  together_ai: 70,
  fireworks_ai: 70,
  groq: 70,
  deepinfra: 60,
  nebius: 60,
  hyperbolic: 50,
  openrouter: 40,
  // 转售聚合：价格波动大，可信度最低
  coralbricks: 10,
  inferenceapis: 10,
  sail: 10,
  scx_ai: 10,
}

/**
 * 给一个价目表条目打信任分。
 *
 * - 无渠道前缀（`gpt-4o`、`deepseek-v4-flash`）视为中性偏高：
 *   这些通常是官方公布价。
 * - 有前缀的按 provider 段查表；未知渠道给一个低分。
 */
export function channelTrust(name) {
  if (typeof name !== 'string') return 0
  const slash = name.indexOf('/')
  if (slash === -1) return 60  // 无前缀：多半是官方价
  const provider = name.slice(0, slash).toLowerCase()
  return CHANNEL_TRUST[provider] ?? 20
}

/**
 * 解析 LiteLLM 的 `off_peak_pricing`。
 *
 * 结构：
 *   {
 *     input_cost_per_token, output_cost_per_token,
 *     cache_read_input_token_cost,
 *     windows: [{ hours_utc: ["00:00-01:00", ...] | "00:00-00:00",
 *                 weekdays: [1..7] }]
 *   }
 *
 * `hours_utc` 为单个字符串 `"00:00-00:00"` 表示全天（周末就是这种写法）。
 *
 * @returns {{input,output,cacheRead,cacheWrite,windows}|undefined}
 */
export function parseOffPeak(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined
  const input = numberOrUndefined(raw.input_cost_per_token)
  const output = numberOrUndefined(raw.output_cost_per_token)
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    cacheRead: numberOrUndefined(raw.cache_read_input_token_cost) ?? input,
    cacheWrite: numberOrUndefined(raw.cache_creation_input_token_cost) ?? input,
    windows: Array.isArray(raw.windows) ? raw.windows : [],
  }
}

/**
 * 判断某个 UTC 时刻是否落在谷时窗口内。
 *
 * 模型可能有多组窗口（工作日若干时段 + 周末全天），命中任一即算谷时。
 * 没有窗口定义时返回 false——宁可按峰时（较贵）估算，也不要漏算。
 *
 * @param {Date} at UTC 时刻
 * @param {object[]} windows
 */
export function isOffPeak(at, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  const weekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay()  // ISO：周一=1，周日=7
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes()
  for (const window of windows) {
    if (window === null || typeof window !== 'object') continue
    const days = Array.isArray(window.weekdays) ? window.weekdays : []
    if (days.length > 0 && !days.includes(weekday)) continue
    const hours = window.hours_utc
    // 单字符串且首尾相同 -> 表示全天
    if (typeof hours === 'string') {
      const [from, to] = hours.split('-')
      if (from === to) return true
      if (within(minutes, from, to)) return true
      continue
    }
    if (Array.isArray(hours)) {
      for (const range of hours) {
        const [from, to] = String(range).split('-')
        if (within(minutes, from, to)) return true
      }
    }
  }
  return false
}

/** 判断分钟数是否落在 [from, to) 区间内（跨零点也支持）。 */
function within(minutes, from, to) {
  const a = toMinutes(from)
  const b = toMinutes(to)
  if (a === null || b === null) return false
  if (a <= b) return minutes >= a && minutes < b
  // 跨零点，例如 22:00-02:00
  return minutes >= a || minutes < b
}

function toMinutes(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
  if (match === null) return null
  const hours = Number(match[1])
  const mins = Number(match[2])
  if (hours > 24 || mins > 59) return null
  return hours * 60 + mins
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 为某个模型名找到最合适的价格条目。
 *
 * 查找顺序（越靠前越可信）：
 *  1. 用户手工补价（完全按名字）
 *  2. 归一化后完全相等
 *  3. 归一化后互为前缀（`deepseek-v4.1-flash` ↔ `deepseek-v4-flash`）
 *  4. 包含关系（最后手段）
 *
 * 命中的条目会带 `matchedName`，便于页面上说明「按哪个价格算的」。
 */
/**
 * 归一化索引缓存。
 *
 * 为什么需要：`resolvePrice` 每算一个模型都要遍历整张价目表（约 2880 条）
 * 并逐条 `normalizeModelName`。一次统计快照要对几十个模型各算一遍，复杂
 * 度是 O(模型数 × 表大小)；实测 400 天 × 30 模型时单次快照要 7.7 秒，
 * 且阻塞 DSH 主进程。
 *
 * 用 WeakMap 以价目表对象身份作键：表换了会自动失效，不需要手动清缓存。
 * 索引里同时存「归一化名 -> 原始名列表」，原始精确匹配仍走 table 直查。
 */
const normalizedIndexCache = new WeakMap()

/** 取（或建）价目表的归一化索引：`normalized -> [原始名...]`。 */
function normalizedIndex(table) {
  let index = normalizedIndexCache.get(table)
  if (index !== undefined) return index
  index = new Map()
  for (const name of Object.keys(table)) {
    const normalized = normalizeModelName(name)
    if (normalized === '') continue
    const bucket = index.get(normalized)
    if (bucket === undefined) index.set(normalized, [name])
    else bucket.push(name)
  }
  normalizedIndexCache.set(table, index)
  return index
}

export function resolvePrice(modelName, priceTable, overrides = {}) {
  if (typeof modelName !== 'string' || modelName === '') return undefined
  // 手工补价优先，且按原始名字精确匹配（用户写什么就是什么）
  const manual = overrides[modelName]
  if (manual !== undefined) return { ...manual, matchedName: modelName, source: 'manual' }

  const table = priceTable ?? {}
  if (table[modelName] !== undefined) {
    return { ...table[modelName], matchedName: modelName, source: 'table' }
  }

  const target = normalizeModelName(modelName)
  if (target === '') return undefined

  // 收集所有命中，再按可信度挑——不能拿到第一个就用，
  // 否则会随机落到某个转售商的价格上。
  const index = normalizedIndex(table)
  // 精确命中：O(1) 查索引，不再全表遍历
  const exact = index.get(target) ?? []
  // 前缀候选：仍需扫索引键，但只处理「归一化名」而非每条都重新 normalize，
  // 且价目表结构稳定后索引会一直复用（WeakMap 缓存）。
  const prefix = []
  for (const [normalized, names] of index) {
    if (normalized === target) continue
    if (!target.startsWith(normalized) && !normalized.startsWith(target)) continue
    const overlap = Math.min(normalized.length, target.length)
    for (const name of names) prefix.push({ name, overlap })
  }

  /** 候选排序：信任分高的优先；同分取名字更接近的（overlap 大）。 */
  const pick = (names, overlapOf = () => 0) => {
    let best
    let bestScore = -1
    let bestOverlap = -1
    for (const name of names) {
      const score = channelTrust(name)
      const overlap = overlapOf(name)
      if (score > bestScore || (score === bestScore && overlap > bestOverlap)) {
        best = name
        bestScore = score
        bestOverlap = overlap
      }
    }
    return best
  }

  const exactBest = pick(exact)
  if (exactBest !== undefined) {
    return { ...table[exactBest], matchedName: exactBest, source: 'table' }
  }
  const prefixBest = pick(
    prefix.map((entry) => entry.name),
    (name) => prefix.find((entry) => entry.name === name)?.overlap ?? 0,
  )
  if (prefixBest !== undefined) {
    return { ...table[prefixBest], matchedName: prefixBest, source: 'fuzzy' }
  }
  return undefined
}

/**
 * 按 token 用量算出成本（美元）。
 *
 * `multiplier` 是给中转站加价用的：同一个模型在不同渠道可能按官方价的
 * 不同倍率计费，这是用户明确提出的需求。
 */
export function costOf(counters, price, multiplier = 1, options = {}) {
  if (price === undefined || price === null) return 0
  // 峰谷定价：分时段计价的厂商（目前是 DeepSeek 系）在谷时按另一套低价算。
  // 调用方通过 `at`（UTC 时刻）告知这批用量发生在什么时候；未给出时按峰时
  // 估算——宁可偏高也不要漏算。
  const useOffPeak = price.offPeak !== undefined
    && (options.offPeak === true
      || (options.at !== undefined && isOffPeak(options.at, price.offPeak.windows)))
  const effective = useOffPeak ? price.offPeak : price
  const input = counters?.inputTokens ?? 0
  const output = counters?.outputTokens ?? 0
  const cacheRead = counters?.cacheReadTokens ?? 0
  const cacheWrite = counters?.cacheWriteTokens ?? 0
  const raw = input * (effective.input ?? 0)
    + output * (effective.output ?? 0)
    + cacheRead * (effective.cacheRead ?? 0)
    + cacheWrite * (effective.cacheWrite ?? 0)
  // 推理 token **不再单独计价**：上游的 outputTokens 已经包含思考部分
  // （实测 10 个有 reasoning 的模型，reasoning 恒 <= output，无一例外；
  //  这是「子集」而非「额外」的强证据）。
  // 早先又按输出价加了一次 reasoning，等于对同一批 token 收两遍钱——
  // 对整体影响约 +0.8%，对推理占比高的模型偏差更大。
  // reasoningTokens 仍保留在统计里，只是不参与金额计算。
  const factor = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  return raw * factor
}

/**
 * 价目表管理器：负责拉取、缓存、以及把结果交给成本计算。
 *
 * 缓存写在插件的数据目录里（与用量数据同级），这样离线重启也能用。
 */
export class PriceBook {
  /**
   * @param {object} options
   * @param {string} options.dataDir 缓存目录
   * @param {() => number} [options.now] 可注入的时钟，便于测试
   * @param {typeof fetch} [options.fetchImpl] 可注入的 fetch，便于测试
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.now = options.now ?? (() => Date.now())
    this.fetchImpl = options.fetchImpl
    this.log = options.log
    /** @type {Record<string, object>} */
    this.table = {}
    this.updatedAt = 0
    /** 用户手工补价：模型名 -> {input, output, cacheRead, cacheWrite} */
    this.overrides = {}
    /** 供应商倍率：provider 路由名 -> number */
    this.multipliers = {}
    /**
     * 模型别名：原始名 -> 显示名。
     *
     * 部分 provider 上报内部代号（Qoder 的 `qfmodel` 是上游队列 modelKey），
     * 不是真实模型名。这些代号无法从 DSH 元数据反查，只能由用户指定。
     */
    this.aliases = {}
    /** 美元兑人民币 */
    this.usdCny = DEFAULT_USD_CNY
    this.fxUpdatedAt = 0
    this.error = ''
    this.fxError = ''
  }

  get cachePath() {
    return join(this.dataDir, 'prices.json')
  }

  get fxCachePath() {
    return join(this.dataDir, 'fx.json')
  }

  /** 从磁盘读取缓存（价目表 + 汇率 + 手工补价 + 倍率）。 */
  load() {
    try {
      if (existsSync(this.cachePath)) {
        const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8'))
        this.table = parsed.table ?? {}
        this.updatedAt = parsed.updatedAt ?? 0
        this.overrides = parsed.overrides ?? {}
        this.multipliers = parsed.multipliers ?? {}
        this.aliases = parsed.aliases ?? {}
      }
    } catch (error) {
      this.log?.(`token-metrics: 读取价目表缓存失败（${error?.message ?? error}）`)
    }
    try {
      if (existsSync(this.fxCachePath)) {
        const parsed = JSON.parse(readFileSync(this.fxCachePath, 'utf8'))
        if (typeof parsed.usdCny === 'number' && parsed.usdCny > 0) {
          this.usdCny = parsed.usdCny
          this.fxUpdatedAt = parsed.fxUpdatedAt ?? 0
        }
      }
    } catch { /* 汇率缓存坏了不影响主流程 */ }
    // 完全没有缓存时用内置价目表兜底，保证首次离线也能算
    if (Object.keys(this.table).length === 0) {
      this.table = { ...BUILTIN_PRICES }
      this.updatedAt = 0
    }
    return this
  }

  /** 保存手工补价、倍率与价目表到磁盘。 */
  save() {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true })
      writeFileSync(this.cachePath, JSON.stringify({
        table: this.table,
        updatedAt: this.updatedAt,
        overrides: this.overrides,
        multipliers: this.multipliers,
        aliases: this.aliases,
      }), 'utf8')
    } catch (error) {
      this.log?.(`token-metrics: 保存价目表失败（${error?.message ?? error}）`)
    }
  }

  /** 更新手工补价（并按需持久化）。 */
  setOverride(modelName, price) {
    if (typeof modelName !== 'string' || modelName === '') return
    if (price === null) {
      delete this.overrides[modelName]
    } else {
      this.overrides[modelName] = {
        input: numeric(price?.input),
        output: numeric(price?.output),
        cacheRead: numeric(price?.cacheRead ?? price?.input),
        cacheWrite: numeric(price?.cacheWrite ?? price?.input),
      }
    }
    this.save()
  }

  /** 设置某个 provider 的加价倍率。 */
  setMultiplier(provider, multiplier) {
    if (typeof provider !== 'string' || provider === '') return
    const value = Number(multiplier)
    if (!Number.isFinite(value) || value <= 0) {
      delete this.multipliers[provider]
    } else {
      this.multipliers[provider] = value
    }
    this.save()
  }

  /** 设置模型别名（显示名）。传 null 或空串表示删除。 */
  setAlias(rawName, displayName) {
    if (typeof rawName !== 'string' || rawName === '') return
    const value = typeof displayName === 'string' ? displayName.trim() : ''
    if (value === '') delete this.aliases[rawName]
    else this.aliases[rawName] = value
    this.save()
  }

  /** 该 provider 的倍率（没有就用 1）。 */
  multiplierOf(provider) {
    const value = this.multipliers[provider]
    return Number.isFinite(value) && value > 0 ? value : 1
  }

  /** 是否需要刷新（默认 24 小时）。 */
  needsRefresh(intervalMs = 24 * 60 * 60 * 1000) {
    return this.updatedAt === 0 || this.now() - this.updatedAt > intervalMs
  }

  /**
   * 拉取最新价目表。
   *
   * 失败时保留旧表并记录错误——绝不把已有价目表清空，
   * 否则用户会看到成本突然全部变成 0。
   */
  async refresh() {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      this.error = '当前环境没有 fetch'
      return false
    }
    try {
      /**
       * 拉价目表必须带超时、禁重定向。
       *
       * 早先这里什么都没加：网络卡住时 fetch 会一直挂着，启动流程被拖死；
       * 而 `redirect: 'error'` 与其他出站请求保持一致 —— 避免请求被转到
       * 别的域名（价目表 URL 是固定的公开地址，不需要跟随重定向）。
       */
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), 20_000)
      let response
      try {
        response = await fetchImpl(PRICE_LIST_URL, {
          headers: { 'user-agent': 'dsh-token-metrics' },
          signal: controller?.signal,
          redirect: 'error',
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const raw = await response.json()
      const table = extractChatPrices(raw)
      if (Object.keys(table).length === 0) throw new Error('价目表为空')
      this.table = table
      this.updatedAt = this.now()
      this.error = ''
      this.save()
      this.log?.(`token-metrics: 价目表已更新，${Object.keys(table).length} 个模型`)
      return true
    } catch (error) {
      this.error = `获取价目表失败：${error?.message ?? error}`
      this.log?.(`token-metrics: ${this.error}`)
      return false
    }
  }

  /** 拉取实时汇率。失败保留旧值。 */
  async refreshFx() {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return false
    try {
      // 与价目表一致：带超时、禁重定向。汇率接口卡住同样会拖住启动。
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), 10_000)
      let response
      try {
        response = await fetchImpl(FX_URL, {
          headers: { 'user-agent': 'dsh-token-metrics' },
          signal: controller?.signal,
          redirect: 'error',
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const rate = Number(body?.rates?.CNY)
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('汇率无效')
      this.usdCny = rate
      this.fxUpdatedAt = this.now()
      this.fxError = ''
      try {
        mkdirSync(dirname(this.fxCachePath), { recursive: true })
        writeFileSync(this.fxCachePath, JSON.stringify({
          usdCny: this.usdCny, fxUpdatedAt: this.fxUpdatedAt,
        }), 'utf8')
      } catch { /* 缓存写失败不影响本次使用 */ }
      this.log?.(`token-metrics: 汇率已更新 USD/CNY = ${rate}`)
      return true
    } catch (error) {
      this.fxError = `获取汇率失败：${error?.message ?? error}`
      return false
    }
  }

  /** 对外暴露的只读状态（给页面展示价目表状态）。 */
  status() {
    return {
      modelCount: Object.keys(this.table).length,
      updatedAt: this.updatedAt,
      usdCny: this.usdCny,
      fxUpdatedAt: this.fxUpdatedAt,
      error: this.error,
      fxError: this.fxError,
      overrides: { ...this.overrides },
      multipliers: { ...this.multipliers },
      aliases: { ...this.aliases },
    }
  }
}

function numeric(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}
