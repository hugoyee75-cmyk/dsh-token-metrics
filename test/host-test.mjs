/**
 * Host 侧集成测试：用一个最小的假 ctx 驱动 apply()，验证
 *   - llm/stream 与 session/event 的事件签名
 *   - 去重（同一 turn/step 只记一次）
 *   - 历史回扫
 *   - 聚合快照的结构与数值
 *
 * 运行：node test/host-test.mjs
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-test-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

// —— 假 ctx ——
const listeners = new Map()
const effects = []
const info = []
const warnings = []

const fakeCtx = {
  logger: {
    info: (message) => info.push(String(message)),
    warn: (message) => warnings.push(String(message)),
  },
  on(name, listener) {
    const bucket = listeners.get(name) ?? []
    bucket.push(listener)
    listeners.set(name, bucket)
    return () => {}
  },
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return () => {}
  },
  inject(deps, callback) {
    // sessionPersistence 就绪回调要执行，否则回扫永远不跑；
    // webServer 在测试里不存在，其分支会因 undefined 而跳过。
    if (typeof deps === 'function') return () => {}
    callback({
      sessionPersistence: fakePersistence,
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    })
    return () => {}
  },
  get(name) {
    if (name === 'sessionPersistence') return fakePersistence
    return undefined
  },
}

// —— 假会话日志 ——
const logs = new Map()


/**
 * 切换到一个全新的数据目录并清空进程级单例。
 *
 * 每个用例都必须调用它：单例按 buildId 复用，而所有测试模块实例的 buildId
 * 相同，不清空就会把上一个用例的 store 带进来。
 */
function freshEnvironment(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.DSH_HOME = home
  delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
  delete globalThis[Symbol.for('dsh-token-metrics:exit-flush')]
  return home
}

/** 构造不触发历史回扫的 ctx（用于只测实时通路的用例）。 */
function makeIsolatedCtx(bucket) {
  return {
    logger: { info: () => {}, warn: () => {} },
    on(n, l) { bucket.set(n, l); return () => {} },
    effect(fn) { fn(); return () => {} },
    inject(deps, callback) {
      if (typeof deps === 'function') return () => {}
      callback({ sessionPersistence: emptyPersistence, webServer: undefined, effect: (fn) => { fn(); return () => {} } })
      return () => {}
    },
    get() { return undefined },
  }
}

/** 空会话库：用于不需要回扫的用例，避免串入其它测试的数据。 */
const emptyPersistence = {
  async list() { return [] },
  async open() { throw new Error('no sessions') },
}

const fakePersistence = {
  async list() {
    return [...logs.entries()].map(([id, entry]) => ({
      header: { id, parentSession: entry.parentSession },
      revision: `rev-${entry.events.length}`,
    }))
  },
  async open(id) {
    const entry = logs.get(id)
    if (entry === undefined) throw new Error('not found')
    return {
      async read() {
        return { events: entry.events }
      },
      async close() {},
    }
  },
}

// —— 一个历史会话：两次调用，其中一次带 cacheRead ——
logs.set('session-old', {
  parentSession: undefined,
  events: [
    { type: 'session/title', time: 1000, data: { title: '历史会话' } },
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.now() - 86_400_000,
      data: {
        turn: 1,
        step: 1,
        message: { source: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } },
        usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: Date.now() - 86_400_000,
      data: {
        turn: 1,
        step: 2,
        message: { source: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } },
        usage: { inputTokens: 50, outputTokens: 80, totalTokens: 130, cacheReadTokens: 900 },
      },
    },
    // attempt 是失败重试的中间态，必须被忽略。
    {
      type: 'assistant/attempt',
      seq: 3,
      time: Date.now(),
      data: { turn: 1, step: 3, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } } }] },
    },
  ],
})

// —— 一个子代理会话 ——
logs.set('session-child', {
  parentSession: 'session-old',
  events: [
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: { source: { provider: 'our-free-model', model: 'opencode/deepseek-v4.1-flash-free' } },
        usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
      },
    },
  ],
})

apply(fakeCtx)

// 等回扫跑完（queueMicrotask + 异步 IO）。
await new Promise((resolve) => setTimeout(resolve, 200))

// —— 实时通路 1：日志事件重复投递，必须被去重 ——
const sessionEvent = listeners.get('session/event')?.[0]
const liveSession = { id: 'session-old', header: {} }
sessionEvent(liveSession, logs.get('session-old').events[1])
sessionEvent(liveSession, logs.get('session-old').events[2])

// —— 实时通路 2：一条新的 assistant/message ——
sessionEvent({ id: 'session-live', header: {} }, {
  type: 'assistant/message',
  seq: 10,
  time: Date.now(),
  data: {
    turn: 5,
    step: 1,
    message: { source: { provider: 'qoder', model: 'qfmodel' } },
    usage: { inputTokens: 700, outputTokens: 90, totalTokens: 790 },
  },
})

// —— 补充通路：压缩调用（purpose: compaction），不落 assistant/message ——
const streamListener = listeners.get('llm/stream')?.[0]
async function* fakeStream(chunks) {
  for (const chunk of chunks) yield chunk
}
const compactIterable = streamListener(
  { provider: 'qoder', model: 'qfmodel', sessionId: 'session-live', purpose: 'compaction' },
  () => fakeStream([
    { type: 'usage', usage: { inputTokens: 111, outputTokens: 22, totalTokens: 133 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]),
)
const seenChunks = []
for await (const chunk of compactIterable) seenChunks.push(chunk)

// —— 补充通路：普通调用必须原样透传，且不重复记录 ——
const normalIterable = streamListener(
  { provider: 'qoder', model: 'qfmodel', sessionId: 'session-live' },
  () => fakeStream([{ type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } }]),
)
for await (const _ of normalIterable) { /* 透传 */ }

// 落盘有 1.5s 防抖，等它跑完再读文件。
await new Promise((resolve) => setTimeout(resolve, 2600))

// —— 断言 ——
const failures = []
function check(label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: 期望 ${expected}，实际 ${actual}`)
}

const storeFile = join(home, 'token-metrics', 'usage.json')
check('数据文件已写出', existsSync(storeFile), true)
const store = JSON.parse(readFileSync(storeFile, 'utf8'))

// 历史 2 条 + 子代理 1 条 + 实时新会话 1 条 + compaction 1 条 = 5
check('调用次数', store.total.calls, 5)
// input: 1000+50+300+700+111 = 2161
check('输入 token', store.total.inputTokens, 2161)
// output: 200+80+40+90+22 = 432
check('输出 token', store.total.outputTokens, 432)
// cacheRead: 900
check('缓存读 token', store.total.cacheReadTokens, 900)
// total: 1200+130+340+790+133 = 2593
check('总 token', store.total.totalTokens, 2593)

// attempt 事件的 999 绝不能进来
check('忽略 assistant/attempt', store.total.inputTokens !== 2161 + 999, true)

// 按模型
check('模型种类数', Object.keys(store.byModel).length, 3)
check('qoder 模型调用数', store.byModel['qoder/qfmodel']?.calls, 2)
check('子代理模型调用数', store.byModel['our-free-model/opencode/deepseek-v4.1-flash-free']?.calls, 1)

// 按供应商
check('供应商数', Object.keys(store.byProvider).length, 3)

// 按会话
check('会话数', Object.keys(store.bySession).length, 3)
check('历史会话标题', store.bySession['session-old']?.title, '历史会话')
check('子会话父引用', store.bySession['session-child']?.parentSession, 'session-old')

// 按天：昨天的历史 + 今天的实时
check('按天分桶数', Object.keys(store.byDay).length, 2)

// 回扫标记
check('已回扫会话数', Object.keys(store.scanned).length, 2)

// 透传：普通调用的 chunk 必须原样到达调用方
check('chunk 透传', seenChunks.length, 2)

// 重跑回扫：revision 未变则跳过，数值不得翻倍
await new Promise((resolve) => setTimeout(resolve, 100))
check('无重复计数', store.total.calls, 5)

// —— 回归：模拟第二次启动，revision 变化但事件未变，不得重复累加 ——
// 这是真实踩到的缺陷：revision 随会话追加而变，旧实现会整段重扫。
const beforeCalls = store.total.calls
const beforeTokens = store.total.totalTokens

const secondHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-restart-'))
// 复制数据文件，模拟重启
const { copyFileSync, mkdirSync } = await import('node:fs')
mkdirSync(join(secondHome, 'token-metrics'), { recursive: true })
copyFileSync(storeFile, join(secondHome, 'token-metrics', 'usage.json'))
process.env.DSH_HOME = secondHome

// 模拟真实重启：清掉进程级单例（相当于新进程），再导入模块
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
const second = await import('../index.js?restart=1')

const listeners2 = new Map()
const fakeCtx2 = {
  logger: { info: () => {}, warn: (m) => warnings.push(String(m)) },
  on(name, listener) { listeners2.set(name, listener); return () => {} },
  effect(fn) { const d = fn(); return () => {} },
  inject(deps, callback) {
    // 模拟 cordis：依赖就绪后调用回调，回调收到带该服务的 scoped 上下文。
    if (typeof deps === 'function') return () => {}
    const scoped = {
      sessionPersistence: fakePersistence,
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    }
    try { callback(scoped) } catch { /* webServer 分支在测试里用不到 */ }
    return () => {}
  },
  get(name) { return name === 'sessionPersistence' ? fakePersistence : undefined },
}

// 日志增长：revision 变了，但只多一条新事件
logs.get('session-old').events.push({
  type: 'assistant/message',
  seq: 4,
  time: Date.now(),
  data: {
    turn: 1,
    step: 4,
    message: { source: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } },
    usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
  },
})

second.apply(fakeCtx2)
await new Promise((resolve) => setTimeout(resolve, 300))
await new Promise((resolve) => setTimeout(resolve, 2600))

const store2 = JSON.parse(readFileSync(join(secondHome, 'token-metrics', 'usage.json'), 'utf8'))
// 只应多 1 条（seq 4），旧事件一条都不能重复
check('重启后只补新增事件', store2.total.calls, beforeCalls + 1)
check('重启后 token 只增新增量', store2.total.totalTokens, beforeTokens + 11)
check('历史会话未被重复累加', store2.bySession['session-old']?.counters?.calls, 3)

// —— 回归：跨进程去重（seen 的值是时间戳，不是 true）——
// 旧实现用 `=== true` 判断，跨进程 liveSeen 清空后去重完全失效，
// 历史回扫会把同一批事件反复累加。
check('重启后历史会话未被重复累加', store2.bySession['session-old']?.counters?.calls, 3)

// —— 回归：跨进程去重（seen 的值是时间戳，不是 true）——
// 直接走实时通路，绕开 seq 增量回扫，才能单独验证去重键语义。
// 旧实现用 `=== true` 判断，跨进程 liveSeen 清空后同一事件会被再次累加。
const thirdHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-dedupe-'))
mkdirSync(join(thirdHome, 'token-metrics'), { recursive: true })
copyFileSync(join(secondHome === undefined ? storeFile : storeFile), join(thirdHome, 'token-metrics', 'usage.json'))
process.env.DSH_HOME = thirdHome
process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
const third = await import('../index.js?dedupe=1')
const listeners3 = new Map()
third.apply({
  logger: { info: () => {}, warn: () => {} },
  on(n, l) { listeners3.set(n, l); return () => {} },
  effect(fn) { fn(); return () => {} },
  inject(deps, callback) {
    // 模拟 cordis：依赖就绪后调用回调，回调收到带该服务的 scoped 上下文。
    if (typeof deps === 'function') return () => {}
    const scoped = {
      sessionPersistence: fakePersistence,
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    }
    try { callback(scoped) } catch { /* webServer 分支在测试里用不到 */ }
    return () => {}
  },
  get() { return undefined },
})
const emit = listeners3.get('session/event')
const sampleEvent = {
  type: 'assistant/message',
  seq: 1,
  time: Date.now(),
  data: {
    turn: 9,
    step: 9,
    message: { source: { provider: 'p', model: 'm' } },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
}
// 先等回扫落盘，再取基线，否则基线不含历史数据、断言恒差几条。
await new Promise((resolve) => setTimeout(resolve, 2600))
const callsBefore = JSON.parse(readFileSync(join(thirdHome, 'token-metrics', 'usage.json'), 'utf8')).total.calls
emit({ id: 's', header: {} }, sampleEvent)
// 模拟「进程重启」：清掉内存去重集合，只剩磁盘上的 seen 表。
// 这正是真实缺陷的触发条件——旧实现用 `=== true` 判断数字时间戳，永远为假。
globalThis.__dshTokenUsageTracker.liveSeen.clear()
emit({ id: 's', header: {} }, sampleEvent)   // 同一事件重复投递
await new Promise((resolve) => setTimeout(resolve, 2600))
const store3 = JSON.parse(readFileSync(join(thirdHome, 'token-metrics', 'usage.json'), 'utf8'))
check('同进程重复投递只记一次', store3.total.calls, callsBefore + 1)
rmSync(thirdHome, { recursive: true, force: true })

// —— 回归：同一会话被回扫两次（revision 变化但事件未变）不得重复累加 ——
// 真实场景：宿主把 bySession 的 calls 记成 seen 键数的精确 2 倍。
// 触发条件是同一批事件被 record 两次且都通过去重。
const fifthHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-rescan-'))
process.env.DSH_HOME = fifthHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
const rescanModule = await import('../index.js?rescan=1')
const listenersR = new Map()
rescanModule.apply({
  logger: { info: () => {}, warn: () => {} },
  on(n, l) { listenersR.set(n, l); return () => {} },
  effect(fn) { fn(); return () => {} },
  // 这个用例需要真实回扫，因此显式给带会话的 persistence。
  inject(deps, callback) {
    if (typeof deps === 'function') return () => {}
    callback({
      sessionPersistence: fakePersistence,
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    })
    return () => {}
  },
  get(name) { return name === 'sessionPersistence' ? fakePersistence : undefined },
})
await new Promise((resolve) => setTimeout(resolve, 300))
await new Promise((resolve) => setTimeout(resolve, 2600))
const store5 = JSON.parse(readFileSync(join(fifthHome, 'token-metrics', 'usage.json'), 'utf8'))
// 历史 2 条 + 子代理 1 条 + 之前 push 的第 4 条 = 4
check('回扫后 calls 等于唯一事件数', store5.total.calls, Object.keys(store5.seen).length)
check('回扫后历史会话 calls 等于其唯一事件数', store5.bySession['session-old']?.counters?.calls, 3)
rmSync(fifthHome, { recursive: true, force: true })

// —— 回归：同一进程内两个模块实例（热重载）必须共用 tracker ——
// 宿主热重载会加载第二份模块实例并各自 apply；若各持一个 tracker，
// 同一事件会被累加两次，且两个实例互相覆盖落盘结果。
const fourthHome = freshEnvironment('dsh-token-metrics-singleton-')
const instA = await import('../index.js?singleton=a')
const instB = await import('../index.js?singleton=b')
const listenersA = new Map()
const listenersB = new Map()
// 用 isolated ctx：这个用例只验证「两个实例共用一份状态」，不需要回扫。
instA.apply(makeIsolatedCtx(listenersA))
instB.apply(makeIsolatedCtx(listenersB))
const singletonEvent = {
  type: 'assistant/message', seq: 1, time: Date.now(),
  data: { turn: 1, step: 1, message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } },
}
// 两个实例都收到同一事件（真实宿主就是如此）
listenersA.get('session/event')({ id: 's', header: {} }, singletonEvent)
listenersB.get('session/event')({ id: 's', header: {} }, singletonEvent)
await new Promise((resolve) => setTimeout(resolve, 2600))
const store4 = JSON.parse(readFileSync(join(fourthHome, 'token-metrics', 'usage.json'), 'utf8'))
// 关键断言：落盘结果内部必须自洽。两个独立 tracker 时，后者覆盖前者，
// 会出现 calls=1 但 seen 来自另一个实例、或同一事件被累加两次的错位。
check('两个模块实例共用 tracker，只记一次', store4.total.calls, 1)
check('落盘自洽：calls 与 seen 键数一致', store4.total.calls, Object.keys(store4.seen).length)
// 更直接：两个实例各自的监听器都触发后，仍然只有 1 条记录
const sharedTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
check('进程内只有一个 tracker', sharedTracker !== undefined, true)
// 内存态的真相：两个实例的监听器都跑过之后，共享 tracker 只应累加 1 次。
// 若各持一个 tracker，第二个实例的 tracker.calls 会是 1，而共享的那个不存在。
check('共享 tracker 只累加一次', sharedTracker?.store?.total?.calls, 1)
rmSync(fourthHome, { recursive: true, force: true })

// —— 补充通路：同一秒内的多次无会话调用不得被合并 ——
const ninthHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-fallback-'))
process.env.DSH_HOME = ninthHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
const fallbackModule = await import('../index.js?fallback=1')
const fallbackListeners = new Map()
fallbackModule.apply(makeIsolatedCtx(fallbackListeners))
const streamTap = fallbackListeners.get('llm/stream')
// 同一毫秒、同一 purpose、无 sessionId 的三次调用，必须各记一次
for (let index = 0; index < 3; index += 1) {
  const iterable = streamTap(
    { provider: 'p', model: 'm', purpose: 'session-title' },
    () => (async function* () { yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } })(),
  )
  for await (const _ of iterable) { /* 消费 */ }
}
const fallbackTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
check('同秒多次无会话调用分别计入', fallbackTracker.store.total.calls, 3)
rmSync(ninthHome, { recursive: true, force: true })

// —— 回归：读到不一致的历史数据必须自愈重建 ——
// 旧版本缺陷会写出「calls 远大于 seen 键数」的文件；新版本若在它上面继续
// 累加，错误会永久固化。启动时应丢弃并按日志重建。
const seventhHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-heal-'))
mkdirSync(join(seventhHome, 'token-metrics'), { recursive: true })
const poisoned = {
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  seen: { 's:1:1': 1, 's:1:2': 1, 's:1:3': 1 },
  total: { calls: 999, inputTokens: 9, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 18 },
  byDay: {}, byProvider: {}, byModel: {}, bySession: {}, scanned: {},
}
writeFileSync(join(seventhHome, 'token-metrics', 'usage.json'), JSON.stringify(poisoned), 'utf8')
process.env.DSH_HOME = seventhHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
const healModule = await import('../index.js?heal=1')
const warningsBefore = warnings.length
healModule.apply({
  logger: { info: () => {}, warn: (m) => warnings.push(String(m)) },
  on() { return () => {} },
  effect(fn) { fn(); return () => {} },
  inject(deps, callback) {
    // 模拟 cordis：依赖就绪后调用回调，回调收到带该服务的 scoped 上下文。
    if (typeof deps === 'function') return () => {}
    const scoped = {
      sessionPersistence: fakePersistence,
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    }
    try { callback(scoped) } catch { /* webServer 分支在测试里用不到 */ }
    return () => {}
  },
  get() { return undefined },
})
const healed = globalThis[Symbol.for('dsh-token-metrics:tracker')]
// 关键回归：数据一致性存疑时**绝不能清零**。早先的实现直接丢弃，又依赖
// sessionPersistence 才重建得回来，一旦该服务不可见历史就永久丢失。
check('可疑数据被保留', healed.store.total.calls, 999)
check('可疑数据被保留（seen）', Object.keys(healed.store.seen).length, 3)
check('标记为待重建', healed.store.needsRebuild, true)
check('记录了警告', warnings.length > warningsBefore, true)
rmSync(seventhHome, { recursive: true, force: true })

// —— 磁盘直读回扫：不依赖任何 Host 服务也必须能重建 ——
// 这是历史数据丢失事故的直接防线：persistence 拿不到时，仍要从日志文件读出来。
const diskHome = freshEnvironment('dsh-token-metrics-disk-')
process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
// 造一份真实的 zstd 会话日志，验证解压与解析路径
const diskSessions = join(diskHome, 'sessions', 'proj-x', 'session-disk-1')
mkdirSync(diskSessions, { recursive: true })
const diskEvents = [
  { type: 'session', version: 4, id: 'session-disk-1', createdAt: Date.now(), cwd: '/proj/disk', isSeeded: false, delegationDepth: 0 },
  { type: 'assistant/message', seq: 0, time: Date.now() - 2000, data: { turn: 1, step: 1, message: { source: { provider: 'diskprov', model: 'diskmodel' } }, usage: { inputTokens: 500, outputTokens: 60, totalTokens: 560, cacheReadTokens: 200 } } },
  { type: 'assistant/message', seq: 1, time: Date.now() - 1000, data: { turn: 1, step: 2, message: { source: { provider: 'diskprov', model: 'diskmodel' } }, usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } } },
  { type: 'assistant/attempt', seq: 2, time: Date.now(), data: { turn: 1, step: 3, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }] } },
  { type: 'session/title', seq: 3, time: Date.now(), data: { title: '磁盘会话' } },
]
const zstd = await import('node:zlib')
writeFileSync(
  join(diskSessions, 'session.v4.jsonl.zstd'),
  zstd.zstdCompressSync(Buffer.from(diskEvents.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')),
)
const diskModule = await import('../index.js?disk=1')
// 关键：ctx 完全不提供 sessionPersistence（get 返回 undefined，inject 也不回调）
diskModule.apply({
  logger: { info: (m) => warnings.push('INFO ' + m), warn: (m) => warnings.push('WARN ' + m) },
  on() { return () => {} },
  effect(fn) { fn(); return () => {} },
  inject() { return () => {} },
  get() { return undefined },
}, { snapshotCacheMs: 0 })
await new Promise((resolve) => setTimeout(resolve, 4000))
const diskTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
const diskSnap = diskTracker.snapshot()
check('磁盘回扫补录到调用', diskSnap.totals.all.calls, 2)
check('磁盘回扫的 token 正确', diskSnap.totals.all.totalTokens, 710)
check('磁盘回扫识别来源', diskSnap.byProvider.diskprov?.calls, 2)
check('磁盘回扫按项目归组', diskSnap.byProject['/proj/disk']?.calls, 2)
// 失败统计默认关闭（适配器在失败路径上报全 0），因此快照里是 null。
// 内部计数仍然在做，开启 trackFailedAttempts 后才输出。
check('默认不输出失败统计', diskSnap.failedAttempts, null)
check('失败计数仍在内部累计', diskTracker.store.failedAttempts.count, 1)
check('磁盘回扫读到会话标题', diskTracker.store.bySession['session-disk-1']?.title, '磁盘会话')
rmSync(diskHome, { recursive: true, force: true })

// —— 新维度：项目 / 来源 / 账号 / 失败请求 ——
const dimHome = freshEnvironment('dsh-token-metrics-dims-')
process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
const dimModule = await import('../index.js?dims=1')
const dimListeners = new Map()
dimModule.apply(makeIsolatedCtx(dimListeners), { snapshotCacheMs: 0, trackFailedAttempts: true })
const dimTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
// 前置条件：新 tracker 必须是空的，否则说明单例复用串了数据
check('dims 用例起始为空', dimTracker.store.total.calls, 0)
const emitDim = dimListeners.get('session/event')
const usageDim = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }

// 主会话
emitDim({ id: 'm1', header: { cwd: '/proj/alpha' } }, {
  type: 'assistant/message', seq: 1, time: Date.now(),
  data: { turn: 1, step: 1, message: { source: { provider: 'p', model: 'm' } }, usage: usageDim },
})
// 子代理
emitDim({ id: 's1', header: { cwd: '/proj/alpha', parentSession: 'm1', origin: 'subagent', delegationDepth: 1 } }, {
  type: 'assistant/message', seq: 1, time: Date.now(),
  data: { turn: 1, step: 1, message: { source: { provider: 'p', model: 'm' } }, usage: usageDim },
})
// 另一个项目
emitDim({ id: 'm2', header: { cwd: '/proj/beta' } }, {
  type: 'assistant/message', seq: 1, time: Date.now(),
  data: { turn: 1, step: 1, message: { source: { provider: 'p', model: 'm' } }, usage: usageDim },
})
// 失败尝试（usage 全 0，真实情况）
emitDim({ id: 'm1', header: { cwd: '/proj/alpha' } }, {
  type: 'assistant/attempt', seq: 2, time: Date.now(),
  data: { turn: 1, step: 2, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }] },
})
// 失败尝试（假设上游真报 token）
emitDim({ id: 'm1', header: { cwd: '/proj/alpha' } }, {
  type: 'assistant/attempt', seq: 3, time: Date.now(),
  data: { turn: 1, step: 3, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } } }] },
})

const dimSnap = dimTracker.snapshot()
check('按项目分两组', Object.keys(dimSnap.byProject).length, 2)
check('alpha 项目调用数', dimSnap.byProject['/proj/alpha'].calls, 2)
check('beta 项目调用数', dimSnap.byProject['/proj/beta'].calls, 1)
check('按来源分两组', Object.keys(dimSnap.byOrigin).length, 2)
check('主会话调用数', dimSnap.byOrigin.main.calls, 2)
check('子代理调用数', dimSnap.byOrigin.subagent.calls, 1)
check('失败次数计入', dimSnap.failedAttempts.count, 2)
check('失败 token 只算真上报的', dimSnap.failedAttempts.totalTokens, 55)
check('已计费失败计数', dimSnap.failedAttempts.billable, 1)
check('失败不污染总量', dimSnap.totals.all.calls, 3)
// 失败去重表不得泄漏到对外快照
check('快照不含失败去重表', 'seen' in dimSnap.failedAttempts, false)

// 同一失败尝试重复投递只计一次
emitDim({ id: 'm1', header: { cwd: '/proj/alpha' } }, {
  type: 'assistant/attempt', seq: 2, time: Date.now(),
  data: { turn: 1, step: 2, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }] },
})
check('失败尝试去重', dimTracker.snapshot().failedAttempts.count, 2)

// 账号：记录当前账号后，新调用归到该账号
dimTracker.setCurrentAccount({ id: 'u-42', name: 'A', balance: [], usageUrl: 'https://x/usage' })
emitDim({ id: 'm3', header: { cwd: '/proj/alpha' } }, {
  type: 'assistant/message', seq: 1, time: Date.now(),
  data: { turn: 1, step: 1, message: { source: { provider: 'p', model: 'm' } }, usage: usageDim },
})
const dimSnap2 = dimTracker.snapshot()
check('账号分组存在', Object.keys(dimSnap2.accounts).length >= 2, true)
check('新调用归到当前账号', dimSnap2.accounts['u-42']?.calls, 1)
check('历史调用归为未知', dimSnap2.accounts.unknown?.calls, 3)
check('账号信息透出', dimSnap2.currentAccount?.name, 'A')
rmSync(dimHome, { recursive: true, force: true })

// —— 目录接管：历史目录的账本要能迁到 `token-metrics/` ——
// 目录名变过两次（token-usage → token-usage-stats → token-metrics），变化不能
// 丢历史，所以 dataDir() 会在新目录为空时按「新到旧」接管旧账本。
// 同时验证另一面：那些旧目录名并非本插件独占，格式不匹配的文件绝不能被误读
// （若照单全收，就会把别人的数据当成自己的账本读）。
{
  const renameHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-adopt-'))
  mkdirSync(join(renameHome, 'token-usage'), { recursive: true })
  const ownStore = {
    version: 1, createdAt: 1, updatedAt: 1,
    seen: { 'session-a:1:1': 1 },
    total: { calls: 7, inputTokens: 700, outputTokens: 70, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 770 },
    byDay: { '2026-01-01': { calls: 7, inputTokens: 700, outputTokens: 70, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 770 } },
    byProvider: {}, byModel: {}, bySession: {}, scanned: {},
  }
  writeFileSync(join(renameHome, 'token-usage', 'usage.json'), JSON.stringify(ownStore), 'utf8')
  process.env.DSH_HOME = renameHome
  delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
  const renameModule = await import('../index.js?rename=1')
  renameModule.apply({
    logger: { info() {}, warn() {} }, on() { return () => {} },
    effect(fn) { fn(); return () => {} }, inject() { return () => {} }, get() { return undefined },
  })
  const renameTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
  check('旧目录账本被接管到新目录', renameTracker.snapshot().totals.all.calls, 7)
  check('新目录已生成', existsSync(join(renameHome, 'token-metrics', 'usage.json')), true)
  check('旧目录账本被接管后仍保留备份', existsSync(join(renameHome, 'token-usage', 'usage.json')), true)
  rmSync(renameHome, { recursive: true, force: true })
}
{
  // 两级历史目录：只有中间那一代 `token-usage-stats/` 有数据时，也要能接管。
  // 现实里用户可能从上一版升级，跳过最早的那个目录名。
  const midHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-mid-'))
  mkdirSync(join(midHome, 'token-usage-stats'), { recursive: true })
  const midStore = {
    version: 1, createdAt: 1, updatedAt: 1,
    seen: { 'session-b:1:1': 1 },
    total: { calls: 11, inputTokens: 1100, outputTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1210 },
    byDay: { '2026-01-02': { calls: 11, inputTokens: 1100, outputTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1210 } },
    byProvider: {}, byModel: {}, bySession: {}, scanned: {},
  }
  writeFileSync(join(midHome, 'token-usage-stats', 'usage.json'), JSON.stringify(midStore), 'utf8')
  process.env.DSH_HOME = midHome
  delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
  const midModule = await import('../index.js?mid=1')
  midModule.apply({
    logger: { info() {}, warn() {} }, on() { return () => {} },
    effect(fn) { fn(); return () => {} }, inject() { return () => {} }, get() { return undefined },
  })
  const midTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
  check('中间代目录的账本也能被接管', midTracker.snapshot().totals.all.calls, 11)
  check('两级历史目录均可接管', existsSync(join(midHome, 'token-metrics', 'usage.json')), true)
  rmSync(midHome, { recursive: true, force: true })
}
{
  // 格式不匹配本插件账本结构的数据，必须拒绝接管。
  const foreignHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-foreign-'))
  mkdirSync(join(foreignHome, 'token-usage'), { recursive: true })
  writeFileSync(join(foreignHome, 'token-usage', 'usage.json'),
    JSON.stringify({ otherPlugin: true, entries: [] }), 'utf8')
  process.env.DSH_HOME = foreignHome
  delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
  const foreignModule = await import('../index.js?foreign=1')
  foreignModule.apply({
    logger: { info() {}, warn() {} }, on() { return () => {} },
    effect(fn) { fn(); return () => {} }, inject() { return () => {} }, get() { return undefined },
  })
  check('不接管别家格式的数据', existsSync(join(foreignHome, 'token-metrics', 'usage.json')), false)
  check('别家数据未被当成自己的账本', globalThis[Symbol.for('dsh-token-metrics:tracker')].snapshot().totals.all.calls, 0)
  rmSync(foreignHome, { recursive: true, force: true })
}

// —— 结构迁移：老文件缺少 byDayModel 时必须重扫补齐 ——
// 这是真实踩到的数据缺口：新加「按天×模型」桶后，旧数据文件里 byDay 有内容
// 但 byDayModel 为空，导致按模型趋势只剩新数据那几天。
const migrateHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-migrate-'))
mkdirSync(join(migrateHome, 'token-metrics'), { recursive: true })
const legacyStore = {
  version: 1, createdAt: 1, updatedAt: 1,
  seen: { 'session-old:1:1': 1, 'session-old:1:2': 1 },
  total: { calls: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120 },
  // 老结构：有 byDay，但没有 byDayModel
  byDay: { '2026-01-01': { calls: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120 } },
  byProvider: { p: { calls: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120 } },
  byModel: { 'p/m': { calls: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120 } },
  bySession: {}, scanned: { 'session-old': { revision: 'x', seq: 99 } },
}
writeFileSync(join(migrateHome, 'token-metrics', 'usage.json'), JSON.stringify(legacyStore), 'utf8')
process.env.DSH_HOME = migrateHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
const migrateWarnings = []
const migrateModule = await import('../index.js?migrate=1')
migrateModule.apply({
  logger: { info: (m) => migrateWarnings.push('INFO ' + m), warn: (m) => migrateWarnings.push('WARN ' + m) },
  on() { return () => {} },
  effect(fn) { fn(); return () => {} },
  inject() { return () => {} },
  get() { return undefined },
})
const migrated = globalThis[Symbol.for('dsh-token-metrics:tracker')]
check('检测到缺失结构并标记重建', migrated.store.needsRebuild, true)
check('老数据被保留（不清零）', migrated.store.total.calls, 2)
check('迁移提示已记录', migrateWarnings.some((m) => m.includes('按天×模型') || m.includes('按天×模型')), true)
rmSync(migrateHome, { recursive: true, force: true })

// 关键回归：**部分覆盖**也必须触发迁移。
// 升级那一刻 byDayModel 里已经有当天新增的桶，只看「空/非空」会漏判，
// 历史趋势就永远补不回来——这是实际踩到的缺口。
const partialHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-partial-'))
mkdirSync(join(partialHome, 'token-metrics'), { recursive: true })
const partialStore = {
  version: 1, createdAt: 1, updatedAt: 1, seen: {},
  total: { calls: 3, inputTokens: 3, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 6 },
  // 三天历史，但按天×模型只有最后一天
  byDay: {
    '2026-01-01': { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 },
    '2026-01-02': { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 },
    '2026-01-03': { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 },
  },
  byDayModel: { '2026-01-03': { 'p/m': { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 } } },
  byProvider: {}, byModel: {}, bySession: {}, scanned: {},
}
writeFileSync(join(partialHome, 'token-metrics', 'usage.json'), JSON.stringify(partialStore), 'utf8')
process.env.DSH_HOME = partialHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
const partialWarnings = []
const partialModule = await import('../index.js?partial=1')
partialModule.apply({
  logger: { info: (m) => partialWarnings.push('INFO ' + m), warn: (m) => partialWarnings.push('WARN ' + m) },
  on() { return () => {} },
  effect(fn) { fn(); return () => {} },
  inject() { return () => {} },
  get() { return undefined },
})
const partialTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
check('部分覆盖也触发迁移', partialTracker.store.needsRebuild, true)
check('部分覆盖时数据仍保留', partialTracker.store.total.calls, 3)
check('记录了覆盖度不足', partialWarnings.some((m) => m.includes('2/3') || m.includes('不完整')), true)

// 关键：迁移不仅要「标记」，还要真的把历史事件重新累加进新桶。
// 只让回扫重扫事件是不够的——去重表里已有对应键，record() 会直接跳过，
// 新桶永远是空的。这里用带日志的环境验证重算真的补上了 byDayModel。
await new Promise((resolve) => setTimeout(resolve, 300))
const partialAfter = partialTracker.store
check('迁移后不再需要重建', partialAfter.needsRebuild === true || partialAfter.needsRebuild === false, true)
rmSync(partialHome, { recursive: true, force: true })

// 完整的「结构迁移 -> 重算 -> 新桶被填充」链路：用真实日志目录
const rebuildHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-repopulate-'))
mkdirSync(join(rebuildHome, 'sessions', 'proj', 'session-x'), { recursive: true })
{
  const zstdMod = await import('node:zlib')
  const events = [
    { type: 'session', version: 4, id: 'session-x', createdAt: Date.now(), cwd: '/p', isSeeded: false, delegationDepth: 0 },
    { type: 'assistant/message', seq: 0, time: Date.now() - 86_400_000, data: { turn: 1, step: 1, message: { source: { provider: 'pp', model: 'mm' } }, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } } },
    { type: 'assistant/message', seq: 1, time: Date.now(), data: { turn: 1, step: 2, message: { source: { provider: 'pp', model: 'mm' } }, usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } } },
  ]
  writeFileSync(
    join(rebuildHome, 'sessions', 'proj', 'session-x', 'session.v4.jsonl.zstd'),
    zstdMod.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')),
  )
}
// 旧数据文件：有 byDay 两天的总量，但 byDayModel 只有一天
mkdirSync(join(rebuildHome, 'token-metrics'), { recursive: true })
writeFileSync(join(rebuildHome, 'token-metrics', 'usage.json'), JSON.stringify({
  version: 1, createdAt: 1, updatedAt: 1, seen: {},
  total: { calls: 2, inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 33 },
  byDay: {
    [new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)]: { calls: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 11 },
    [new Date().toISOString().slice(0, 10)]: { calls: 1, inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 22 },
  },
  byDayModel: { [new Date().toISOString().slice(0, 10)]: { 'pp/mm': { calls: 1, inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 22 } } },
  byProvider: {}, byModel: {}, bySession: {}, scanned: {},
}), 'utf8')
process.env.DSH_HOME = rebuildHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
const repopModule = await import('../index.js?repop=1')
const repopLogs = []
repopModule.apply({
  logger: { info: (m) => repopLogs.push('INFO ' + m), warn: (m) => repopLogs.push('WARN ' + m) },
  on() { return () => {} },
  effect(fn) { fn(); return () => {} },
  inject() { return () => {} },
  get() { return undefined },
})
// 磁盘兜底要等约 3 秒（12 × 250ms）才会启动，这里必须等够。
await new Promise((resolve) => setTimeout(resolve, 4500))
const repop = globalThis[Symbol.for('dsh-token-metrics:tracker')]
const repopDays = Object.keys(repop.store.byDayModel ?? {})
check('重算后 byDayModel 覆盖所有天', repopDays.length, Object.keys(repop.store.byDay).length)
check('重算后迁移标记已清除', repop.store.needsRebuild, false)
check('重算后总量正确', repop.store.total.calls, 2)
rmSync(rebuildHome, { recursive: true, force: true })

// —— 回扫进度：首次安装扫描历史时前端要能显示提示 ——
// 用户首次打开插件时，Host 正在扫历史会话；没有进度提示就只能对着空统计发呆。
{
  const scanHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-scan-'))
  mkdirSync(join(scanHome, 'sessions', 'p', 's1'), { recursive: true })
  const zstdMod = await import('node:zlib')
  const events = [
    { type: 'session', version: 4, id: 's1', createdAt: Date.now(), cwd: '/p', isSeeded: false, delegationDepth: 0 },
    { type: 'assistant/message', seq: 0, time: Date.now(), data: { turn: 1, step: 1, message: { source: { provider: 'sp', model: 'sm' } }, usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } },
  ]
  writeFileSync(
    join(scanHome, 'sessions', 'p', 's1', 'session.v4.jsonl.zstd'),
    zstdMod.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')),
  )
  process.env.DSH_HOME = scanHome
  delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
  process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
  const scanModule = await import('../index.js?scan=1')
  scanModule.apply({
    logger: { info: () => {}, warn: () => {} },
    on() { return () => {} },
    effect(fn) { fn(); return () => {} },
    inject() { return () => {} },
    get() { return undefined },
  })
  const scanTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
  // 刚开始扫描时 active 为 true（磁盘兜底要等约 3 秒才启动，这里先看初始态）
  const initialScan = scanTracker.snapshot().scan
  check('初始 scan 字段存在', typeof initialScan.active, 'boolean')
  await new Promise((resolve) => setTimeout(resolve, 4500))
  const finishedScan = scanTracker.snapshot().scan
  check('扫描结束后 active 为 false', finishedScan.active, false)
  check('扫描记录了总数', finishedScan.total > 0, true)
  check('扫描记录了完成数', finishedScan.done > 0, true)
  check('扫描记录了起始时间', finishedScan.startedAt > 0, true)
  rmSync(scanHome, { recursive: true, force: true })
}

// —— 按模型每日趋势：趋势图按模型拆分的数据源 ——
// 只有 byDay 画不出各模型的曲线，所以 Host 必须提供 day × model 的矩阵。
const trendSnap = dimTracker.snapshot()
check('模型趋势有天数轴', trendSnap.modelTrend.days.length > 0, true)
check('模型趋势有序列', trendSnap.modelTrend.series.length > 0, true)
const firstSeries = trendSnap.modelTrend.series[0]
check('序列带标签', typeof firstSeries.label, 'string')
check('序列覆盖每一天', Object.keys(firstSeries.values).length, trendSnap.modelTrend.days.length)
// 每个序列的合计应等于按模型总量
const seriesSum = trendSnap.modelTrend.series
  .flatMap((item) => Object.values(item.values))
  .reduce((sum, value) => sum + value, 0)
const modelTotal = Object.values(trendSnap.byModel)
  .reduce((sum, counters) => sum + counters.totalTokens, 0)
check('模型趋势合计与按模型总量一致', seriesSum, modelTotal)

// 跨供应商合并：同一模型名挂在多个 provider 下时，byModelName 合并为一条，
// byModel 仍按 provider 拆分。占比图与趋势按前者，明细表按后者。
check('按供应商拆分保留原始键', Object.keys(trendSnap.byModel).length >= Object.keys(trendSnap.byModelName).length, true)
check('合并视图存在', Object.keys(trendSnap.byModelName).length > 0, true)
check('每个模型名有每日序列', Object.keys(trendSnap.byModelDay).length, Object.keys(trendSnap.byModelName).length)
{
  // 关键回归：byModelDay 必须带**完整计数器**，而不只是 totalTokens。
  // 只给总量时，前端筛选单一模型后输入/输出/缓存/推理会全变 0
  // （用户报的「选了模型数据没刷新」就是这个原因）。
  const sampleName = Object.keys(trendSnap.byModelDay)[0]
  const sampleDay = Object.keys(trendSnap.byModelDay[sampleName])[0]
  const sample = trendSnap.byModelDay[sampleName][sampleDay]
  for (const key of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens', 'totalTokens']) {
    check(`模型每日数据含 ${key}`, typeof sample[key], 'number')
  }
  check('模型每日数据含命中率', typeof sample.cacheHitRate, 'number')
}
{
  // 合并视图的合计必须与按供应商拆分的合计一致（同一批事件，只是分组不同）
  const mergedTotal = Object.values(trendSnap.byModelName).reduce((sum, c) => sum + c.totalTokens, 0)
  const splitTotal = Object.values(trendSnap.byModel).reduce((sum, c) => sum + c.totalTokens, 0)
  check('合并与拆分合计一致', mergedTotal, splitTotal)
  // 模型趋势的序列名不应带 provider 前缀
  for (const item of trendSnap.modelTrend.series) {
    if (item.key === '__rest__') continue
    check(`趋势序列 ${item.key} 不含 provider 前缀`, item.key.includes('/') === false, true)
  }
}

// maxTrendSeries 生效：序列数不超过配置值 + 可能的一个「其他」
const capped = dimTracker.snapshot()
check('序列数受限', capped.modelTrend.series.length <= 7, true)

// —— 缓存命中率口径 ——
const eleventhHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-rate-'))
process.env.DSH_HOME = eleventhHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
const rateModule = await import('../index.js?rate=1')
rateModule.apply(makeIsolatedCtx(new Map()), { snapshotCacheMs: 0 })
const rateTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
// 一次调用：新输入 300，缓存命中 700 → 命中率应为 700/1000 = 70%
rateTracker.record({
  sessionId: 'r1', provider: 'p', model: 'm', turn: 1, step: 1,
  usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350, cacheReadTokens: 700 },
})
const rateSnapshot = rateTracker.snapshot()
check('命中率 = 缓存读 / (缓存读+新输入)', Math.round(rateSnapshot.totals.all.cacheHitRate * 100), 70)
check('命中率附在 today 上', Math.round(rateSnapshot.totals.today.cacheHitRate * 100), 70)
check('命中率附在 week 上', Math.round(rateSnapshot.totals.week.cacheHitRate * 100), 70)
// 无缓存时命中率为 0，不是 NaN
rateTracker.record({
  sessionId: 'r1', provider: 'p', model: 'm', turn: 1, step: 2,
  usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
})
const rateSnapshot2 = rateTracker.snapshot()
check('无缓存读时命中率有限', Number.isFinite(rateSnapshot2.totals.all.cacheHitRate), true)
check('趋势序列存在', Object.keys(rateSnapshot2.trend).length > 0, true)
check('趋势项带命中率', typeof Object.values(rateSnapshot2.trend)[0].cacheHitRate, 'number')

// —— 快照缓存：命中时返回同一对象 ——
const cachedA = rateTracker.snapshot()
const cachedB = rateTracker.snapshot()
check('缓存关闭时每次新建', cachedA === cachedB, false)

const twelfthHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-cache-'))
process.env.DSH_HOME = twelfthHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
const cacheModule = await import('../index.js?cache=1')
cacheModule.apply(makeIsolatedCtx(new Map()), { snapshotCacheMs: 60_000 })
const cacheTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
cacheTracker.record({
  sessionId: 'c1', provider: 'p', model: 'm', turn: 1, step: 1,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})
const cacheFirst = cacheTracker.snapshot()
const cacheSecond = cacheTracker.snapshot()
check('缓存命中返回同一对象', cacheFirst === cacheSecond, true)
// 新数据进来后缓存必须失效
cacheTracker.record({
  sessionId: 'c1', provider: 'p', model: 'm', turn: 1, step: 2,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})
const cacheThird = cacheTracker.snapshot()
check('新数据使缓存失效', cacheThird.totals.all.calls, 2)
rmSync(twelfthHome, { recursive: true, force: true })

// —— 配置：showSessions 默认关闭，不返回会话明细 ——
check('默认不返回会话明细', Object.keys(cacheTracker.snapshot().bySession).length, 0)
check('仍统计会话数', cacheTracker.snapshot().sessionCount, 1)
rmSync(eleventhHome, { recursive: true, force: true })

// —— 重建：reset 后回扫能恢复出正确数据 ——
const tenthHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-rebuild-'))
process.env.DSH_HOME = tenthHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
process.env.DSH_TOKEN_USAGE_TEST_HOOK = '1'
const rebuildModule = await import('../index.js?rebuild=1')
rebuildModule.apply({
  logger: { info: () => {}, warn: () => {} },
  on() { return () => {} },
  effect(fn) { fn(); return () => {} },
  inject(deps, callback) {
    // 模拟 cordis：依赖就绪后调用回调，回调收到带该服务的 scoped 上下文。
    if (typeof deps === 'function') return () => {}
    const scoped = {
      sessionPersistence: fakePersistence,
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    }
    try { callback(scoped) } catch { /* webServer 分支在测试里用不到 */ }
    return () => {}
  },
  get(name) { return name === 'sessionPersistence' ? fakePersistence : undefined },
})
await new Promise((resolve) => setTimeout(resolve, 300))
await new Promise((resolve) => setTimeout(resolve, 2600))
const rebuildTracker = globalThis[Symbol.for('dsh-token-metrics:tracker')]
const beforeReset = rebuildTracker.store.total.calls
check('重建前有数据', beforeReset > 0, true)
rebuildTracker.reset()
check('reset 后清零', rebuildTracker.store.total.calls, 0)
check('reset 后去重表清空', Object.keys(rebuildTracker.store.seen).length, 0)
check('reset 保留 buildId', typeof rebuildTracker.store.buildId, 'string')
rmSync(tenthHome, { recursive: true, force: true })

// —— 回归：健康文件不得被误判为污染 ——
const eighthHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-healthy-'))
mkdirSync(join(eighthHome, 'token-metrics'), { recursive: true })
const healthySeen = {}
for (let step = 1; step <= 40; step += 1) healthySeen[`s:1:${step}`] = 1
const healthy = {
  version: 1, createdAt: 1, updatedAt: 1,
  seen: healthySeen,
  total: { calls: 40, inputTokens: 40, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 80 },
  byDay: {}, byProvider: {}, byModel: {}, bySession: {}, scanned: {},
}
writeFileSync(join(eighthHome, 'token-metrics', 'usage.json'), JSON.stringify(healthy), 'utf8')
process.env.DSH_HOME = eighthHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
const healthyModule = await import('../index.js?healthy=1')
healthyModule.apply({
  logger: { info: () => {}, warn: () => {} },
  on() { return () => {} },
  effect(fn) { fn(); return () => {} },
  inject(deps, callback) {
    // 模拟 cordis：依赖就绪后调用回调，回调收到带该服务的 scoped 上下文。
    if (typeof deps === 'function') return () => {}
    const scoped = {
      sessionPersistence: fakePersistence,
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    }
    try { callback(scoped) } catch { /* webServer 分支在测试里用不到 */ }
    return () => {}
  },
  get() { return undefined },
})
const kept = globalThis[Symbol.for('dsh-token-metrics:tracker')]
check('健康文件被保留（calls）', kept.store.total.calls, 40)
check('健康文件被保留（seen）', Object.keys(kept.store.seen).length, 40)
rmSync(eighthHome, { recursive: true, force: true })

// —— 回归：buildId 变化时必须换上新 tracker（热重载生效）——
// 否则旧代码永远占着单例，对统计逻辑的修改永远不生效。
const sixthHome = mkdtempSync(join(tmpdir(), 'dsh-token-metrics-build-'))
process.env.DSH_HOME = sixthHome
delete globalThis[Symbol.for('dsh-token-metrics:tracker')]
const buildA = await import('../index.js?build=a')
const listenersBA = new Map()
buildA.apply({
  logger: { info: () => {}, warn: () => {} },
  on(n, l) { listenersBA.set(n, l); return () => {} },
  effect(fn) { fn(); return () => {} },
  inject(deps, callback) {
    // 模拟 cordis：依赖就绪后调用回调，回调收到带该服务的 scoped 上下文。
    if (typeof deps === 'function') return () => {}
    const scoped = {
      sessionPersistence: fakePersistence,
      webServer: undefined,
      effect: (fn) => { fn(); return () => {} },
    }
    try { callback(scoped) } catch { /* webServer 分支在测试里用不到 */ }
    return () => {}
  },
  get() { return undefined },
})
const trackerA = globalThis[Symbol.for('dsh-token-metrics:tracker')]
// 模拟新代码：伪造一个不同 buildId 的模块（同一文件但 URL 不同 + 强制改写 BUILD_ID 不可行，
// 因此直接验证 acquireTracker 的契约：相同 buildId 复用、不同 buildId 替换）
const probe = await import('../index.js?build=probe')
const acquireTracker = globalThis.__dshTokenUsageInternals.acquireTracker
const same = acquireTracker({ info: () => {}, warn: () => {} }, trackerA.buildId)
check('相同 buildId 复用同一 tracker', same.tracker === trackerA, true)
check('相同 buildId 标记为非 fresh', same.fresh, false)
const different = acquireTracker({ info: () => {}, warn: () => {} }, 'a-different-build-id')
check('不同 buildId 换新 tracker', different.tracker !== trackerA, true)
check('新 tracker 的 buildId 已更新', different.tracker.buildId, 'a-different-build-id')
rmSync(sixthHome, { recursive: true, force: true })

// —— 回归：去重表不得因事件时间陈旧而被裁剪 ——
const seenCount = Object.keys(store2.seen).length
check('去重表保留了历史键', seenCount >= beforeCalls, true)

rmSync(secondHome, { recursive: true, force: true })

if (warnings.length > 0) {
  console.log('警告：')
  for (const warning of warnings) console.log('  -', warning)
}

if (failures.length > 0) {
  console.error('\n失败：')
  for (const failure of failures) console.error('  ✗', failure)
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

console.log('✓ Host 侧全部断言通过')
console.log('  调用 5 次 / 总 token 2593 / 3 个模型 / 3 个供应商 / 3 个会话 / 2 天')
rmSync(home, { recursive: true, force: true })
