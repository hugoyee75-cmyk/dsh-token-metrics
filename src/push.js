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
export function diffAlerts(current, state) {
  const sent = state?.sent ?? {}
  const currentIds = new Set(current.map((alert) => alert.id))
  const fresh = current.filter((alert) => sent[alert.id] === undefined)
  /** 每种告警消失时的恢复文案。 */
  const RECOVERY = {
    'balance-low': { title: '余额已恢复', body: (p) => `${p[1]} 的余额已回到阈值以上` },
    'quota-low': { title: '配额已恢复', body: (p) => `${p[1]} 的 ${p[2] ?? ''} 窗口已重置` },
    'probe-failed': { title: '查询已恢复', body: (p) => `${p[1]} 现在可以正常查询了` },
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
