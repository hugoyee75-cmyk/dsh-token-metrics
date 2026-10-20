/**
 * 官方平台的余额与配额查询。
 *
 * 与 `balance.js` 里那套「中转站通用探测」不同：官方平台的接口各不相同，
 * 响应结构也没有统一标准，只能一家一个适配器。
 *
 * 两类结果：
 *
 *  1. **余额型**（DeepSeek / OpenRouter / SiliconFlow / Novita）
 *     给一个美元数额，页面显示 `余额 $12.34`。
 *
 *  2. **配额型**（Kimi / GLM 的 Coding Plan）
 *     给若干「时间窗口 + 已用/上限」，页面画进度条并显示重置时间，
 *     例如 `5-hour 40% used  2h 后重置`。
 *
 * 设计约束：不抛异常。查询失败只返回 `{ ok:false, error }`，
 * 因为余额是辅助信息，不该让整个页面挂掉。
 */

/** 平台识别：按 baseURL 的主机名匹配。顺序重要，更具体的放前面。 */
const HOST_PATTERNS = [
  { id: 'deepseek', test: /(^|\.)api\.deepseek\.com$/ },
  { id: 'kimi', test: /(^|\.)api\.kimi\.com$/ },
  { id: 'glm', test: /(^|\.)(open\.bigmodel\.cn|api\.z\.ai)$/ },
  { id: 'minimax', test: /(^|\.)api\.minimax\.(io|chat)$/ },
  { id: 'openrouter', test: /(^|\.)openrouter\.ai$/ },
  { id: 'siliconflow', test: /(^|\.)api\.siliconflow\.(cn|com)$/ },
  { id: 'novita', test: /(^|\.)api\.novita\.ai$/ },
  { id: 'stepfun', test: /(^|\.)api\.stepfun\.(ai|com)$/ },
  { id: 'anthropic', test: /(^|\.)api\.anthropic\.com$/ },
  { id: 'openai', test: /(^|\.)api\.openai\.com$/ },
  // Codex / ChatGPT 订阅的用量接口在 chatgpt.com 上，不在 api.openai.com
  { id: 'codex', test: /(^|\.)(chatgpt\.com|chat\.openai\.com)$/ },
  { id: 'gemini', test: /(^|\.)(generativelanguage\.googleapis\.com|aistudio\.google\.com)$/ },
]

/**
 * 从 baseURL 识别官方平台。
 *
 * @returns {string|undefined} 平台 id；识别不出返回 undefined（走中转站探测）
 */
export function detectProvider(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined
  let host
  try {
    host = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).hostname
  } catch {
    return undefined
  }
  for (const pattern of HOST_PATTERNS) {
    if (pattern.test.test(host)) return pattern.id
  }
  return undefined
}

/** 各平台的展示名，供页面标注。 */
export const PROVIDER_LABELS = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi (Moonshot)',
  glm: '智谱 GLM',
  minimax: 'MiniMax',
  openrouter: 'OpenRouter',
  siliconflow: 'SiliconFlow',
  novita: 'Novita AI',
  stepfun: '阶跃星辰',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  codex: 'ChatGPT (Codex)',
  gemini: 'Google Gemini',
}

//#region 工具

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** 发一个 GET 并尽力解析 JSON；失败返回 undefined。 */
async function getJson(url, apiKey, fetchImpl, extraHeaders = {}, timeoutMs = 12_000) {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {
      accept: 'application/json',
      'user-agent': 'dsh-token-metrics',
      ...extraHeaders,
    }
    if (typeof apiKey === 'string' && apiKey !== '') {
      headers.authorization = `Bearer ${apiKey}`
    }
    const response = await fetchImpl(url, { headers, signal: controller?.signal, redirect: 'error' })
    if (!response.ok) return { status: response.status }
    const body = await response.json().catch(() => undefined)
    return { status: response.status, body }
  } catch (error) {
    return { status: 0, error: error?.message ?? String(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 把一个「已用 / 上限」窗口归一化成配额条目。
 *
 * `used` 与 `limit` 必须同单位。页面据此算百分比。
 */
function quota(label, used, limit, resetsAt, unit) {
  const usedNum = num(used)
  const limitNum = num(limit)
  if (usedNum === undefined && limitNum === undefined) return undefined
  return {
    label,
    used: usedNum,
    limit: limitNum,
    resetsAt: num(resetsAt),
    unit: typeof unit === 'string' ? unit : undefined,
  }
}

//#endregion

//#region 余额型适配器

/** DeepSeek：/user/balance 返回 balance_infos 数组。 */
async function probeDeepseek({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  const result = await getJson(`${origin}/user/balance`, apiKey, fetchImpl)
  if (result.body === undefined) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` }
  }
  const infos = Array.isArray(result.body.balance_infos) ? result.body.balance_infos : []
  // 优先取 USD，其次取第一条（有的账号只有 CNY）
  const usd = infos.find((entry) => String(entry?.currency ?? '').toUpperCase() === 'USD')
  const picked = usd ?? infos[0]
  const total = num(picked?.total_balance)
  if (total === undefined) return { ok: false, error: '响应里没有 total_balance' }
  return {
    ok: true,
    kind: 'balance',
    // 非美元的金额不做换算（汇率因平台而异），标注原始币种
    usd: String(picked?.currency ?? '').toUpperCase() === 'USD' ? total : undefined,
    raw: total,
    currency: String(picked?.currency ?? '').toUpperCase() || undefined,
    isAvailable: result.body.is_available !== false,
  }
}

/** OpenRouter：/api/v1/credits 返回 total_credits / total_usage。 */
async function probeOpenrouter({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  const result = await getJson(`${origin}/api/v1/credits`, apiKey, fetchImpl)
  const data = result.body?.data ?? result.body
  const total = num(data?.total_credits)
  const used = num(data?.total_usage)
  if (total === undefined) return { ok: false, error: result.error ?? '响应里没有 total_credits' }
  return {
    ok: true,
    kind: 'balance',
    usd: used === undefined ? total : total - used,
    usedUsd: used,
    limitUsd: total,
  }
}

/** SiliconFlow：返回 totalBalance（字符串金额）。 */
async function probeSiliconflow({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  // 官方接口在 /v1/user/info
  for (const path of ['/v1/user/info', '/user/info']) {
    const result = await getJson(`${origin}${path}`, apiKey, fetchImpl)
    const data = result.body?.data ?? result.body
    const total = num(data?.totalBalance ?? data?.balance)
    if (total !== undefined) {
      return { ok: true, kind: 'balance', usd: total, currency: 'CNY' }
    }
  }
  return { ok: false, error: '没有找到余额字段' }
}

/** Novita：/v1/user/balance 返回 balance_infos 或可用余额。 */
async function probeNovita({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  for (const path of ['/v1/user/balance', '/user/balance']) {
    const result = await getJson(`${origin}${path}`, apiKey, fetchImpl)
    const body = result.body
    if (body === undefined) continue
    const infos = Array.isArray(body.balance_infos) ? body.balance_infos : []
    const usd = infos.find((entry) => String(entry?.currency ?? '').toUpperCase() === 'USD')
    const total = num(usd?.total_balance ?? body.balance ?? body.total_balance)
    if (total !== undefined) {
      return {
        ok: true, kind: 'balance',
        usd: usd !== undefined || !infos.length ? total : undefined,
        raw: total,
        currency: usd === undefined && infos.length ? String(infos[0]?.currency ?? '') : 'USD',
      }
    }
  }
  return { ok: false, error: '没有找到余额字段' }
}

/** 阶跃星辰：/v1/accounts 或 /user/balance。 */
async function probeStepfun({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  for (const path of ['/v1/user/balance', '/user/balance']) {
    const result = await getJson(`${origin}${path}`, apiKey, fetchImpl)
    const data = result.body?.data ?? result.body
    const total = num(data?.balance ?? data?.total_balance)
    if (total !== undefined) {
      return { ok: true, kind: 'balance', usd: total, currency: 'CNY' }
    }
  }
  return { ok: false, error: '没有找到余额字段' }
}

//#endregion

//#region 配额型适配器

/**
 * 配额窗口名归一化。
 *
 * 不能只认写死的几个键：不同账号/版本会返回不同窗口（five_hour、
 * weekly_limit、monthly、甚至自定义名）。用写死白名单会静默丢限额——
 * 「只看得到 5 小时限额、看不到周限额」就是这么来的。
 */
const WINDOW_LABELS = {
  five_hour: '5-hour',
  five_hourly: '5-hour',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly_limit: 'Weekly',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

/** 把任意窗口标识（字符串或单键对象）转成展示名。 */
export function windowLabel(window) {
  if (window === undefined || window === null) return 'Quota'
  if (typeof window === 'string') return WINDOW_LABELS[window] ?? window
  if (typeof window === 'object') {
    const keys = Object.keys(window)
    if (keys.length === 0) return 'Quota'
    return WINDOW_LABELS[keys[0]] ?? keys[0]
  }
  return 'Quota'
}


/**
 * Kimi（Moonshot）Coding Plan：`/coding/v1/usages`。
 *
 * 响应里 `limits[]` 每项给出一个时间窗口：
 *   { detail: { remaining, resetTime }, window: { five_hour | weekly_limit } }
 * 或旧的扁平形态 `usage` / `limits`。这里两种都兼容。
 */
async function probeKimi({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  const result = await getJson(`${origin}/coding/v1/usages`, apiKey, fetchImpl)
  if (result.body === undefined) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` }
  }
  const body = result.body
  // 有的版本把数据包在 data 里
  const payload = body.data ?? body
  const quotas = []



  // 形态 A：limits 数组
  if (Array.isArray(payload.limits)) {
    for (const entry of payload.limits) {
      const detail = entry?.detail ?? entry
      const remaining = num(detail?.remaining)
      const limit = num(detail?.limit ?? detail?.total)
      // Kimi 只给 remaining 时，用 remaining 与「已用」推上限
      const used = num(detail?.used)
      const resetsAt = num(detail?.resetTime ?? detail?.resets_at)
      const q = quota(
        windowLabel(entry?.window),
        used ?? (remaining !== undefined && limit !== undefined ? limit - remaining : undefined),
        limit ?? (remaining !== undefined && used !== undefined ? remaining + used : undefined),
        resetsAt,
        detail?.unit,
      )
      if (q !== undefined) quotas.push(q)
    }
  }

  // 形态 B：usage 下平铺多个窗口。遍历全部键，避免漏掉未列举的窗口。
  const usage = payload.usage ?? payload
  if (usage !== null && typeof usage === 'object') {
    for (const [key, entry] of Object.entries(usage)) {
      if (entry === null || typeof entry !== 'object') continue
      const used = num(entry.used_value_usd ?? entry.used)
      const limit = num(entry.max_value_usd ?? entry.limit)
      const q = quota(
        WINDOW_LABELS[key] ?? key,
        used, limit,
        num(entry.resets_at ?? entry.resetTime),
        entry.unit ?? 'USD',
      )
      if (q !== undefined && !quotas.some((item) => item.label === q.label)) quotas.push(q)
    }
  }

  if (quotas.length === 0) {
    // 明确的「没有订阅」比含糊的解析失败更有用
    if (String(body.msg ?? body.message ?? '').toLowerCase().includes('coding plan')) {
      return { ok: false, error: '该账号没有 Coding Plan 订阅', noPlan: true }
    }
    return { ok: false, error: '响应里没有配额字段' }
  }
  return { ok: true, kind: 'quota', quotas }
}

/**
 * 智谱 GLM Coding Plan：`/api/monitor/usage/quota/limit`。
 *
 * 返回形如 `{ code, msg, success, data: { limits: [...] } }`。
 * 账号没有 coding plan 时 `code` 非 0 并给出说明——那是有效信息，不是错误。
 */
async function probeGlm({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  // 用户可能填的是 /api/anthropic 这种子路径，配额接口在根下
  const result = await getJson(`${origin}/api/monitor/usage/quota/limit`, apiKey, fetchImpl)
  if (result.body === undefined) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` }
  }
  const body = result.body
  if (body.success === false || (body.code !== undefined && body.code !== 0 && body.code !== 200)) {
    const message = String(body.msg ?? body.message ?? '')
    return {
      ok: false,
      error: message === '' ? `平台返回 code=${body.code}` : message,
      noPlan: /coding plan|不存在/i.test(message),
    }
  }
  const data = body.data ?? body
  const quotas = []
  const list = Array.isArray(data?.limits) ? data.limits : Array.isArray(data) ? data : []
  for (const entry of list) {
    const rawLabel = entry?.type ?? entry?.window ?? entry?.label
    const used = num(entry?.used ?? entry?.current ?? entry?.usage)
    const limit = num(entry?.limit ?? entry?.total ?? entry?.max)
    const resetsAt = num(entry?.resetTime ?? entry?.resets_at ?? entry?.reset_time)
    const q = quota(windowLabel(rawLabel), used, limit, resetsAt, entry?.unit)
    if (q !== undefined) quotas.push(q)
  }
  if (quotas.length === 0) return { ok: false, error: '响应里没有配额字段' }
  return { ok: true, kind: 'quota', quotas }
}

/**
 * MiniMax：AFP usage。
 *
 * 响应外层有 `base_resp.status_code` 表示成败，业务数据在 `data` 里。
 */
async function probeMinimax({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  const result = await getJson(`${origin}/v1/usage`, apiKey, fetchImpl)
  if (result.body === undefined) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` }
  }
  const body = result.body
  const statusCode = num(body?.base_resp?.status_code)
  if (statusCode !== undefined && statusCode !== 0) {
    return {
      ok: false,
      error: String(body?.base_resp?.status_msg ?? `status_code=${statusCode}`),
    }
  }
  const data = body.data ?? body
  const quotas = []

  // limits 数组形态
  if (Array.isArray(data?.limits)) {
    for (const entry of data.limits) {
      const q = quota(
        windowLabel(entry?.type ?? entry?.window),
        num(entry?.used ?? entry?.current),
        num(entry?.limit ?? entry?.total),
        num(entry?.resetTime ?? entry?.resets_at),
        entry?.unit,
      )
      if (q !== undefined) quotas.push(q)
    }
  }

  // 平铺形态：遍历全部窗口键，不写死白名单
  if (quotas.length === 0 && data !== null && typeof data === 'object') {
    for (const [key, entry] of Object.entries(data)) {
      if (entry === null || typeof entry !== 'object') continue
      // 跳过明显的非窗口字段
      if (key === 'base_resp' || key === 'balance' || key === 'remaining') continue
      const q = quota(
        windowLabel(key),
        num(entry.used_value_usd ?? entry.used),
        num(entry.max_value_usd ?? entry.limit),
        num(entry.resets_at ?? entry.resetTime),
        entry.unit ?? 'USD',
      )
      if (q !== undefined) quotas.push(q)
    }
  }
  const balance = num(data?.balance ?? data?.remaining)
  if (quotas.length === 0) {
    if (balance !== undefined) return { ok: true, kind: 'balance', usd: balance }
    return { ok: false, error: '响应里没有余额或配额字段' }
  }
  return { ok: true, kind: 'quota', quotas }
}

//#endregion

/**
 * ChatGPT / Codex 订阅用量。
 *
 * 结构与 CC Switch 里的 `CodexUsageResponse` 一致：
 *   { rate_limit: { primary: { used_percent, limit_window_seconds, resets_at },
 *                   secondary: {...} } }
 * primary 通常是 5 小时窗口，secondary 是周窗口。
 *
 * 注意：这个接口需要 ChatGPT 的 OAuth token，不是普通的 API key。
 */
async function probeCodex({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  const result = await getJson(`${origin}/backend-api/codex/usage`, apiKey, fetchImpl)
  if (result.body === undefined) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` }
  }
  const rateLimit = result.body.rate_limit ?? result.body
  const quotas = []

  /** 把一个 CodexRateLimitWindow 转成配额条目。 */
  const toQuota = (window, fallbackLabel) => {
    if (window === null || typeof window !== 'object') return undefined
    const usedPercent = num(window.used_percent)
    if (usedPercent === undefined) return undefined
    // 窗口长度换算成可读标签
    const seconds = num(window.limit_window_seconds)
    let label = fallbackLabel
    if (seconds !== undefined && seconds > 0) {
      if (seconds <= 6 * 3600) label = '5-hour'
      else if (seconds <= 8 * 86400) label = 'Weekly'
      else if (seconds <= 32 * 86400) label = 'Monthly'
    }
    // used_percent 是「已用百分比」，转成 used/limit 的 100 分制
    return quota(
      label,
      usedPercent,
      100,
      num(window.resets_at ?? window.resets_in_seconds),
      '%',
    )
  }

  const primary = toQuota(rateLimit?.primary, '5-hour')
  const secondary = toQuota(rateLimit?.secondary, 'Weekly')
  if (primary !== undefined) quotas.push(primary)
  if (secondary !== undefined) quotas.push(secondary)

  if (quotas.length === 0) {
    // 也可能是 credit 余额形式
    const credits = num(result.body.credits ?? result.body.balance)
    if (credits !== undefined) return { ok: true, kind: 'balance', usd: credits }
    return { ok: false, error: '响应里没有用量窗口' }
  }
  return { ok: true, kind: 'quota', quotas }
}

/**
 * OpenAI 平台余额。
 *
 * 官方没有公开的「查询账户余额」接口，只有用量接口（需要 organization
 * admin key）。所以这里尝试 billing 端点，失败就明确说明需要什么权限。
 */
async function probeOpenai({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  // 用量接口：需要 sk-admin- 开头的组织密钥
  const result = await getJson(
    `${origin}/v1/organization/costs?start_time=${Math.floor(Date.now() / 1000) - 30 * 86400}`,
    apiKey, fetchImpl,
  )
  if (result.body !== undefined && Array.isArray(result.body.data)) {
    const usedUsd = result.body.data.reduce((total, bucket) => {
      const amount = num(bucket?.results?.[0]?.amount?.value) ?? 0
      return total + amount
    }, 0)
    return {
      ok: true, kind: 'quota',
      quotas: [quota('30-day', usedUsd, undefined, undefined, 'USD')].filter(Boolean),
    }
  }
  return {
    ok: false,
    error: result.status === 401 || result.status === 403
      ? '需要组织管理员密钥（sk-admin-）才能查询用量'
      : (result.error ?? `HTTP ${result.status}`),
  }
}

/**
 * Google Gemini 配额。
 *
 * 结构与 CC Switch 的 `GeminiQuotaResponse` 一致：
 *   { buckets: [{ remainingFraction, resetTime, modelId }] }
 * `remainingFraction` 是「剩余比例」，要转成已用。
 */
async function probeGemini({ baseUrl, apiKey, fetchImpl }) {
  const origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin
  const result = await getJson(
    `${origin}/v1beta/models?key=${encodeURIComponent(apiKey)}`, '', fetchImpl,
  )
  // Gemini 没有统一的配额查询接口；能查到模型列表说明 key 有效，
  // 但拿不到额度。这里如实说明，而不是编一个数字。
  if (result.body !== undefined) {
    return {
      ok: false,
      error: 'Gemini 未提供公开的配额查询接口，仅能确认密钥有效',
      keyValid: true,
    }
  }
  return { ok: false, error: result.error ?? `HTTP ${result.status}` }
}

/** 平台 id -> 探测函数。 */
const ADAPTERS = {
  deepseek: probeDeepseek,
  kimi: probeKimi,
  glm: probeGlm,
  minimax: probeMinimax,
  openrouter: probeOpenrouter,
  siliconflow: probeSiliconflow,
  novita: probeNovita,
  stepfun: probeStepfun,
  codex: probeCodex,
  openai: probeOpenai,
  gemini: probeGemini,
}

/**
 * 查询官方平台的余额或配额。
 *
 * 识别不出平台时返回 `{ ok:false, unsupported:true }`，调用方据此回退到
 * 中转站的通用探测（`probeBalance`）。
 */
export async function probeOfficial({ baseUrl, apiKey, fetchImpl, provider }) {
  const id = provider ?? detectProvider(baseUrl)
  if (id === undefined) return { ok: false, unsupported: true, error: '无法识别平台' }
  const adapter = ADAPTERS[id]
  if (adapter === undefined) {
    return {
      ok: false,
      unsupported: true,
      error: `${PROVIDER_LABELS[id] ?? id} 暂不支持余额查询`,
      provider: id,
    }
  }
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: '当前环境没有 fetch', provider: id }
  try {
    const result = await adapter({ baseUrl, apiKey, fetchImpl: doFetch })
    return { ...result, provider: id, label: PROVIDER_LABELS[id] ?? id }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), provider: id }
  }
}

/** 该平台是否支持查询（页面据此决定是否显示按钮）。 */
export function isSupportedProvider(baseUrl) {
  const id = detectProvider(baseUrl)
  return id !== undefined && ADAPTERS[id] !== undefined
}
