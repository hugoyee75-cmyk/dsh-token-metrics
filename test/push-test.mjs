/**
 * 推送与告警求值自检。
 *
 * SSE 长连接本身依赖真实 HTTP，这里只测纯逻辑部分：
 * 告警求值与「只推新增、恢复要通知」的去重规则。
 */

import { evaluateAlerts, diffAlerts, createPushHub } from '../src/push.js'

const failures = []

function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function checkTrue(label, condition, detail = '') {
  if (condition !== true) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

//#region 余额告警

{
  const alerts = evaluateAlerts({
    sites: [
      { id: 'a', label: '快没钱了', lastBalance: { usd: 2.5 } },
      { id: 'b', label: '充足', lastBalance: { usd: 100 } },
      { id: 'c', label: '已用尽', lastBalance: { usd: 0 } },
    ],
    thresholds: { balanceLowUsd: 5 },
  })
  check('余额告警数量', alerts.length, 2)
  check('余额不足为 warn', alerts.find((a) => a.siteId === 'a')?.level, 'warn')
  check('余额用尽为 error', alerts.find((a) => a.siteId === 'c')?.level, 'error')
  checkTrue('告警含站点名', alerts[0].body.includes('快没钱了'), alerts[0].body)
  // 充足的站点不应报警
  check('充足不报警', alerts.some((a) => a.siteId === 'b'), false)
}

//#endregion

//#region 配额告警

{
  const alerts = evaluateAlerts({
    sites: [{
      id: 'kimi', label: 'Kimi',
      lastBalance: {
        quotas: [
          { label: '5-hour', used: 95, limit: 100 },   // 剩 5% -> 报警
          { label: 'Weekly', used: 40, limit: 100 },   // 剩 60% -> 不报
          { label: 'Monthly', used: 100, limit: 100 }, // 剩 0% -> error
        ],
      },
    }],
    thresholds: { quotaLowPercent: 10 },
  })
  check('配额告警数量', alerts.length, 2)
  check('5-hour 为 warn', alerts.find((a) => a.window === '5-hour')?.level, 'warn')
  check('Monthly 为 error', alerts.find((a) => a.window === 'Monthly')?.level, 'error')
  check('Weekly 不报警', alerts.some((a) => a.window === 'Weekly'), false)
  checkTrue('配额告警含百分比', alerts[0].body.includes('%'), alerts[0].body)
}

//#endregion

//#region 阈值边界

{
  // 阈值设为 0 表示关闭余额告警
  const off = evaluateAlerts({
    sites: [{ id: 'a', label: 'A', lastBalance: { usd: 0.01 } }],
    thresholds: { balanceLowUsd: 0 },
  })
  check('阈值 0 关闭余额告警', off.length, 0)

  // 没有余额数据的站点不报警
  const noData = evaluateAlerts({
    sites: [{ id: 'x', label: 'X', lastBalance: null }, { id: 'y', label: 'Y' }],
  })
  check('无数据不报警', noData.length, 0)

  // 上限/用量非法的窗口跳过，不能因为脏数据抛错
  const dirty = evaluateAlerts({
    sites: [{ id: 'z', label: 'Z', lastBalance: { quotas: [{ label: 'W', used: 'x', limit: 0 }] } }],
  })
  check('脏数据被跳过', dirty.length, 0)
}

//#endregion

//#region 去重与恢复

{
  const alerts = [
    { id: 'balance-low:a', kind: 'balance-low', siteId: 'a', level: 'warn', title: 't', body: 'b' },
    { id: 'quota-low:k:5-hour', kind: 'quota-low', siteId: 'k', window: '5-hour', level: 'warn', title: 't', body: 'b' },
  ]
  // 第一次：全部是新增
  const first = diffAlerts(alerts, { sent: {} })
  check('首次全部新增', first.fresh.length, 2)
  check('首次无恢复', first.recovered.length, 0)

  // 第二次：已经推过，不应重复
  const state = { sent: { 'balance-low:a': 1, 'quota-low:k:5-hour': 1 } }
  const second = diffAlerts(alerts, state)
  check('已推过不重复', second.fresh.length, 0)

  // 告警消失 -> 产生恢复通知
  const recovered = diffAlerts([], state)
  check('恢复通知数量', recovered.recovered.length, 2)
  check('余额恢复文案', recovered.recovered.find((r) => r.siteId === 'a')?.title, '余额已恢复')
  check('配额恢复文案', recovered.recovered.find((r) => r.window === '5-hour')?.title, '配额已恢复')
  check('恢复级别为 ok', recovered.recovered[0].level, 'ok')

  // 新增与恢复同时发生
  const mixed = diffAlerts([alerts[0]], { sent: { 'quota-low:k:5-hour': 1 } })
  check('同时有新增', mixed.fresh.length, 1)
  check('同时有恢复', mixed.recovered.length, 1)
}

//#endregion

//#region PushHub 基本行为

{
  const hub = createPushHub({ logger: { warn() {} }, heartbeatMs: 60_000 })
  check('初始无连接', hub.size, 0)
  // 没有连接时广播不应抛错
  check('空广播返回 0', hub.broadcast('alert', { alerts: [] }), 0)

  // 用一个假的响应对象模拟连接
  const written = []
  const fakeRes = {
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    write(chunk) { written.push(chunk); return true },
    on() {},
    end() { this.writableEnded = true },
  }
  const fakeReq = { on() {} }
  hub.attach(fakeReq, fakeRes, { alerts: [] })
  check('连接已登记', hub.size, 1)
  checkTrue('写入了 connected 注释', written.some((c) => c.includes(': connected')), String(written))
  checkTrue('写入了 hello 事件', written.some((c) => c.includes('event: hello')), String(written))

  hub.broadcast('alert', { alerts: [{ title: 'x' }] })
  checkTrue('广播写入 alert 事件', written.some((c) => c.includes('event: alert')), String(written))

  hub.close()
  check('关闭后清空', hub.size, 0)
}

//#endregion

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 推送与告警全部断言通过')
console.log('  余额阈值 / 配额阈值 / 去重 / 恢复通知 / SSE hub')
