/**
 * 推送与告警求值自检。
 *
 * SSE 长连接本身依赖真实 HTTP，这里只测纯逻辑部分：
 * 告警求值与「只推新增、恢复要通知」的去重规则。
 */

import { evaluateAlerts, evaluateBudgetAlerts, evaluatePeakAlerts, diffAlerts, createPushHub } from '../src/push.js'

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

// —— 预算告警 ——
// 与余额的区别：余额看账户剩多少，预算看这段时间花得快不快。
{
  // 未超阈值：不出告警
  const quiet = evaluateBudgetAlerts({
    spend: { todayUsd: 3, monthUsd: 30 },
    budget: { dailyUsd: 10, monthlyUsd: 200 },
    today: '2026-10-20', month: '2026-10',
  })
  check('未达阈值不出告警', quiet.length, 0)

  // 超过 warnPercent（默认 80%）：warning
  const warn = evaluateBudgetAlerts({
    spend: { todayUsd: 8.5, monthUsd: 30 },
    budget: { dailyUsd: 10, monthlyUsd: 200 },
    today: '2026-10-20', month: '2026-10',
  })
  check('超阈值出 1 条', warn.length, 1)
  check('级别为 warn', warn[0].level, 'warn')
  check('kind 为 budget-daily', warn[0].kind, 'budget-daily')
  checkTrue('文案含剩余金额', warn[0].body.includes('1.50'))

  // 超 100%：error
  const over = evaluateBudgetAlerts({
    spend: { todayUsd: 12, monthUsd: 30 },
    budget: { dailyUsd: 10, monthlyUsd: 200 },
    today: '2026-10-20', month: '2026-10',
  })
  check('超预算级别为 error', over[0].level, 'error')
  checkTrue('文案含超出金额', over[0].body.includes('超出'))

  // 日/月同时超：两条
  const both = evaluateBudgetAlerts({
    spend: { todayUsd: 12, monthUsd: 250 },
    budget: { dailyUsd: 10, monthlyUsd: 200 },
    today: '2026-10-20', month: '2026-10',
  })
  check('日与月各一条', both.length, 2)

  // 预算为 0 表示不启用
  const disabled = evaluateBudgetAlerts({
    spend: { todayUsd: 100, monthUsd: 1000 },
    budget: { dailyUsd: 0, monthlyUsd: 0 },
    today: '2026-10-20', month: '2026-10',
  })
  check('预算为 0 不告警', disabled.length, 0)

  // 自定义阈值
  const custom = evaluateBudgetAlerts({
    spend: { todayUsd: 5.5, monthUsd: 0 },
    budget: { dailyUsd: 10, warnPercent: 50 },
    today: '2026-10-20', month: '2026-10',
  })
  check('自定义阈值生效', custom.length, 1)

  // 分组预算：单模型
  const single = evaluateBudgetAlerts({
    spend: { todayUsd: 0, monthUsd: 0, groups: { g1: { todayUsd: 9, monthUsd: 0 } } },
    budget: { groups: [{ id: 'g1', label: '日常编码', models: ['deepseek-flash'], dailyUsd: 10 }] },
    today: '2026-10-20', month: '2026-10',
  })
  check('分组预算告警', single.length, 1)
  checkTrue('分组文案含组名', single[0].title.includes('日常编码'))

  // 分组预算：多模型合计
  const multi = evaluateBudgetAlerts({
    spend: { todayUsd: 0, monthUsd: 0, groups: { g2: { todayUsd: 0, monthUsd: 130 } } },
    budget: { groups: [{ id: 'g2', label: '重活', models: ['claude-opus-5', 'gpt-5.5'], monthlyUsd: 120 }] },
    today: '2026-10-20', month: '2026-10',
  })
  check('多模型分组合计超预算', multi[0].level, 'error')

  // 分组没花销时不告警
  const idle = evaluateBudgetAlerts({
    spend: { groups: { g3: { todayUsd: 0, monthUsd: 0 } } },
    budget: { groups: [{ id: 'g3', label: '闲置', models: ['x'], dailyUsd: 5 }] },
    today: '2026-10-20', month: '2026-10',
  })
  check('分组无花销不告警', idle.length, 0)
}

// —— 峰谷切换提醒 ——
// 谷时价是峰时的一半，转峰前提醒能直接帮用户省钱。
{
  // 周一 00:55 UTC：5 分钟后（01:00）转峰时 -> 应提醒
  const soon = evaluatePeakAlerts({ at: new Date('2026-10-19T00:55:00Z'), leadMinutes: 10 })
  check('谷时即将转峰时出提醒', soon.length, 1)
  check('级别为 warn', soon[0].level, 'warn')
  check('kind 为 peak-soon', soon[0].kind, 'peak-soon')

  // 周一 00:20 UTC：距转峰还有 40 分钟 -> 不提醒
  const early = evaluatePeakAlerts({ at: new Date('2026-10-19T00:20:00Z'), leadMinutes: 10 })
  check('还早不提醒', early.length, 0)

  // 周一 02:00 UTC：已经是峰时 -> 不提醒
  const peak = evaluatePeakAlerts({ at: new Date('2026-10-19T02:00:00Z'), leadMinutes: 10 })
  check('已在峰时不提醒', peak.length, 0)

  // 周一 03:55 UTC：5 分钟后转谷时 -> 好消息，不提醒
  const toOff = evaluatePeakAlerts({ at: new Date('2026-10-19T03:55:00Z'), leadMinutes: 10 })
  check('转谷时不提醒', toOff.length, 0)

  // 周六：全天谷时 -> 不提醒
  const weekend = evaluatePeakAlerts({ at: new Date('2026-10-24T00:55:00Z'), leadMinutes: 10 })
  check('周末不提醒', weekend.length, 0)

  // 关闭（leadMinutes=0）
  const off = evaluatePeakAlerts({ at: new Date('2026-10-19T00:55:00Z'), leadMinutes: 0 })
  check('提前量为 0 不提醒', off.length, 0)
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

//#region 查询失败告警

{
  const alerts = evaluateAlerts({
    sites: [
      { id: 'a', label: 'key过期', lastBalance: null, error: 'HTTP 401' },
      { id: 'b', label: '无订阅', lastBalance: null, error: '当前用户不存在coding plan', noPlan: true },
      { id: 'c', label: '正常', lastBalance: { usd: 100 }, error: '' },
    ],
  })
  const failed = alerts.filter((a) => a.kind === 'probe-failed')
  check('查询失败被识别', failed.length, 1)
  check('失败级别为 error', failed[0].level, 'error')
  checkTrue('失败带原因', failed[0].body.includes('HTTP 401'), failed[0].body)
  // 「无订阅」是正常状态，不该报成故障
  check('无订阅不报错', alerts.some((a) => a.siteId === 'b' && a.kind === 'probe-failed'), false)
}

//#endregion

//#region 配额即将重置

{
  const now = 1_800_000_000_000
  const alerts = evaluateAlerts({
    sites: [{
      id: 'k', label: 'Kimi',
      lastBalance: {
        quotas: [
          // 已用尽 + 8 分钟后重置 -> 应提醒「即将重置」
          { label: '5-hour', used: 100, limit: 100, resetsAt: now + 8 * 60_000 },
          // 已用尽但 2 小时后才重置 -> 太远，不提醒
          { label: 'Weekly', used: 100, limit: 100, resetsAt: now + 120 * 60_000 },
          // 还剩很多，即使快重置也不用提醒
          { label: 'Monthly', used: 10, limit: 100, resetsAt: now + 5 * 60_000 },
        ],
      },
    }],
    thresholds: { quotaResetSoonMinutes: 10, now },
  })
  const soon = alerts.filter((a) => a.kind === 'quota-reset-soon')
  check('即将重置告警数', soon.length, 1)
  check('命中 5-hour 窗口', soon[0].window, '5-hour')
  check('即将重置为 ok 级', soon[0].level, 'ok')
  checkTrue('文案含分钟数', soon[0].body.includes('分钟'), soon[0].body)
  // 已用尽的窗口同时也会触发 quota-low
  checkTrue('同时有将尽告警', alerts.some((a) => a.kind === 'quota-low' && a.window === '5-hour'))
}

//#endregion

//#region 恢复文案

{
  // 不同告警消失时给不同措辞，且「即将重置」消失不提示
  const sent = {
    'probe-failed:a': 1,
    'quota-reset-soon:k:5-hour': 1,
    'plugin-update:1.2.3': 1,
  }
  const d = diffAlerts([], { sent }, { now: Date.now() })
  check('只有查询失败给恢复', d.recovered.length, 1)
  check('恢复标题', d.recovered[0].title, '查询已恢复')
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

  // 第二次：刚推过（冷却期内），不应重复
  const now = 1_800_000_000_000
  const state = { sent: { 'balance-low:a': now - 1000, 'quota-low:k:5-hour': now - 1000 } }
  const second = diffAlerts(alerts, state, { now })
  check('冷却期内不重复', second.fresh.length, 0)

  // 冷却期过后可以再推（提醒仍然有效）
  const later = diffAlerts(alerts, state, { now: now + 31 * 60_000 })
  check('冷却结束后可再推', later.fresh.length, 2)

  // 告警消失 -> 产生恢复通知
  const recovered = diffAlerts([], state, { now: now + 1000 })
  check('恢复通知数量', recovered.recovered.length, 2)
  check('余额恢复文案', recovered.recovered.find((r) => r.siteId === 'a')?.title, '余额已恢复')
  check('配额恢复文案', recovered.recovered.find((r) => r.window === '5-hour')?.title, '配额已恢复')
  check('恢复级别为 ok', recovered.recovered[0].level, 'ok')

  // 新增与恢复同时发生
  const mixed = diffAlerts([alerts[0]], { sent: { 'quota-low:k:5-hour': now - 1000 } }, { now })
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
