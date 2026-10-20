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
  const alerts = []

  for (const site of sites ?? []) {
    const balance = site.lastBalance
    if (balance === null || balance === undefined) continue
    const label = site.label || site.id

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

    // ② 配额窗口剩余不足
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
  const recovered = Object.keys(sent)
    .filter((id) => !currentIds.has(id))
    .map((id) => {
      // id 形如 `quota-low:<siteId>:<window>` 或 `balance-low:<siteId>`
      const parts = id.split(':')
      const kind = parts[0]
      return {
        id,
        kind: `${kind}-recovered`,
        siteId: parts[1],
        window: parts[2],
        level: 'ok',
        title: kind === 'quota-low' ? '配额已恢复' : '余额已恢复',
        body: kind === 'quota-low' && parts[2] !== undefined
          ? `${parts[1]} 的 ${parts[2]} 窗口已重置`
          : `${parts[1]} 的状态已恢复`,
      }
    })
  return { fresh, recovered }
}
