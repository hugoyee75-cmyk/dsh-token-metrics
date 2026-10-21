/**
 * 首字延迟（TTFT）与输出速度（TPS）的自检。
 *
 * 这两项只能在实时事件里算：会话日志没有分片级时间戳，回扫补不出来。
 * 口径与 DSH 自带统计一致：
 *   TTFT = 首个 assistant/live-chunk 的时间 - step/start 的时间
 *   TPS  = outputTokens / (assistant/message 时间 - 首片时间)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}
function checkTrue(label, condition, detail = '') {
  if (!condition) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

// 每个用例用独立的数据目录，避免互相串数据
const home = mkdtempSync(join(tmpdir(), 'dsh-timing-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

const listeners = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  on(name, listener) { listeners.set(name, listener); return () => {} },
  effect(fn) { fn(); return () => {} },
  inject(deps, callback) {
    if (typeof deps === 'function') return () => {}
    callback({
      sessionPersistence: { async list() { return [] }, async open() { throw new Error('no') } },
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    })
    return () => {}
  },
  get() { return undefined },
}

apply(ctx)
const onEvent = listeners.get('session/event')
checkTrue('注册了 session/event', typeof onEvent === 'function')

const TRACKER = Symbol.for('dsh-token-metrics:tracker')
const tracker = () => globalThis[TRACKER]

const session = { id: 'timing-session', header: {} }
const send = (event) => onEvent(session, event)

// ── 用例 1：完整时序 —— 200ms 出首字，再用 800ms 解码 90 个 token ──
send({ type: 'step/start', seq: 1, time: 1_000_000, data: { turn: 1, step: 1 } })
send({ type: 'assistant/live-chunk', seq: 2, time: 1_000_200, data: { turn: 1, step: 1 } })
// 第二个分片不应覆盖首片时间
send({ type: 'assistant/live-chunk', seq: 3, time: 1_000_500, data: { turn: 1, step: 1 } })
send({
  type: 'assistant/message', seq: 4, time: 1_001_000,
  data: {
    turn: 1, step: 1,
    message: { source: { provider: 'p', model: 'm' } },
    usage: { inputTokens: 100, outputTokens: 90, totalTokens: 190 },
  },
})

{
  const perf = tracker().snapshot().performance?.total ?? {}
  check('平均首字延迟', Math.round(perf.ttftMs ?? 0), 200)
  // 900 token / 0.8s = 112.5
  check('输出速度', Math.round(perf.tps ?? 0), 113)
  check('采样数', perf.samples, 1)
}

// ── 用例 2：缺 step/start 的调用不应产出计时 ──
const before = tracker().snapshot().performance?.total?.samples ?? 0
send({
  type: 'assistant/message', seq: 5, time: 1_002_000,
  data: {
    turn: 1, step: 2,
    message: { source: { provider: 'p', model: 'm' } },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  },
})
check('缺起始标记不采样', tracker().snapshot().performance?.total?.samples ?? 0, before)

// ── 用例 3：多次调用的平均值 ──
// 第二次：100ms 出首字，再 200ms 出 20 token
send({ type: 'step/start', seq: 6, time: 2_000_000, data: { turn: 2, step: 1 } })
send({ type: 'assistant/live-chunk', seq: 7, time: 2_000_100, data: { turn: 2, step: 1 } })
send({
  type: 'assistant/message', seq: 8, time: 2_000_300,
  data: {
    turn: 2, step: 1,
    message: { source: { provider: 'p', model: 'm' } },
    usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
  },
})

{
  const perf = tracker().snapshot().performance?.total ?? {}
  // (200 + 100) / 2 = 150
  check('两次调用的平均首字', Math.round(perf.ttftMs ?? 0), 150)
  check('累计采样数', perf.samples, 2)
  // 总输出 110 token / 总解码 1.0s = 110
  check('两次调用的综合速度', Math.round(perf.tps ?? 0), 110)
}

// ── 用例 4：分模型维度 ──
send({ type: 'step/start', seq: 9, time: 3_000_000, data: { turn: 3, step: 1 } })
send({ type: 'assistant/live-chunk', seq: 10, time: 3_000_400, data: { turn: 3, step: 1 } })
send({
  type: 'assistant/message', seq: 11, time: 3_000_900,
  data: {
    turn: 3, step: 1,
    message: { source: { provider: 'q', model: 'm2' } },
    usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 },
  },
})
{
  const byModel = tracker().snapshot().performance?.byModel ?? {}
  checkTrue('按模型分桶存在', byModel['q/m2'] !== undefined, JSON.stringify(Object.keys(byModel)))
  check('新模型首字', Math.round(byModel['q/m2']?.ttftMs ?? 0), 400)
}

// 收尾
if (prevHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = prevHome
rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 首字延迟与输出速度全部断言通过')
console.log('  TTFT 口径 / 分片取首片 / 缺标记不采样 / 多次平均 / 分模型统计')
