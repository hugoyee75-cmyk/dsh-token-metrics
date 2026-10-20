/**
 * 第三方中转站与订阅余额。
 *
 * 目标是回答两个问题：
 *   1. 我在这家中转站还剩多少钱？
 *   2. 我这个 Token 套餐用了多少、还剩多少？
 *
 * 实现上刻意保持「不依赖任何第三方库」：new-api 与 one-api 这两套
 * 自建网关占据了绝大多数中转站，它们的余额接口是约定俗成的，直接
 * 按路径探测即可覆盖大部分场景；探测不到的，退化为用户手工填写。
 *
 * 安全边界（重要）：
 *   - 只在用户显式配置了 baseURL 后才发起请求；
 *   - 密钥永远不写入统计数据文件，只存在凭据里；
 *   - 请求只发往用户填写的地址，不做任何重定向跟随到别的域。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** new-api / one-api 的余额端点候选。按命中概率排序。 */
export const BALANCE_ENDPOINTS = [
  // Sub2API 系（如 sub.100xlabs.space）：直接给 balance 与日用量明细。
  // 这是最省事的一种——字段本身就是美元，不需要单位换算。
  { path: '/v1/usage', kind: 'sub2api' },
  // new-api：返回 data.quota（额度，通常以 500000 为单位换算美元）
  { path: '/api/user/self', kind: 'new-api' },
  // one-api 风格
  { path: '/v1/dashboard/billing/subscription', kind: 'one-api' },
  { path: '/dashboard/billing/subscription', kind: 'one-api' },
]

/** new-api 的 quota 单位：500000 quota = 1 美元。 */
const NEW_API_QUOTA_PER_USD = 500000

/**
 * 归一化 baseURL：去掉末尾斜杠与多余的 `/v1`。
 *
 * 用户可能填 `https://x.com`、`https://x.com/`、`https://x.com/v1`，
 * 而余额接口在根路径下，所以统一收敛到 origin + 路径前缀。
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return ''
  let url = raw.trim()
  if (url === '') return ''
  // 去掉末尾斜杠
  url = url.replace(/\/+$/, '')
  // 去掉末尾的 /v1（余额接口不在 /v1 下）
  url = url.replace(/\/v1$/i, '')
  return url
}

/**
 * 从 new-api 的 `/api/user/self` 响应里取余额。
 *
 * 返回 `{ usd, raw }`；`raw` 保留原始 quota 便于排查单位问题。
 * 拿不到就返回 undefined，让调用方继续试下一个端点。
 */
export function parseNewApiBalance(body) {
  const data = body?.data ?? body
  if (data === null || typeof data !== 'object') return undefined
  const quota = Number(data.quota)
  if (!Number.isFinite(quota)) return undefined
  const usedRaw = Number(data.used_quota)
  return {
    usd: quota / NEW_API_QUOTA_PER_USD,
    usedUsd: Number.isFinite(usedRaw) ? usedRaw / NEW_API_QUOTA_PER_USD : undefined,
    username: typeof data.username === 'string' ? data.username : undefined,
    raw: { quota, used_quota: Number.isFinite(usedRaw) ? usedRaw : undefined },
  }
}

/**
 * 解析 Sub2API 系的 `/v1/usage` 响应。
 *
 * 典型响应（实测自 sub.100xlabs.space）：
 *
 *   {
 *     "balance": 60.0941164,
 *     "isValid": true,
 *     "mode": "unrestricted",
 *     "daily_usage": [{ "date": "...", "cost": 0.53, ... }],
 *     "model_stats": [{ "model": "claude-opus-5-5", "cost": 0.53, ... }]
 *   }
 *
 * `balance` 就是剩余美元，`daily_usage` 的 cost 之和是已用金额。
 * 有的变体把余额放在 `remaining` 或 `quota.remaining` 里，一并兼容。
 */
export function parseSub2ApiUsage(body) {
  if (body === null || typeof body !== 'object') return undefined
  const remaining = numberOrUndefined(body.balance)
    ?? numberOrUndefined(body.remaining)
    ?? numberOrUndefined(body?.quota?.remaining)
  if (remaining === undefined) return undefined
  // 已用金额：日明细累加（拿不到就留 undefined）
  let usedUsd
  if (Array.isArray(body.daily_usage)) {
    const sum = body.daily_usage.reduce((total, entry) => {
      const cost = numberOrUndefined(entry?.cost) ?? numberOrUndefined(entry?.actual_cost) ?? 0
      return total + cost
    }, 0)
    usedUsd = sum
  }
  return {
    usd: remaining,
    usedUsd,
    isValid: body.isValid !== false && body.is_active !== false,
    mode: typeof body.mode === 'string' ? body.mode : undefined,
  }
}

function numberOrUndefined(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 从 one-api 的 billing/subscription 响应里取额度上限。
 *
 * one-api 的语义与 new-api 不同：`hard_limit_usd` 是总额度，
 * 实际用量要另一个接口，所以这里只取额度，用量由调用方补充。
 */
export function parseOneApiSubscription(body) {
  const limit = Number(body?.hard_limit_usd ?? body?.system_hard_limit_usd)
  if (!Number.isFinite(limit)) return undefined
  return { limitUsd: limit }
}

/** 从 one-api 的 billing/usage 响应里取已用金额。 */
export function parseOneApiUsage(body) {
  const cents = Number(body?.total_usage)
  if (!Number.isFinite(cents)) return undefined
  // one-api 的 total_usage 单位是「美分」
  return { usedUsd: cents / 100 }
}

/**
 * 探测一个中转站的余额。
 *
 * 依次尝试各个端点，第一个能解析出数字的就采用。任何网络错误都只记录
 * 到 `error` 里而不是抛出——余额是辅助信息，不该让整个页面失败。
 *
 * @param {object} options
 * @param {string} options.baseUrl 用户填写的站点地址
 * @param {string} options.apiKey 访问令牌
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok:boolean, usd?:number, usedUsd?:number, limitUsd?:number,
 *   kind?:string, username?:string, error?:string}>}
 */
export async function probeBalance({ baseUrl, apiKey, fetchImpl, signal, timeoutMs = 10_000, balanceKind }) {
  const base = normalizeBaseUrl(baseUrl)
  if (base === '') return { ok: false, error: '没有填写站点地址' }
  if (typeof apiKey !== 'string' || apiKey === '') {
    return { ok: false, error: '没有可用的访问令牌' }
  }
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: '当前环境没有 fetch' }

  const headers = {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'user-agent': 'dsh-token-metrics',
  }

  // 用户明确指定了接口类型就只试那一种，省得在错误的端点上白等。
  const KIND_MAP = {
    sub2api: ['sub2api'],
    newapi: ['new-api'],
    oneapi: ['one-api'],
  }
  const endpoints = balanceKind !== undefined && KIND_MAP[balanceKind] !== undefined
    ? BALANCE_ENDPOINTS.filter((entry) => KIND_MAP[balanceKind].includes(entry.kind))
    : BALANCE_ENDPOINTS
  if (endpoints.length === 0) {
    return { ok: false, error: '指定的余额接口类型没有可用端点' }
  }

  let lastError = ''
  for (const endpoint of endpoints) {
    try {
      // 每个请求单独设超时：某个端点挂住不该拖死整个探测。
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
      let response
      try {
        response = await doFetch(`${base}${endpoint.path}`, {
          headers,
          signal: signal ?? controller?.signal,
          redirect: 'error',
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }
      const body = await response.json().catch(() => undefined)
      if (body === undefined) { lastError = '响应不是 JSON'; continue }

      if (endpoint.kind === 'sub2api') {
        const parsed = parseSub2ApiUsage(body)
        if (parsed !== undefined) {
          // 有些站点会返回 isValid:false（key 失效），那不算探测成功
          if (parsed.isValid === false) {
            lastError = '令牌已失效'
            continue
          }
          return {
            ok: true,
            kind: 'sub2api',
            usd: parsed.usd,
            usedUsd: parsed.usedUsd,
            // Sub2API 不返回总额度，用「剩余 + 已用」推算
            limitUsd: parsed.usedUsd === undefined ? undefined : parsed.usd + parsed.usedUsd,
            mode: parsed.mode,
          }
        }
        lastError = '响应里没有余额字段'
        continue
      }

      if (endpoint.kind === 'new-api') {
        const parsed = parseNewApiBalance(body)
        if (parsed !== undefined) {
          // new-api 有时同时给出 total_quota，能算出上限与剩余
          const totalQuota = Number(body?.data?.total_quota ?? body?.total_quota)
          return {
            ok: true,
            kind: 'new-api',
            usd: parsed.usd,
            usedUsd: parsed.usedUsd,
            limitUsd: Number.isFinite(totalQuota)
              ? totalQuota / NEW_API_QUOTA_PER_USD
              : parsed.usd + (parsed.usedUsd ?? 0),
            username: parsed.username,
            raw: parsed.raw,
          }
        }
        lastError = '响应里没有 quota 字段'
        continue
      }

      // one-api：先拿额度，再尽量补上用量
      const subscription = parseOneApiSubscription(body)
      if (subscription === undefined) { lastError = '响应里没有额度字段'; continue }
      let usedUsd
      try {
        const usageResponse = await doFetch(`${base}/dashboard/billing/usage`, {
          headers, signal, redirect: 'error',
        })
        if (usageResponse.ok) {
          const usageBody = await usageResponse.json().catch(() => undefined)
          usedUsd = parseOneApiUsage(usageBody)?.usedUsd
        }
      } catch { /* 拿不到用量就只报额度 */ }
      return {
        ok: true,
        kind: 'one-api',
        usd: usedUsd === undefined ? subscription.limitUsd : subscription.limitUsd - usedUsd,
        usedUsd,
        limitUsd: subscription.limitUsd,
      }
    } catch (error) {
      lastError = error?.message ?? String(error)
    }
  }
  return { ok: false, error: lastError === '' ? '所有端点都没有返回可用数据' : lastError }
}

/**
 * 从站点拉取可用模型列表。
 *
 * 走 OpenAI 兼容的 `GET {baseURL}/models`：这是所有中转站的通行做法，
 * 响应形如 `{ data: [{ id, created, owned_by }] }`，也有网关返回数组或
 * `{ models: [...] }`。这里对三种形态都做兼容。
 *
 * 拉取失败不抛异常——模型列表是给用户勾选的辅助信息，拿不到就让他手填。
 *
 * @returns {Promise<{ok:boolean, models?:Array<{id:string,name?:string}>, error?:string}>}
 */
export async function discoverModels({ baseUrl, apiKey, fetchImpl, signal, timeoutMs = 12_000 }) {
  const base = normalizeBaseUrl(baseUrl)
  if (base === '') return { ok: false, error: '没有填写站点地址' }
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: '当前环境没有 fetch' }

  const headers = { accept: 'application/json', 'user-agent': 'dsh-token-metrics' }
  if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`

  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 有些网关的模型列表带 /v1 前缀，有些不带；两种都试一次。
    const candidates = [`${base}/v1/models`, `${base}/models`]
    let lastError = ''
    for (const url of candidates) {
      try {
        const response = await doFetch(url, {
          headers, signal: signal ?? controller?.signal, redirect: 'error',
        })
        if (!response.ok) { lastError = `HTTP ${response.status}`; continue }
        const body = await response.json().catch(() => undefined)
        const models = normalizeModelList(body)
        if (models.length === 0) { lastError = '返回里没有模型'; continue }
        return { ok: true, models }
      } catch (error) {
        lastError = error?.message ?? String(error)
      }
    }
    return { ok: false, error: lastError === '' ? '没有可用的模型列表端点' : lastError }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 把各种形态的模型列表响应归一化成 `[{ id, name }]`。
 *
 * 兼容：
 *  - `{ data: [{ id }] }`（OpenAI 标准）
 *  - `[{ id }]`（部分网关直接给数组）
 *  - `{ models: [{ id }] }`
 *  - 富信息对象：`{ data: [{ id, name, context_length, max_output_tokens }] }`
 */
export function normalizeModelList(body) {
  const raw = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : []
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    // 条目可能是字符串，也可能是对象
    const id = typeof entry === 'string'
      ? entry
      : String(entry?.id ?? entry?.model ?? entry?.name ?? '')
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const model = { id }
    const name = typeof entry === 'object' && entry !== null
      ? (entry.display_name ?? entry.displayName ?? entry.name)
      : undefined
    if (typeof name === 'string' && name !== '' && name !== id) model.name = name
    // 顺带带上容量信息（有的网关会给）
    if (typeof entry === 'object' && entry !== null) {
      const context = Number(entry.context_length ?? entry.contextWindow ?? entry.max_input_tokens)
      if (Number.isFinite(context) && context > 0) model.contextWindow = context
      const maxOut = Number(entry.max_output_tokens ?? entry.maxTokens ?? entry.max_tokens)
      if (Number.isFinite(maxOut) && maxOut > 0) model.maxOutput = maxOut
    }
    out.push(model)
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

/**
 * 余额与用量的持久化。
 *
 * 只存「站点配置 + 最近一次探测结果」，**绝不存密钥**。密钥由 DSH 的
 * 凭据服务托管，这里只留一个引用名。
 */
export class BalanceBook {
  /**
   * @param {object} options
   * @param {string} options.dataDir
   * @param {() => number} [options.now]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.now = options.now ?? (() => Date.now())
    this.fetchImpl = options.fetchImpl
    this.log = options.log
    /**
     * 站点列表。每项：
     * `{ id, label, baseUrl, keyRef, kind, lastBalance, lastCheckedAt, error }`
     *
     * `keyRef` 是凭据服务里的引用名（不是密钥本身）。
     */
    this.sites = []
  }

  /** 从磁盘读取（由调用方传入路径，避免耦合目录约定）。 */
  loadFrom(path) {
    try {
      if (!existsSync(path)) return this
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      this.sites = Array.isArray(parsed.sites) ? parsed.sites.map(sanitizeSite) : []
    } catch (error) {
      this.log?.(`token-metrics: 读取余额配置失败（${error?.message ?? error}）`)
    }
    return this
  }

  /** 保存到磁盘。 */
  saveTo(path) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ sites: this.sites }, null, 2), 'utf8')
    } catch (error) {
      this.log?.(`token-metrics: 保存余额配置失败（${error?.message ?? error}）`)
    }
  }

  /** 新增或更新一个站点。 */
  upsertSite(input) {
    const id = String(input?.id ?? '').trim()
    if (id === '') return undefined
    const site = sanitizeSite({
      id,
      label: input.label ?? id,
      baseUrl: normalizeBaseUrl(input.baseUrl ?? ''),
      keyRef: input.keyRef ?? `dsh-token-metrics/${id}`,
      // keyEnv 与 models 必须带过来：前者是同步到 DSH 时的凭据引用名，
      // 后者是路由必须声明的模型清单。漏掉任何一个都会让同步失败。
      keyEnv: input.keyEnv ?? '',
      api: input.api ?? 'openai-completions',
      balanceKind: input.balanceKind ?? 'auto',
      provider: input.provider,
      models: input.models ?? [],
      kind: input.kind ?? 'auto',
      lastBalance: input.lastBalance,
      lastCheckedAt: input.lastCheckedAt,
      error: input.error,
    })
    const index = this.sites.findIndex((entry) => entry.id === id)
    if (index === -1) {
      this.sites.push(site)
      // 新增时 index 是 -1，必须返回刚 push 进去的那个
      return site
    }
    const previous = this.sites[index]
    // 没传 models 时沿用已有的，避免「只改余额」把模型列表清空。
    const models = (Array.isArray(input.models) && input.models.length > 0)
      ? site.models
      : (previous.models ?? [])
    this.sites[index] = { ...previous, ...site, models }
    return this.sites[index]
  }

  /** 删除一个站点。 */
  removeSite(id) {
    const before = this.sites.length
    this.sites = this.sites.filter((entry) => entry.id !== id)
    return this.sites.length !== before
  }

  /** 记下探测结果。 */
  recordResult(id, result) {
    const site = this.sites.find((entry) => entry.id === id)
    if (site === undefined) return
    site.lastCheckedAt = this.now()
    if (result?.ok === true) {
      site.lastBalance = {
        usd: result.usd,
        usedUsd: result.usedUsd,
        limitUsd: result.limitUsd,
        kind: result.kind,
        username: result.username,
        // 官方平台的额外信息：币种、平台名、配额窗口
        currency: result.currency,
        provider: result.provider,
        label: result.label,
        // 配额型（Kimi / GLM 的 Coding Plan）：
        // 每项 { label, used, limit, resetsAt, unit }
        quotas: Array.isArray(result.quotas) ? result.quotas : undefined,
        isAvailable: result.isAvailable,
      }
      site.error = ''
    } else {
      site.error = result?.error ?? '探测失败'
      // 「没有订阅」是有效状态，不算故障，单独标记供页面换一种说法
      site.lastBalance = site.lastBalance ?? null
      if (result?.noPlan === true) site.noPlan = true
      else delete site.noPlan
    }
  }

  /** 给页面的只读视图（不含任何密钥）。 */
  status() {
    return {
      sites: this.sites.map((site) => ({
        id: site.id,
        label: site.label,
        baseUrl: site.baseUrl,
        keyEnv: site.keyEnv ?? '',
        api: site.api ?? 'openai-completions',
        balanceKind: site.balanceKind ?? 'auto',
        provider: site.provider,
        models: site.models ?? [],
        kind: site.kind,
        lastBalance: site.lastBalance ?? null,
        noPlan: site.noPlan === true,
        lastCheckedAt: site.lastCheckedAt ?? 0,
        error: site.error ?? '',
      })),
    }
  }
}

/** 只保留白名单字段，防止把密钥之类的东西写进磁盘。 */
function sanitizeSite(input) {
  const site = {
    id: String(input?.id ?? ''),
    label: String(input?.label ?? input?.id ?? ''),
    baseUrl: typeof input?.baseUrl === 'string' ? input.baseUrl : '',
    keyRef: typeof input?.keyRef === 'string' ? input.keyRef : '',
    // 密钥环境变量名（引用，不是密钥本身）。同步到 DSH 时要写进 apiKeyEnv。
    keyEnv: typeof input?.keyEnv === 'string' ? input.keyEnv : '',
    // 上游协议：openai-completions / openai-responses / anthropic-messages。
    // 同步到 DSH 时会写进 provider 的 api 字段，选错请求格式就不对。
    api: typeof input?.api === 'string' && input.api !== '' ? input.api : 'openai-completions',
    // 余额接口类型：auto / sub2api / newapi / oneapi / none。
    // 明确指定能避免在错误端点上白等。
    balanceKind: typeof input?.balanceKind === 'string' && input.balanceKind !== ''
      ? input.balanceKind
      : 'auto',
    kind: typeof input?.kind === 'string' ? input.kind : 'auto',
    // 平台 id（deepseek / kimi / glm ...）。保存它是为了在「还没查询过」
    // 时也能判断该站点是余额型还是订阅型，而不是等探测完才知道。
    provider: typeof input?.provider === 'string' && input.provider !== ''
      ? input.provider
      : undefined,
    // 可用模型列表：同步到 DSH 模型配置时要用。
    // 早先漏了白名单，导致模型列表在保存时被剥掉、同步必然失败。
    models: Array.isArray(input?.models)
      ? input.models
        .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '')
        .map((model) => {
          const entry = { id: model.id }
          if (typeof model.name === 'string' && model.name !== '') entry.name = model.name
          const context = Number(model.contextWindow)
          if (Number.isFinite(context) && context > 0) entry.contextWindow = context
          const maxOut = Number(model.maxOutput)
          if (Number.isFinite(maxOut) && maxOut > 0) entry.maxOutput = maxOut
          // 思考档位：同步到 DSH 时转成 reasoningEfforts。
          // 白名单漏了它就会在保存时被剥掉，导致同步出去的配置没有档位。
          if (Array.isArray(model.thinkingLevels)) {
            // 档位条目有两种形式：字符串（同档位名）或 { level, wire }
            // （网关用别的拼写）。**两种都要保留**——早先只认字符串，
            // 导致自定义协议值在保存时被过滤掉。
            const levels = model.thinkingLevels
              .map((item) => {
                if (typeof item === 'string' && item !== '') return item
                if (item !== null && typeof item === 'object'
                  && typeof item.level === 'string' && item.level !== '') {
                  const wire = typeof item.wire === 'string' && item.wire !== '' ? item.wire : item.level
                  // 拼写与档位名相同时退化成字符串，保持数据简洁
                  return wire === item.level ? item.level : { level: item.level, wire }
                }
                return undefined
              })
              .filter((item) => item !== undefined)
            if (levels.length > 0) entry.thinkingLevels = levels
          }
          // 附件能力：false 表示只接受文本
          if (model.image === false) entry.image = false
          return entry
        })
      : [],
    lastBalance: input?.lastBalance ?? null,
    lastCheckedAt: Number(input?.lastCheckedAt ?? 0) || 0,
    error: typeof input?.error === 'string' ? input.error : '',
  }
  // 明确拒绝任何形似密钥的字段混进来。
  // keyEnv / keyRef 只是「名字」，不是密钥本体，必须放行——
  // 否则同步到 DSH 时拿不到 apiKeyEnv。
  const allowedNames = new Set(['keyRef', 'keyEnv'])
  for (const key of Object.keys(input ?? {})) {
    if (/key|token|secret|password/i.test(key) && !allowedNames.has(key)) {
      delete site[key]
    }
  }
  return site
}
