/**
 * 订阅额度账本自检：价目、额度系数、窗口聚合、采样与档位。
 *
 * 全部用本地合成数据，不发任何网络请求（探针用注入的假 fetch）。
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  windowKeyOf, isPeakTime, rateAt, listCostOf, totalTokens,
  factorFor, capsFor, QuotaLedger, probeFactors, WINDOWS, BUCKET_MS, modelCapacity,
} from '../src/quota.js'

const failures = []

function check(label, actual, expected) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) failures.push(`${label}：期望 ${right}，实际 ${left}`)
}

function checkTrue(label, condition, detail = '') {
  if (condition !== true) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

function close(label, actual, expected, tolerance = 1e-9) {
  if (!(Math.abs(Number(actual) - Number(expected)) <= tolerance)) {
    failures.push(`${label}：期望 ${expected}（±${tolerance}），实际 ${actual}`)
  }
}

//#region 窗口名与峰谷

check('5-hour -> rolling', windowKeyOf('5-hour'), 'rolling')
check('Weekly -> weekly', windowKeyOf('Weekly'), 'weekly')
check('Monthly -> monthly', windowKeyOf('Monthly'), 'monthly')
check('未知窗口', windowKeyOf('hourly'), undefined)

// 北京时间 09:15（UTC 01:15，工作日）落在 06:00-10:00 峰时。
checkTrue('09:15 北京是峰时', isPeakTime(Date.parse('2026-11-05T09:15:00+08:00')))
// 14:00 北京 = 06:00 UTC，正好进入第二个峰时窗口。
checkTrue('14:00 北京是峰时', isPeakTime(Date.parse('2026-11-05T14:00:00+08:00')))
// 12:00 北京 = 04:00 UTC，两个峰时窗口之间。
checkTrue('12:00 北京是谷时', isPeakTime(Date.parse('2026-11-05T12:00:00+08:00')) === false)
// 周末全天谷时。
checkTrue('周六是谷时', isPeakTime(Date.parse('2026-11-07T09:15:00+08:00')) === false)

check('峰时单价', rateAt('deepseek-v4.1-flash', Date.parse('2026-11-05T09:15:00+08:00')).input, 0.30e-6)
check('谷时单价', rateAt('deepseek-v4.1-flash', Date.parse('2026-11-05T12:00:00+08:00')).input, 0.15e-6)

const counters = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 100_000_000 }
close('峰时成本', listCostOf('deepseek-v4.1-flash', counters, Date.parse('2026-11-05T09:15:00+08:00')), 2.1)
close('谷时成本', listCostOf('deepseek-v4.1-flash', counters, Date.parse('2026-11-05T12:00:00+08:00')), 1.05)
check('未知模型成本', listCostOf('no-such-model', counters, Date.now()), 0)

//#endregion

//#region 额度系数与档位

close('Go DeepSeek 系数', factorFor('deepseek-v4.1-flash', 'go'), 0.6, 1e-12)
close('Go GLM 系数', factorFor('glm-5.3-flash', 'go'), 1, 1e-12)
close('Go Grok 系数', factorFor('grok-4.7', 'go'), 4, 1e-12)

// Plus 只有 DeepSeek 一个锚点：1.2 × 200 = 240 是名义常数。
const plusCaps = capsFor('plus', { 'deepseek-v4.1-flash': 1.2, 'glm-5.3-flash': 2 })
check('Plus 反推 DeepSeek 月额度', plusCaps['deepseek-v4.1-flash'], 200)
check('Plus 反推 GLM 月额度', plusCaps['glm-5.3-flash'], 120)
check('Plus 无系数时为空', capsFor('plus', {}), {})
close('Plus 系数', factorFor('glm-5.3-flash', 'plus', { 'deepseek-v4.1-flash': 1.2, 'glm-5.3-flash': 2 }), 2, 1e-12)

//#region 单模型额度换算

const grokCapacity = modelCapacity({
  model: 'grok-4.7',
  composition: {
    calls: 13,
    tokens: 969746,
    inputTokens: 128214,
    outputTokens: 47676,
    cacheReadTokens: 793856,
    cacheWriteTokens: 0,
  },
  planId: 'go',
})
const grok5h = grokCapacity.windows.find((item) => item.key === 'rolling')
close('Grok 5h 预算', grok5h.budget, 3, 1e-9)
close('Grok 5h 纯输入 token', grok5h.tokens.input, 1_500_000, 1)
close('Grok 5h 纯输出 token', grok5h.tokens.output, 500_000, 1)
close('Grok 5h 纯缓存 token', grok5h.tokens.cacheRead, 6_000_000, 1)
// 构成：13.2% 输入 + 4.9% 输出 + 81.9% 缓存读，加权 $0.9675/M。
close('Grok 5h 按实际结构 token', grok5h.tokens.mixed, 3_100_000, 20_000)
check('Grok 月额度', grokCapacity.cap, 15)

const deepseekCapacity = modelCapacity({ model: 'deepseek-v4.1-flash', planId: 'go' })
const ds5h = deepseekCapacity.windows.find((item) => item.key === 'rolling')
close('DeepSeek 5h 预算', ds5h.budget, 20, 1e-9)
close('DeepSeek 5h 纯缓存 token（谷时）', ds5h.tokens.cacheRead, 6_666_666_667, 10_000)
check('DeepSeek 标记峰谷', deepseekCapacity.peak, true)
check('没有构成时 mixed 为空', ds5h.tokens.mixed, undefined)

// 免费模型没有额度上限，不参与换算。
check('免费模型无额度', modelCapacity({ model: 'beam-free' }), undefined)

//#endregion

//#region 账本聚合

const dir = mkdtempSync(join(tmpdir(), 'tm-quota-'))
const path = join(dir, 'quota.json')
const now = Date.parse('2026-11-05T14:00:00+08:00')
let ledger = new QuotaLedger({ path, now: () => now })

const t1 = Date.parse('2026-11-05T09:30:00+08:00') // 峰时
ledger.record({
  time: t1,
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000 },
})
ledger.record({
  time: t1,
  provider: 'opencode-go',
  model: 'glm-5.3-flash',
  usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 2000 },
})
// 不在额度范围里的 provider 必须被忽略。
ledger.record({
  time: t1,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  usage: { inputTokens: 999 },
})

const bucketStart = Math.floor(t1 / BUCKET_MS) * BUCKET_MS
const models = ledger.usageBetween('opencode-go', bucketStart, bucketStart + BUCKET_MS)
check('只统计额度 provider', Object.keys(models).sort(), ['deepseek-v4.1-flash', 'glm-5.3-flash'])
check('深寻 token 合计', totalTokens(models['deepseek-v4.1-flash']), 1120)
check('GLM token 合计', totalTokens(models['glm-5.3-flash']), 2240)

// 窗口起点落在桶中间：按重叠比例摊分。桶长 10 分钟，取后一半。
const half = ledger.usageBetween('opencode-go', bucketStart + 5 * 60 * 1000, bucketStart + 10 * 60 * 1000)
close('摊分后的深寻 token', totalTokens(half['deepseek-v4.1-flash'] ?? {}), 560, 1e-6)

// 窗口之外没有任何用量。
const outside = ledger.usageBetween('opencode-go', t1 + 20 * 60 * 1000, t1 + 30 * 60 * 1000)
check('窗口外为空', Object.keys(outside), [])

//#endregion

//#region 归因

const quotaEntries = [
  { label: '5-hour', used: 11, limit: 100, resetsAt: now + 23 * 60 * 1000, unit: '%' },
  { label: 'Weekly', used: 40, limit: 100, resetsAt: now + 3 * 86400 * 1000, unit: '%' },
  { label: 'Monthly', used: 46, limit: 100, resetsAt: now + 20 * 86400 * 1000, unit: '%' },
]
const summary = ledger.summary({
  site: { id: 'opencode-go', label: 'OpenCode Go', provider: 'opencode-go' },
  quotas: quotaEntries,
})
check('三个窗口', summary.windows.map((item) => item.key), ['rolling', 'weekly', 'monthly'])
check('档位默认 Go', summary.plan, 'go')

// 5h 窗口起点 = now - 5h（resetsAt - 5h = now）。
const rolling = summary.windows.find((item) => item.key === 'rolling')
check('5h 百分比', rolling.percent, 11)
check('5h 起点', rolling.startAt, now + 23 * 60 * 1000 - 5 * 3600 * 1000)
check('5h 折算月额度', Math.round(rolling.monthlyPoints * 10) / 10, 2.2)

// 5h 窗口包含 t1（09:15）的调用；两个模型按额度份额分摊 11 个点。
const deepseek = rolling.models.find((row) => row.model === 'deepseek-v4.1-flash')
const glm = rolling.models.find((row) => row.model === 'glm-5.3-flash')
checkTrue('5h 有两个模型', deepseek !== undefined && glm !== undefined)
close('份额之和', deepseek.share + glm.share, 1, 1e-9)
close('折算点之和', deepseek.points + glm.points, 11, 1e-6)
close('深寻额度 = list × 0.6', deepseek.allowance, deepseek.listCost * 0.6, 1e-12)
check('深寻占月额度', Math.round(deepseek.monthlyUsedPct * 1e6) / 1e6, Math.round((deepseek.listCost / 100) * 100 * 1e6) / 1e6)
checkTrue('1% token 当量', rolling.perPct.tokens > 0)
checkTrue('剩余 token 当量', rolling.remaining.tokens > 0)

// 无百分比时仍然给出 token/额度，只是不折算百分点。
const noPercent = ledger.summary({
  site: { id: 'opencode-go', label: 'OpenCode Go', provider: 'opencode-go' },
  quotas: [],
})
checkTrue('缺百分比时 percent 为空', noPercent.windows[0].percent === undefined)
check('缺百分比时不折算点', noPercent.windows[0].models[0].points, undefined)

//#endregion

//#region 采样与容量

const sampleLedger = new QuotaLedger({ path: join(dir, 'quota2.json'), now: () => now })
// 桶放在 1 小时前；窗口起点是 5 小时前，账本覆盖得到。
sampleLedger.record({
  time: now - 60 * 60 * 1000,
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
})
sampleLedger.recordSample(
  { id: 'opencode-go', provider: 'opencode-go' },
  { ok: true, kind: 'quota', quotas: [{ label: '5-hour', used: 5, limit: 100, resetsAt: now + 4 * 3600 * 1000 }] },
  now,
)
const capacity = sampleLedger.state.capacity.rolling
checkTrue('容量被记录', capacity !== undefined)
// 桶在 13:00（谷时）：1M 输入 × 0.15e-6 = $0.15，× 0.6 = $0.09；5% → 每 1% ≈ $0.018。
close('每 1% 的额度', capacity.perPct, 0.018, 1e-6)

// 采样去重：5 分钟内同窗口同 resetsAt 不再追加。
const before = sampleLedger.state.samples.length
sampleLedger.recordSample(
  { id: 'opencode-go', provider: 'opencode-go' },
  { ok: true, kind: 'quota', quotas: [{ label: '5-hour', used: 5, limit: 100, resetsAt: now + 4 * 3600 * 1000 }] },
  now + 60 * 1000,
)
check('5 分钟内不重复采样', sampleLedger.state.samples.length, before)

//#endregion

//#region 档位切换与探针

ledger.setPlan('plus')
check('切换档位', ledger.plan(), 'plus')
check('未知档位被拒绝', (() => {
  try {
    ledger.setPlan('enterprise')
    return 'accepted'
  } catch {
    return 'rejected'
  }
})(), 'rejected')

const fakeFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    usage: {
      opencode: {
        allowance: 0.00000567,
        list_cost: 0.00000945,
        tokens: { input: 31, output: 8, reasoning: 8, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
      },
    },
  }),
})
const probed = await probeFactors({
  baseUrl: 'https://opencode.ai/inference/go/v1',
  apiKey: 'test-key',
  models: ['deepseek-v4.1-flash', 'no-such-model'],
  fetchImpl: fakeFetch,
  now: Date.parse('2026-11-05T12:00:00+08:00'),
})
check('探针成功', probed.ok, true)
check('探针只返回已知模型', Object.keys(probed.factors), ['deepseek-v4.1-flash'])
close('探针系数', probed.factors['deepseek-v4.1-flash'], 0.6, 1e-3)
check('未知模型有失败项', probed.details.filter((item) => item.ok !== true).length, 1)

// 落盘 + 重新加载：档位、系数、桶都在。
ledger.setFactors(probed.factors)
ledger.flush()
checkTrue('数据文件已写入', existsSync(path))
const reloaded = new QuotaLedger({ path, now: () => now })
check('重载后档位', reloaded.plan(), 'plus')
close('重载后系数', reloaded.state.factors['deepseek-v4.1-flash'], 0.6, 1e-3)
checkTrue('重载后桶仍在', Object.keys(reloaded.state.buckets).length > 0)
check('重载后 provider 集合', [...reloaded.providers], ['opencode-go'])
check('窗口定义稳定', WINDOWS.map((item) => item.key), ['rolling', 'weekly', 'monthly'])

// 坏文件不能阻塞启动。
const brokenPath = join(dir, 'broken.json')
const { writeFileSync } = await import('node:fs')
writeFileSync(brokenPath, '{not json', 'utf8')
const recovered = new QuotaLedger({ path: brokenPath, now: () => now, log: () => {} })
check('坏文件回退为空账本', Object.keys(recovered.state.buckets), [])

rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`quota-test 失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('quota-test 通过')
