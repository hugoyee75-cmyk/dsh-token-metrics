/**
 * 价格模块的自检：归一化、匹配、渠道可信度、成本计算、缓存与降级。
 *
 * 重点覆盖「同一模型有十几个渠道价，必须挑官方那个」——这是最容易错、
 * 也最影响结果可信度的地方。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PriceBook, resolvePrice, costOf, extractChatPrices, normalizeModelName,
  channelTrust, BUILTIN_PRICES, DEFAULT_USD_CNY, isOffPeak,
} from '../src/pricing.js'

const failures = []

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function checkTrue(label, condition, detail = '') {
  if (condition !== true) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

//#region 归一化

check('去掉渠道前缀', normalizeModelName('z-ai/glm-5.3-flash'), 'glm-5-3-flash')
check('统一大小写与分隔符', normalizeModelName('DeepSeek_V4.1_Flash'), 'deepseek-v4-1-flash')
check('空名安全', normalizeModelName(''), '')
check('非字符串安全', normalizeModelName(null), '')

// —— 峰谷定价 ——
// DeepSeek 分时段计价，谷时是峰时的一半。LiteLLM 用 off_peak_pricing 表达，
// 并带 windows 时段定义。不区分会让谷时调用被高估最多一倍。
{
  const table = extractChatPrices({
    'ds': {
      mode: 'chat',
      input_cost_per_token: 3e-7,
      output_cost_per_token: 1.2e-6,
      cache_read_input_token_cost: 6e-9,
      off_peak_pricing: {
        input_cost_per_token: 1.5e-7,
        output_cost_per_token: 6e-7,
        cache_read_input_token_cost: 3e-9,
        windows: [
          { hours_utc: ['00:00-01:00', '04:00-06:00', '10:00-00:00'], weekdays: [1, 2, 3, 4, 5] },
          { hours_utc: '00:00-00:00', weekdays: [6, 7] },
        ],
      },
    },
  })
  const price = table.ds
  check('谷时价被解析', price.offPeak?.input, 1.5e-7)
  check('谷时窗口被保留', price.offPeak?.windows?.length, 2)

  // 工作日 01:00-04:00 是峰时，04:00-06:00 是谷时
  check('工作日 02:00 非谷时', isOffPeak(new Date('2026-10-19T02:00:00Z'), price.offPeak.windows), false)
  check('工作日 04:30 是谷时', isOffPeak(new Date('2026-10-19T04:30:00Z'), price.offPeak.windows), true)
  // 周末全天谷时
  check('周六全天谷时', isOffPeak(new Date('2026-10-24T02:00:00Z'), price.offPeak.windows), true)

  // 跨零点区间
  const wrap = [{ hours_utc: ['22:00-02:00'], weekdays: [1, 2, 3, 4, 5, 6, 7] }]
  check('跨零点命中 23:00', isOffPeak(new Date('2026-10-19T23:00:00Z'), wrap), true)
  check('跨零点不命中 03:00', isOffPeak(new Date('2026-10-19T03:00:00Z'), wrap), false)

  // 计价：谷时恰为峰时的一半
  const counters = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0 }
  check('峰时计价', Number(costOf(counters, price, 1, { at: new Date('2026-10-19T02:00:00Z') }).toFixed(6)), 1.5)
  check('谷时计价为一半', Number(costOf(counters, price, 1, { at: new Date('2026-10-19T04:30:00Z') }).toFixed(6)), 0.75)
  check('强制谷时', Number(costOf(counters, price, 1, { offPeak: true }).toFixed(6)), 0.75)
  // 没给时刻时按峰时——宁可偏高也不要漏算
  check('无时刻按峰时', Number(costOf(counters, price, 1).toFixed(6)), 1.5)
  // 普通模型不受影响
  const plain = extractChatPrices({ 'p': { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } })
  check('普通模型无谷时价', plain.p.offPeak, undefined)
  checkTrue('无谷时价时按原价算', Number(costOf(counters, plain.p, 1).toFixed(6)) === 3)
}

//#endregion

//#region 渠道可信度

checkTrue('官方直营高于转售', channelTrust('deepseek/x') > channelTrust('coralbricks/x'))
checkTrue('无前缀视为官方口径', channelTrust('gpt-4o') >= 60)
check('未知渠道给低分', channelTrust('some-random/xxx'), 20)

//#endregion

//#region 价目表提取

{
  const raw = {
    'gpt-4o': {
      mode: 'chat', input_cost_per_token: 2.5e-6, output_cost_per_token: 10e-6,
      cache_read_input_token_cost: 1.25e-6, cache_creation_input_token_cost: 3e-6,
    },
    // embedding 应当被排除
    'text-embedding-3-small': { mode: 'embedding', input_cost_per_token: 2e-8 },
    // 缺 output 价，无法用于成本核算
    'broken-model': { mode: 'chat', input_cost_per_token: 1e-6 },
  }
  const table = extractChatPrices(raw)
  check('只保留 chat 模型', Object.keys(table), ['gpt-4o'])
  check('读取输入价', table['gpt-4o'].input, 2.5e-6)
  check('读取缓存读价', table['gpt-4o'].cacheRead, 1.25e-6)
  check('读取缓存写价', table['gpt-4o'].cacheWrite, 3e-6)

  // 缓存价缺失时回落到输入价，而不是当作免费
  const fallback = extractChatPrices({ m: { mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 4e-6 } })
  check('缓存读缺失回落到输入价', fallback.m.cacheRead, 2e-6)
  check('缓存写缺失回落到输入价', fallback.m.cacheWrite, 2e-6)
}

//#endregion

//#region 匹配：必须挑官方渠道，不能随机落到转售商

{
  // 这是真实数据里出现过的情况：同一模型价格差几十倍
  const table = {
    'coralbricks/deepseek-v4.1-flash': { input: 0.01e-6, output: 1.2e-6, cacheRead: 0.01e-6, cacheWrite: 0 },
    'azure_ai/deepseek-v4.1-flash': { input: 0.3e-6, output: 1.2e-6, cacheRead: 0.3e-6, cacheWrite: 0 },
    'deepseek/deepseek-v4.1-flash': { input: 0.28e-6, output: 1.1e-6, cacheRead: 0.28e-6, cacheWrite: 0 },
  }
  const picked = resolvePrice('deepseek-v4.1-flash', table)
  check('优先选官方渠道', picked.matchedName, 'deepseek/deepseek-v4.1-flash')
  check('不选最便宜的转售商', picked.input === 0.01e-6, false)

  // 手工补价优先级最高
  const manual = resolvePrice('deepseek-v4.1-flash', table, {
    'deepseek-v4.1-flash': { input: 1e-6, output: 2e-6, cacheRead: 1e-6, cacheWrite: 1e-6 },
  })
  check('手工补价优先', manual.source, 'manual')
  check('手工补价生效', manual.input, 1e-6)

  // 完全匹配不到时返回 undefined，调用方据此显示「未定价」
  check('无法匹配返回 undefined', resolvePrice('完全自定义模型名', table), undefined)

  // 前缀匹配：不能把 qwen3.8-flash 配到 qwen 上
  const qwenTable = {
    qwen: { input: 1e-6, output: 2e-6, cacheRead: 1e-6, cacheWrite: 0 },
    'qwen3.8-flash': { input: 0.15e-6, output: 0.47e-6, cacheRead: 0.15e-6, cacheWrite: 0 },
  }
  check('前缀匹配取最贴近的', resolvePrice('qwen3.8-flash', qwenTable).matchedName, 'qwen3.8-flash')
}

//#endregion

//#region 成本计算

{
  const price = { input: 1e-6, output: 2e-6, cacheRead: 0.1e-6, cacheWrite: 1e-6 }
  const counters = {
    inputTokens: 1_000_000, outputTokens: 500_000,
    cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000, reasoningTokens: 0,
  }
  // 1M*1e-6 + 0.5M*2e-6 + 2M*0.1e-6 + 0.1M*1e-6 = 1 + 1 + 0.2 + 0.1 = 2.3
  check('基本成本计算', Number(costOf(counters, price).toFixed(6)), 2.3)

  // 倍率：中转站加价
  check('倍率生效', Number(costOf(counters, price, 2).toFixed(6)), 4.6)
  // 非法倍率退回 1，不能让成本变 0 或 NaN
  check('倍率为 0 时退回 1', Number(costOf(counters, price, 0).toFixed(6)), 2.3)
  check('倍率为负数时退回 1', Number(costOf(counters, price, -3).toFixed(6)), 2.3)
  check('无价格时成本为 0', costOf(counters, undefined), 0)

  // 推理 token 按输出价计
  const withReasoning = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 1_000_000 }
  check('推理 token 按输出价', Number(costOf(withReasoning, price).toFixed(6)), 2)
}

//#endregion

//#region PriceBook：缓存、降级、持久化

{
  const dir = mkdtempSync(join(tmpdir(), 'dtu-price-'))
  const book = new PriceBook({ dataDir: dir, now: () => 1000 }).load()
  // 首次加载且无缓存 -> 内置兜底价目表，保证离线也能算
  checkTrue('无缓存时用内置价目表兜底', Object.keys(book.table).length > 0)
  check('内置价目表含 deepseek', book.table['deepseek-chat'] !== undefined, true)
  check('默认汇率', book.usdCny, DEFAULT_USD_CNY)

  // 手工补价要能持久化
  book.setOverride('qfmodel', { input: 0.5e-6, output: 1e-6 })
  book.setMultiplier('qoder', 1.5)
  const reloaded = new PriceBook({ dataDir: dir }).load()
  check('手工补价已持久化', reloaded.overrides.qfmodel.input, 0.5e-6)
  check('倍率已持久化', reloaded.multipliers.qoder, 1.5)
  check('倍率读取', reloaded.multiplierOf('qoder'), 1.5)
  check('未配置的倍率为 1', reloaded.multiplierOf('nope'), 1)

  // 刷新失败必须保留旧表，不能把成本清空
  const failing = new PriceBook({
    dataDir: dir,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  }).load()
  const before = Object.keys(failing.table).length
  await failing.refresh()
  check('拉取失败保留旧表', Object.keys(failing.table).length, before)
  checkTrue('拉取失败记录错误', failing.error !== '')

  // 刷新成功则替换价目表
  const ok = new PriceBook({
    dataDir: dir,
    fetchImpl: async () => ({
      ok: true, status: 200,
      async json() { return { 'x-model': { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } } },
    }),
  }).load()
  await ok.refresh()
  check('拉取成功后替换', Object.keys(ok.table), ['x-model'])
  checkTrue('记录更新时间', ok.updatedAt > 0)

  // 汇率：成功更新 / 失败保留
  const fxOk = new PriceBook({
    dataDir: dir,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { rates: { CNY: 7.35 } } } }),
  }).load()
  await fxOk.refreshFx()
  check('汇率更新', fxOk.usdCny, 7.35)

  // 用独立目录，避免读到上一个用例写下的 7.35 缓存
  const fxDir = mkdtempSync(join(tmpdir(), 'dtu-fx-'))
  const fxBad = new PriceBook({
    dataDir: fxDir,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { rates: {} } } }),
  }).load()
  await fxBad.refreshFx()
  check('汇率无效时保留默认', fxBad.usdCny, DEFAULT_USD_CNY)
  checkTrue('汇率失败记录错误', fxBad.fxError !== '')

  // 有缓存时必须用缓存，而不是丢掉历史汇率
  const fxCached = new PriceBook({ dataDir: dir }).load()
  check('重启后读回缓存的汇率', fxCached.usdCny, 7.35)
  rmSync(fxDir, { recursive: true, force: true })

  // 状态汇总供页面展示
  const status = ok.status()
  checkTrue('状态含模型数', status.modelCount > 0)
  checkTrue('状态含汇率', typeof status.usdCny === 'number')

  rmSync(dir, { recursive: true, force: true })
}

//#endregion

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 价格模块全部断言通过')
console.log(`  归一化 / 渠道可信度 / 提取 / 匹配 / 成本 / 缓存与降级`)
