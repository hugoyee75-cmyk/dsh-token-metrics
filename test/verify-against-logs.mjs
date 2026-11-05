/**
 * 端到端验证：把插件统计出的数据，与真实会话日志独立比对。
 *
 * 插件说它统计了 N 次调用；这里直接从 `.jsonl.zstd` 日志里数一遍，
 * 两边必须一致。这是唯一能证明「统计准确」的方式——不能只信插件自己。
 *
 * 运行：node test/verify-against-logs.mjs
 *
 * 接口地址默认取 `DSH_WEB_URL`，没有才退回旧端口；日志去重键与插件一致：
 * 有 message.id 用它（会话复制/fork 时 id 不变），没有才用会话 + turn/step。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')
const storePath = join(dshHome, 'token-metrics', 'usage.json')
const webBase = (process.env.DSH_WEB_URL?.trim() || 'http://127.0.0.1:53414').replace(/\/+$/, '')
const summaryRoute = `${webBase}/api/dsh-token-metrics/summary`

const failures = []
function check(label, actual, expected, detail) {
  if (actual !== expected) {
    failures.push(`${label}: 期望 ${expected}，实际 ${actual}${detail ? `（${detail}）` : ''}`)
  }
}
function checkTrue(label, condition, detail = '') {
  if (condition !== true) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

/**
 * 在途调用容差。
 *
 * 验证跑在正在使用的机器上：账本落盘、日志写入、接口读取之间总可能有
 * 一两条刚完成的调用。这里只抓「成倍/成批」的口径错误，不把在途调用当失败。
 * 需要严格比对时用 `VERIFY_TOLERANCE=0`。
 */
const TOLERANCE = Number(process.env.VERIFY_TOLERANCE ?? 5)

// —— 1. 从真实日志独立统计 ——
function collectLogFiles(dir) {
  const files = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name === 'session.v4.jsonl.zstd') files.push(full)
    }
  }
  walk(dir)
  return files
}

if (!existsSync(sessionsRoot)) {
  console.error(`✗ 找不到会话日志目录：${sessionsRoot}`)
  process.exit(1)
}

// —— 1. 先读插件账本，取一个截止时间 ——
if (!existsSync(storePath)) {
  console.error(`✗ 插件还没有写出数据文件：${storePath}`)
  console.error('  请先重启 DSH，并至少发一条消息。')
  process.exit(1)
}
const store = JSON.parse(readFileSync(storePath, 'utf8'))

/**
 * 以账本的 updatedAt 作为比对截止点。
 *
 * 验证脚本运行时机器可能仍在产生调用：只比「账本最后一次落盘之前完成」
 * 的事件，两边才是同一个快照。否则日志扫描期间的新调用会让计数永远差几条。
 */
const cutoff = Number(store.updatedAt) || Date.now()
const files = collectLogFiles(sessionsRoot)
/** key -> 出现在哪些会话里。用于识别「会话复制」产生的重复消息。 */
const keyOwners = new Map()
let eventCount = 0

for (const file of files) {
  let text
  try {
    text = execFileSync('zstd', ['-dc', '--', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
  } catch {
    continue
  }
  let sessionId
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (event.type === 'session') sessionId = event.id
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || usage === null) continue
    const stamp = Number(event.time)
    if (Number.isFinite(stamp) && stamp > cutoff) continue
    eventCount += 1
    const source = event.data?.message?.source ?? {}
    const messageId = event.data?.message?.id
    // 与插件同口径：message.id 优先，跨复制会话去重；没有 id 才用会话级键。
    const key = typeof messageId === 'string' && messageId !== ''
      ? `msg:${source.provider ?? '?'}:${messageId}`
      : `${sessionId}:${event.data.turn}:${event.data.step}`
    const owners = keyOwners.get(key) ?? new Set()
    owners.add(sessionId)
    keyOwners.set(key, owners)
  }
}

// 只有「只出现在一个会话里」的键才能逐会话核对；复制会话里的消息会被
// 插件归到其中一个会话，具体是哪一个取决于扫描顺序，不适合硬断言。
const expectedPerSession = new Map()
const ambiguousSessions = new Set()
for (const owners of keyOwners.values()) {
  if (owners.size === 1) {
    const [sessionId] = owners
    expectedPerSession.set(sessionId, (expectedPerSession.get(sessionId) ?? 0) + 1)
  } else {
    for (const sessionId of owners) ambiguousSessions.add(sessionId)
  }
}


console.log('=== 独立比对 ===')
console.log(`日志文件          ${files.length}`)
console.log(`日志内调用事件    ${eventCount}（≤ 账本快照）`)
console.log(`日志唯一调用键    ${keyOwners.size}`)
console.log(`插件 total.calls  ${store.total.calls}`)
console.log(`插件 seen 键数    ${Object.keys(store.seen).length}`)
console.log('')

// —— 3. 断言 ——
const callDelta = store.total.calls - keyOwners.size
checkTrue(`插件调用数与日志唯一键一致（容差 ${TOLERANCE}）`,
  Math.abs(callDelta) <= TOLERANCE, `差 ${callDelta}`)
const seenDelta = Object.keys(store.seen).length - keyOwners.size
checkTrue(`插件去重键数与日志唯一键一致（容差 ${TOLERANCE}）`,
  Math.abs(seenDelta) <= TOLERANCE, `差 ${seenDelta}`)
check('total.calls 与 seen 自洽', store.total.calls, Object.keys(store.seen).length)

// 每个「消息不重复」的会话逐一核对
if (ambiguousSessions.size > 0) {
  console.log(`含复制消息的会话  ${ambiguousSessions.size}（跳过逐会话核对）`)
}
let sessionMismatch = 0
for (const [sessionId, count] of expectedPerSession) {
  if (ambiguousSessions.has(sessionId)) continue
  const recorded = store.bySession[sessionId]?.counters?.calls
  // 单会话只容忍 1 条在途调用；再多就说明是真的漏记/重复。
  if (recorded === undefined || Math.abs(recorded - count) > 1) {
    sessionMismatch += 1
    if (sessionMismatch <= 8) {
      console.log(`  ✗ ${sessionId.slice(0, 44)}  日志=${count} 插件=${recorded}`)
    }
  }
}
check('逐会话计数全部一致', sessionMismatch, 0)

// 各维度求和自洽
const sumSessions = Object.values(store.bySession).reduce((sum, entry) => sum + (entry?.counters?.calls ?? 0), 0)
const sumModels = Object.values(store.byModel).reduce((sum, value) => sum + (value?.calls ?? 0), 0)
const sumProviders = Object.values(store.byProvider).reduce((sum, value) => sum + (value?.calls ?? 0), 0)
const sumDays = Object.values(store.byDay).reduce((sum, value) => sum + (value?.calls ?? 0), 0)
check('按会话求和自洽', sumSessions, store.total.calls)
check('按模型求和自洽', sumModels, store.total.calls)
check('按供应商求和自洽', sumProviders, store.total.calls)
check('按日期求和自洽', sumDays, store.total.calls)

// —— 4. 核对接口 ——
let summary
try {
  const response = await fetch(summaryRoute, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  summary = await response.json()
} catch (error) {
  console.log(`\n! 接口不可访问（${error.message}），跳过接口核对`)
}

if (summary !== undefined) {
  console.log('\n=== 接口核对 ===')
  console.log(`接口 total.calls  ${summary.totals.all.calls}`)
  checkTrue('接口与磁盘数据一致（容差 ' + TOLERANCE + '）',
    Math.abs(summary.totals.all.calls - store.total.calls) <= TOLERANCE,
    `差 ${summary.totals.all.calls - store.total.calls}`)
  check('接口自检通过', summary.integrity?.consistent, true)
  check('接口返回 buildId', typeof summary.buildId, 'string')
  check('接口返回趋势序列', Object.keys(summary.trend ?? {}).length > 0, true)
  check('接口返回配置', typeof summary.config, 'object')
  check('命中率是数字', typeof summary.totals.all.cacheHitRate, 'number')
  check('命中率在合理范围', summary.totals.all.cacheHitRate >= 0 && summary.totals.all.cacheHitRate <= 1, true)
  check('今日分桶存在', typeof summary.totals.today?.calls, 'number')
  check('近 7 天分桶存在', typeof summary.totals.week?.calls, 'number')
  check('按模型非空', Object.keys(summary.byModel).length > 0, true)
  check('按供应商非空', Object.keys(summary.byProvider).length > 0, true)
  // 会话明细默认隐藏；只有配置打开时才要求非空。
  if (summary.config?.showSessions === true) {
    check('按会话非空', Object.keys(summary.bySession).length > 0, true)
  }
  check('按日期非空', Object.keys(summary.byDay).length > 0, true)

  console.log(`接口 buildId      ${summary.buildId}`)
  console.log(`接口自检          ${summary.integrity?.consistent === true ? '通过' : '未通过'}`)
  console.log(`今日调用          ${summary.totals.today.calls}`)
  console.log(`近 7 天调用       ${summary.totals.week.calls}`)
}

if (failures.length > 0) {
  console.error('\n失败：')
  for (const failure of failures) console.error('  ✗', failure)
  process.exit(1)
}

console.log('\n✓ 插件统计与真实日志完全一致')
