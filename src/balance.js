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
export async function probeBalance({ baseUrl, apiKey, fetchImpl, signal, timeoutMs = 10_000 }) {
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

  let lastError = ''
  for (const endpoint of BALANCE_ENDPOINTS) {
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
      kind: input.kind ?? 'auto',
      lastBalance: input.lastBalance,
      lastCheckedAt: input.lastCheckedAt,
      error: input.error,
    })
    const index = this.sites.findIndex((entry) => entry.id === id)
    if (index === -1) this.sites.push(site)
    else this.sites[index] = { ...this.sites[index], ...site }
    return site
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
      }
      site.error = ''
    } else {
      site.error = result?.error ?? '探测失败'
    }
  }

  /** 给页面的只读视图（不含任何密钥）。 */
  status() {
    return {
      sites: this.sites.map((site) => ({
        id: site.id,
        label: site.label,
        baseUrl: site.baseUrl,
        kind: site.kind,
        lastBalance: site.lastBalance ?? null,
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
    kind: typeof input?.kind === 'string' ? input.kind : 'auto',
    lastBalance: input?.lastBalance ?? null,
    lastCheckedAt: Number(input?.lastCheckedAt ?? 0) || 0,
    error: typeof input?.error === 'string' ? input.error : '',
  }
  // 明确拒绝任何形似密钥的字段混进来
  for (const key of Object.keys(input ?? {})) {
    if (/key|token|secret|password/i.test(key) && key !== 'keyRef') {
      delete site[key]
    }
  }
  return site
}
