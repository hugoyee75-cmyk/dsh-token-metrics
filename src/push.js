/**
 * 服务端推送通道（SSE）。
 *
 * DSH 内核没有通知服务，但 `webServer` 允许 handler 把响应一直挂着——
 * 这正是 SSE 需要的。同 profile 里的 our-free-model 插件也是这么做的，
 * 这里沿用同一套模式：
 *
 *   - 一个 `text/event-stream` 路由，所有打开的页面都订阅它；
 *   - 定期写注释行做心跳，避免被空闲超时掐断；
 *   - 客户端断开时从集合里移除；
 *   - 事件是**即发即弃**的快照，不是队列：后连上来的客户端从 `hello`
 *     里拿到当前状态，而不是补发历史。这样 hub 不需要存任何东西。
 *
 * @module src/push.js
 */

const HEARTBEAT_MS = 25_000

/**
 * @param {object} options
 * @param {object} [options.logger]
 * @param {number} [options.heartbeatMs]
 */
export function createPushHub({ logger = console, heartbeatMs = HEARTBEAT_MS } = {}) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set()
  let heartbeat

  function startHeartbeat() {
    if (heartbeat !== undefined || clients.size === 0) return
    heartbeat = setInterval(() => {
      for (const res of clients) {
        if (res.writableEnded === true || res.destroyed === true) {
          clients.delete(res)
          continue
        }
        // 注释行是 SSE 里合法的心跳，客户端不会当成事件
        res.write(': ping\n\n')
      }
      if (clients.size === 0) stopHeartbeat()
    }, heartbeatMs)
    heartbeat.unref?.()
  }

  function stopHeartbeat() {
    if (heartbeat === undefined) return
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  /** 往单个连接写一个事件。 */
  function sendTo(res, event, payload) {
    if (res.writableEnded === true || res.destroyed === true) return false
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch (error) {
      logger?.warn?.(`token-metrics: SSE 写入失败（${error?.message ?? error}）`)
      return false
    }
  }

  return {
    /** 当前有多少个页面订阅着。 */
    get size() {
      return clients.size
    },

    /**
     * 接管一个请求，把它变成事件流。
     *
     * 调用前路由已经过了信任检查，这里直接持有响应。
     */
    attach(req, res, hello) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 反向代理（含 DSH 自带的 gzip 层）不能缓冲事件流
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      if (hello !== undefined) sendTo(res, 'hello', hello)
      clients.add(res)
      startHeartbeat()

      const drop = () => {
        clients.delete(res)
        if (clients.size === 0) stopHeartbeat()
      }
      req.on?.('close', drop)
      req.on?.('error', drop)
      res.on?.('close', drop)
      res.on?.('error', drop)
    },

    /** 广播一个事件给所有已连接的页面。 */
    broadcast(event, payload) {
      let sent = 0
      for (const res of clients) {
        if (res.writableEnded === true || res.destroyed === true) {
          clients.delete(res)
          continue
        }
        if (sendTo(res, event, payload)) sent += 1
      }
      if (clients.size === 0) stopHeartbeat()
      return sent
    },

    /** 关闭所有连接（插件卸载时用）。 */
    close() {
      for (const res of clients) {
        try { res.end() } catch { /* 已断开 */ }
      }
      clients.clear()
      stopHeartbeat()
    },
  }
}

/**
 * 告警规则求值。
 *
 * 输入是当前余额/配额快照，输出「该不该提醒」。规则本身很朴素：
 * 只看阈值，不猜趋势——「还剩 3%」比「预计 2 小时后耗尽」可靠得多，
 * 后者依赖历史速率，容易被一次大请求打偏。
 *
 * @param {object} options
 * @param {object[]} options.sites 站点列表（含 lastBalance）
 * @param {object} [options.thresholds]
 * @returns {object[]} 需要推送的告警
 */
/**
 * 预算告警求值。
 *
 * 与余额告警的区别：余额看「账户里还剩多少」，预算看「这段时间花得快不快」。
 * 例如账户余额 $60 很充足，但今天已花 $8.5 / 日预算 $10 —— 只有预算能提醒到。
 *
 * @param {object} options
 * @param {{todayUsd:number, monthUsd:number}} options.spend 当前花销
 * @param {{dailyUsd?:number, monthlyUsd?:number, warnPercent?:number}} options.budget
 * @param {string} [options.today] 今日日期，用于告警 id 稳定性
 * @param {string} [options.month] 当月，形如 2026-10
 */
export function evaluateBudgetAlerts({ spend, budget, today = '', month = '' } = {}) {
  const alerts = []
  const warnPercent = Number.isFinite(budget?.warnPercent) ? budget.warnPercent : 80

  /**
   * 通用：检查一个预算窗口。
   *
   * 级别规则：
   *   - 已超 100%   -> error
   *   - 超过 warn% -> warn
   */
  const check = (label, used, limit, scope) => {
    if (!Number.isFinite(limit) || limit <= 0) return
    if (!Number.isFinite(used) || used <= 0) return
    const ratio = used / limit
    if (ratio < warnPercent / 100) return
    const percent = Math.round(ratio * 100)
    const remaining = Math.max(0, limit - used)
    const over = ratio >= 1
    alerts.push({
      // id 带日期：今天的告警不会影响明天重新提醒
      id: `budget-${scope}:${scope === 'daily' ? today : month}`,
      level: over ? 'error' : 'warn',
      kind: `budget-${scope}`,
      siteId: '',
      title: over ? `${label}预算已超` : `${label}预算将尽`,
      body: over
        ? `${label}已花 $${used.toFixed(2)}，超出预算 $${limit.toFixed(2)}（${percent}%）`
        : `${label}已花 $${used.toFixed(2)} / $${limit.toFixed(2)}（${percent}%），还剩 $${remaining.toFixed(2)}`,
    })
  }

  check('今日', spend?.todayUsd, budget?.dailyUsd, 'daily')
  check('本月', spend?.monthUsd, budget?.monthlyUsd, 'monthly')

  // 分组预算：每组是「这些模型的合计额度」。
  // `spend.groups` 是计算好的 { groupId: { todayUsd, monthUsd } }。
  for (const group of Array.isArray(budget?.groups) ? budget.groups : []) {
    const used = spend?.groups?.[group.id]
    if (used === undefined) continue
    const groupCheck = (label, value, limit, scope) => {
      if (!Number.isFinite(limit) || limit <= 0) return
      if (!Number.isFinite(value) || value <= 0) return
      const ratio = value / limit
      if (ratio < warnPercent / 100) return
      const percent = Math.round(ratio * 100)
      const over = ratio >= 1
      const remaining = Math.max(0, limit - value)
      alerts.push({
        id: `budget-group:${group.id}:${scope === 'daily' ? today : month}`,
        level: over ? 'error' : 'warn',
        kind: `budget-${scope}`,
        siteId: '',
        title: over ? `${group.label} 预算已超` : `${group.label} 预算将尽`,
        body: over
          ? `${label}已花 $${value.toFixed(2)}，超出 $${limit.toFixed(2)}（${percent}%）`
          : `${label}已花 $${value.toFixed(2)} / $${limit.toFixed(2)}（${percent}%），还剩 $${remaining.toFixed(2)}`,
      })
    }
    groupCheck('今日', used.todayUsd, group.dailyUsd, 'daily')
    groupCheck('本月', used.monthUsd, group.monthlyUsd, 'monthly')
  }
  return alerts
}

/**
 * DeepSeek 峰谷时段切换提醒。
 *
 * 为什么值得提醒：谷时价是峰时的一半。如果 10 分钟后就要转峰时，
 * 现在跑完一个大任务能省一半钱 —— 这个提醒是**直接给用户省钱**的，
 * 不是单纯的状态播报。
 *
 * 时段规则（UTC，与 DeepSeek 官方一致）：
 *   峰时 = 周一至周五 01:00-04:00 与 06:00-10:00
 *   其余时间（含周末）= 谷时
 *
 * @param {object} options
 * @param {Date} [options.at] 当前时刻，默认 now
 * @param {number} [options.leadMinutes] 提前量（分钟），默认 10
 * @returns {object[]} 告警列表
 */
export function evaluatePeakAlerts({ at = new Date(), leadMinutes = 10 } = {}) {
  // 0 表示关闭提醒，必须显式返回空——不能当成「没传值」而回退到默认 10，
  // 否则用户关不掉这个提醒。
  const lead = Number.isFinite(leadMinutes) ? Math.max(0, leadMinutes) : 10
  if (lead === 0) return []

  /** 判断某个 UTC 时刻是否处于峰时。 */
  const isPeak = (date) => {
    const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
    if (weekday > 5) return false // 周末全天谷时
    const hour = date.getUTCHours()
    return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
  }

  const now = new Date(at)
  const soon = new Date(now.getTime() + lead * 60_000)
  const nowPeak = isPeak(now)
  const soonPeak = isPeak(soon)

  // 只在「现在谷时、10 分钟后峰时」时提醒 —— 反过来（峰转谷）是好消息，
  // 用户不着急，多一条通知反而是噪音。
  if (nowPeak || !soonPeak) return []

  // 算出具体还有几分钟转峰时
  let minutes = 0
  for (let i = 1; i <= lead; i += 1) {
    if (isPeak(new Date(now.getTime() + i * 60_000))) {
      minutes = i
      break
    }
  }

  return [{
    id: `peak-soon:${now.toISOString().slice(0, 13)}`,
    level: 'warn',
    kind: 'peak-soon',
    siteId: '',
    title: '即将进入峰时价',
    body: `${minutes > 0 ? `约 ${minutes} 分钟后` : '马上'}转峰时，价格翻倍。`
      + '手上的活建议现在跑完，或等谷时再继续。',
  }]
}

export function evaluateAlerts({ sites, thresholds = {} }) {
  const balanceLowUsd = Number.isFinite(thresholds.balanceLowUsd) ? thresholds.balanceLowUsd : 5
  const quotaLowPercent = Number.isFinite(thresholds.quotaLowPercent) ? thresholds.quotaLowPercent : 10
  // 「即将重置」的提前量：默认 10 分钟
  const quotaResetSoonMs = Number.isFinite(thresholds.quotaResetSoonMinutes)
    ? thresholds.quotaResetSoonMinutes * 60_000
    : 10 * 60_000
  const alerts = []

  for (const site of sites ?? []) {
    const balance = site.lastBalance
    const label = site.label || site.id

    // 查询失败的告警必须在「没有余额数据」时也能触发——恰恰是查不到
    // 才最需要提醒。所以这里不能因为 lastBalance 为空就 continue。
    if (typeof site.error === 'string' && site.error !== '' && site.noPlan !== true) {
      alerts.push({
        id: `probe-failed:${site.id}`,
        level: 'error',
        kind: 'probe-failed',
        siteId: site.id,
        title: '余额查询失败',
        body: `${label}：${site.error}`,
      })
    }

    if (balance === null || balance === undefined) continue

    // ① 余额不足
    if (typeof balance.usd === 'number' && balance.usd < balanceLowUsd) {
      alerts.push({
        id: `balance-low:${site.id}`,
        level: balance.usd <= 0 ? 'error' : 'warn',
        kind: 'balance-low',
        siteId: site.id,
        title: balance.usd <= 0 ? '余额已用尽' : '余额不足',
        body: `${label} 剩余 $${balance.usd.toFixed(2)}（阈值 $${balanceLowUsd}）`,
      })
    }

    // ② 配额窗口剩余不足 / 即将重置
    for (const window of Array.isArray(balance.quotas) ? balance.quotas : []) {
      const used = Number(window.used)
      const limit = Number(window.limit)
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) continue
      const leftPercent = Math.round((1 - used / limit) * 100)
      if (leftPercent > quotaLowPercent) continue
      alerts.push({
        id: `quota-low:${site.id}:${window.label}`,
        level: leftPercent <= 0 ? 'error' : 'warn',
        kind: 'quota-low',
        siteId: site.id,
        window: window.label,
        title: leftPercent <= 0 ? `${window.label} 额度已用尽` : `${window.label} 额度将尽`,
        body: `${label} ${window.label} 剩余 ${Math.max(0, leftPercent)}%`,
      })
    }

    // ④ 配额即将重置：还剩几分钟就恢复，提醒用户「稍等一下就能用」
    // 这条和「将尽」互补——将尽说「快没了」，这条说「马上就好了」。
    for (const window of Array.isArray(balance.quotas) ? balance.quotas : []) {
      const resetsAt = Number(window.resetsAt)
      if (!Number.isFinite(resetsAt) || resetsAt <= 0) continue
      const remainMs = resetsAt - (thresholds.now ?? Date.now())
      // 只在「已用尽或快用尽」且「即将重置」时才提醒，否则太吵
      const used = Number(window.used)
      const limit = Number(window.limit)
      const leftPercent = Number.isFinite(used) && Number.isFinite(limit) && limit > 0
        ? Math.round((1 - used / limit) * 100) : 100
      if (leftPercent > quotaLowPercent) continue
      if (remainMs <= 0 || remainMs > quotaResetSoonMs) continue
      const minutes = Math.max(1, Math.round(remainMs / 60_000))
      alerts.push({
        id: `quota-reset-soon:${site.id}:${window.label}`,
        level: 'ok',
        kind: 'quota-reset-soon',
        siteId: site.id,
        window: window.label,
        title: `${window.label} 即将重置`,
        body: `${label} 的 ${window.label} 将在约 ${minutes} 分钟后恢复`,
      })
    }
  }
  return alerts
}

/**
 * 判断哪些告警是**新出现**的（之前没推送过）。
 *
 * 只推新告警，避免每次轮询都重复弹同一条。
 * `state` 由调用方持久化，形如 `{ sent: { [alertId]: 时间戳 } }`。
 *
 * 另外处理「恢复」：某条告警消失时，如果之前推送过，要发一条恢复通知
 * （例如配额重置后用户会想知道「现在可以用了」）。
 */
/**
 * 各类型的冷却时长（毫秒）。
 *
 * 为什么不是统一冷却：不同告警的「多久提一次才有意义」差别很大。
 *   - 余额不足：钱真的少了才需要再提醒，但要防止用户反复点查询时刷屏
 *   - 查询失败：站点挂了会一直失败，必须给较长冷却，否则每次轮询都弹
 *   - 配额将尽：窗口内不会恢复，冷却可以长一些
 *   - 即将重置：这是「好消息」，只在临近时提一次，不需要冷却
 *   - 插件新版本：一天一次足够
 *
 * 另外所有类型都有一个**硬下限**（`minCooldownMs`），防止意外刷屏。
 */
const COOLDOWN_MS = {
  'balance-low': 30 * 60_000,      // 30 分钟
  'quota-low': 30 * 60_000,        // 30 分钟
  'probe-failed': 2 * 60 * 60_000, // 2 小时（站点挂了会一直失败）
  'quota-reset-soon': 0,           // 不冷却：只在临近重置时出现，天然只提一次
  'plugin-update': 24 * 60 * 60_000, // 一天
  // 预算告警：花销增长是渐进的，1 小时提醒一次足够，避免每轮询都弹
  'peak-soon': 60 * 60_000,
  'budget-daily': 60 * 60_000,
  'budget-monthly': 60 * 60_000,
}

/** 所有告警的硬下限：即使规则说 0 冷却，也不允许短时间内重复。 */
const MIN_COOLDOWN_MS = 60_000

/**
 * 算出某条告警的冷却剩余时间（毫秒）。
 *
 * @returns {number} 0 表示可以推送
 */
export function cooldownRemaining(alert, sent, now = Date.now()) {
  const last = sent?.[alert.id]
  if (last === undefined) return 0
  const configured = COOLDOWN_MS[alert.kind] ?? 30 * 60_000
  const cooldown = Math.max(configured, MIN_COOLDOWN_MS)
  const elapsed = now - Number(last)
  return Math.max(0, cooldown - elapsed)
}

export function diffAlerts(current, state, options = {}) {
  const sent = state?.sent ?? {}
  const now = options.now ?? Date.now()
  const currentIds = new Set(current.map((alert) => alert.id))
  // 冷却期内不重复推送；恢复通知不受冷却影响（它本来就只出现一次）
  const fresh = current.filter((alert) => {
    if (sent[alert.id] === undefined) return true
    return cooldownRemaining(alert, sent, now) === 0
  })
  /** 每种告警消失时的恢复文案。 */
  const RECOVERY = {
    'balance-low': { title: '余额已恢复', body: (p) => `${p[1]} 的余额已回到阈值以上` },
    'quota-low': { title: '配额已恢复', body: (p) => `${p[1]} 的 ${p[2] ?? ''} 窗口已重置` },
    'probe-failed': { title: '查询已恢复', body: (p) => `${p[1]} 现在可以正常查询了` },
    // 预算告警消失通常是跨天/跨月重置，不需要提示「已恢复」——用户自己知道
    'peak-soon': undefined,
    'budget-daily': undefined,
    'budget-monthly': undefined,
    // 「即将重置」不是故障，它消失是正常的（已重置或已过窗口），不提示恢复
    'quota-reset-soon': undefined,
    // 版本更新后由插件自己重载，不需要额外通知
    'plugin-update': undefined,
  }

  const recovered = Object.keys(sent)
    .filter((id) => !currentIds.has(id))
    .map((id) => {
      // id 形如 `quota-low:<siteId>:<window>` / `probe-failed:<siteId>`
      const parts = id.split(':')
      const kind = parts[0]
      const recipe = RECOVERY[kind]
      if (recipe === undefined) return undefined
      return {
        id,
        kind: `${kind}-recovered`,
        siteId: parts[1],
        window: parts[2],
        level: 'ok',
        title: recipe.title,
        body: recipe.body(parts),
      }
    })
    .filter((entry) => entry !== undefined)
  return { fresh, recovered }
}
