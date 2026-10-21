/**
 * 首字延迟（TTFT）与输出速度（TPS）的自检。
 *
 * 数据来源是 `llm/stream` waterfall —— 只有那里能拿到分片级时间戳。
 * `assistant/live-chunk` 是瞬时事件，不经 `session/event` 派发，
 * 从事件流拿不到首字时刻（这是最初实现失败的原因）。
 *
 * 口径：
 *   TTFT = 首个内容 chunk 的时刻 - 请求发起时刻
 *   TPS  = 输出 token / (最后一个内容 chunk 的时刻 - 首片时刻)
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
function checkClose(label, actual, expected, tolerance = 0.15) {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    failures.push(`${label}：期望约 ${expected}，实际 ${String(actual)}`)
    return
  }
  const ok = Math.abs(actual - expected) <= Math.abs(expected) * tolerance
  if (!ok) failures.push(`${label}：期望约 ${expected}，实际 ${actual}`)
}

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
const streamHook = listeners.get('llm/stream')
checkTrue('注册了 llm/stream', typeof streamHook === 'function')

const TRACKER = Symbol.for('dsh-token-metrics:tracker')
const tracker = () => globalThis[TRACKER]
/**
 * 读性能汇总。
 *
 * 不走 snapshot()：它有 3 秒缓存，连续断言会拿到旧值。
 * 直接从 store 现算，与 snapshot 里的 summarize 口径一致。
 */
const perfTotal = () => {
  const t = tracker()?.store?.performance?.total ?? { ttftMsSum: 0, ttftCount: 0, decodeMsSum: 0, outputTokens: 0 }
  return {
    ttftMs: t.ttftCount > 0 ? t.ttftMsSum / t.ttftCount : null,
    tps: t.decodeMsSum > 0 ? t.outputTokens / (t.decodeMsSum / 1000) : null,
    samples: t.ttftCount,
  }
}
const perfByModel = (key) => {
  const t = tracker()?.store?.performance?.byModel?.[key]
  if (t === undefined) return undefined
  return {
    ttftMs: t.ttftCount > 0 ? t.ttftMsSum / t.ttftCount : null,
    tps: t.decodeMsSum > 0 ? t.outputTokens / (t.decodeMsSum / 1000) : null,
    samples: t.ttftCount,
  }
}

/** 跑一次 stream：chunks 带 sleep，模拟真实的流式间隔。 */
async function runStream({ provider, model, chunks, purpose }) {
  const options = { provider, model, sessionId: 'timing-session', purpose }
  const iterable = streamHook(options, () => (async function* () {
    for (const chunk of chunks) {
      if (chunk.delay !== undefined) await new Promise((r) => setTimeout(r, chunk.delay))
      yield chunk.value
    }
  })())
  for await (const _ of iterable) { /* 全部消费 */ }
}

// ── 用例 1：有内容分片 → 采集到 TTFT 与 TPS ──
await runStream({
  provider: 'p', model: 'm',
  chunks: [
    { delay: 60, value: { type: 'text-delta', text: 'a' } },
    { delay: 60, value: { type: 'text-delta', text: 'b' } },
    { delay: 60, value: { type: 'text-delta', text: 'c' } },
    { value: { type: 'usage', usage: { inputTokens: 10, outputTokens: 30, totalTokens: 40 } } },
    { value: { type: 'finish', reason: { kind: 'stop' } } },
  ],
})

{
  const perf = perfTotal()
  checkTrue('采集到首字延迟', typeof perf.ttftMs === 'number' && perf.ttftMs > 0, String(perf.ttftMs))
  checkTrue('采集到输出速度', typeof perf.tps === 'number' && perf.tps > 0, String(perf.tps))
  check('采样数为 1', perf.samples, 1)
  // 首字约 60ms（流式第一个 chunk 前）
  checkTrue('TTFT 在合理范围', perf.ttftMs >= 40 && perf.ttftMs < 400, `${perf.ttftMs}ms`)
}

// ── 用例 2：只有 usage / finish、没有内容分片 → 不采集 ──
const beforeSamples = perfTotal().samples
await runStream({
  provider: 'p', model: 'm',
  chunks: [
    { delay: 20, value: { type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } } },
    { value: { type: 'finish', reason: { kind: 'stop' } } },
  ],
})
check('无内容分片不采样', perfTotal().samples, beforeSamples)

// ── 用例 3：分模型独立统计 ──
await runStream({
  provider: 'q', model: 'm2',
  chunks: [
    { delay: 30, value: { type: 'text-delta', text: 'x' } },
    { delay: 30, value: { type: 'text-delta', text: 'y' } },
    { value: { type: 'usage', usage: { inputTokens: 8, outputTokens: 50, totalTokens: 58 } } },
  ],
})
{
  const entry = perfByModel('q/m2')
  checkTrue('按模型分桶存在 q/m2', entry !== undefined, '实际无 q/m2')
  checkTrue('q/m2 有首字数据', typeof entry?.ttftMs === 'number', String(entry?.ttftMs))
}

// ── 用例 4：多次调用的平均 ──
{
  const perf = perfTotal()
  check('累计采样数为 2', perf.samples, 2)
  // 两次都要有值，且是平均而非累加
  checkTrue('平均值合理', perf.ttftMs > 0 && perf.ttftMs < 500, `${perf.ttftMs}ms`)
}

// ── 用例 5：compaction 调用也要采集（它不落 usage 但有内容） ──
await runStream({
  provider: 'p', model: 'm', purpose: 'compaction',
  chunks: [
    { delay: 20, value: { type: 'text-delta', text: 'summary' } },
    { value: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } },
  ],
})
check('compaction 也采样', perfTotal().samples, 3)

if (prevHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = prevHome
rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 首字延迟与输出速度全部断言通过')
console.log('  llm/stream 采集 / 无内容分片不采样 / 分模型 / 平均 / compaction')
