/**
 * 余额模块自检：端点探测、响应解析、配置持久化、密钥不落盘。
 *
 * 这里全部用注入的假 fetch——真实中转站需要密钥且域名各异，
 * 不适合放进自动化测试。
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeBalance, normalizeBaseUrl, parseNewApiBalance, parseOneApiSubscription,
  parseOneApiUsage, parseSub2ApiUsage, BalanceBook,
} from '../src/balance.js'

const failures = []

function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function checkTrue(label, condition, detail = '') {
  if (condition !== true) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

//#region baseURL 归一化

check('去掉末尾斜杠', normalizeBaseUrl('https://x.com/'), 'https://x.com')
check('去掉 /v1', normalizeBaseUrl('https://x.com/v1'), 'https://x.com')
check('去掉 /v1 与斜杠', normalizeBaseUrl('https://x.com/v1/'), 'https://x.com')
check('保留子路径', normalizeBaseUrl('https://x.com/api'), 'https://x.com/api')
check('空值安全', normalizeBaseUrl(''), '')
check('非字符串安全', normalizeBaseUrl(null), '')

//#endregion

//#region 响应解析

{
  // new-api：quota 以 500000 为 1 美元
  const parsed = parseNewApiBalance({ data: { quota: 2_500_000, used_quota: 500_000, username: 'u1' } })
  check('new-api 余额换算', parsed.usd, 5)
  check('new-api 已用换算', parsed.usedUsd, 1)
  check('new-api 用户名', parsed.username, 'u1')

  // 顶层字段也接受（有些版本不打 data 包装）
  check('兼容无 data 包装', parseNewApiBalance({ quota: 500_000 }).usd, 1)
  // 没有 quota 时返回 undefined，让调用方继续试下一个端点
  check('缺字段返回 undefined', parseNewApiBalance({ foo: 1 }), undefined)
  check('null 安全', parseNewApiBalance(null), undefined)

  // Sub2API 系（实测自 sub.100xlabs.space 的 /v1/usage）
  const sub2 = parseSub2ApiUsage({
    balance: 60.0941164, isValid: true, mode: 'unrestricted',
    daily_usage: [{ cost: 0.5 }, { cost: 0.25 }],
  })
  check('sub2api 余额', sub2.usd, 60.0941164)
  check('sub2api 已用累加', sub2.usedUsd, 0.75)
  check('sub2api 有效标记', sub2.isValid, true)
  // 兼容 remaining / quota.remaining 变体
  check('sub2api 兼容 remaining', parseSub2ApiUsage({ remaining: 5 }).usd, 5)
  check('sub2api 兼容 quota.remaining', parseSub2ApiUsage({ quota: { remaining: 7 } }).usd, 7)
  check('sub2api 无余额字段返回 undefined', parseSub2ApiUsage({ foo: 1 }), undefined)

  check('one-api 额度解析', parseOneApiSubscription({ hard_limit_usd: 20 }).limitUsd, 20)
  // total_usage 单位是美分
  check('one-api 用量按美分', parseOneApiUsage({ total_usage: 1500 }).usedUsd, 15)
}

//#endregion

//#region 探测：多种响应形态

{
  const makeFetch = (routes) => async (url) => {
    const target = String(url)
    for (const [fragment, handler] of Object.entries(routes)) {
      if (target.includes(fragment)) return handler()
    }
    return { ok: false, status: 404, async json() { return {} } }
  }

  // sub2api 系：/v1/usage 优先命中
  const sub2Fetch = makeFetch({
    '/v1/usage': () => ({
      ok: true, status: 200,
      async json() { return { balance: 12.5, isValid: true, daily_usage: [{ cost: 1 }] } },
    }),
  })
  const r0 = await probeBalance({ baseUrl: 'https://s2.test', apiKey: 'sk-x', fetchImpl: sub2Fetch })
  check('sub2api 探测成功', r0.ok, true)
  check('sub2api 识别类型', r0.kind, 'sub2api')
  check('sub2api 余额', r0.usd, 12.5)

  // new-api 成功：第一个端点就命中
  const newApi = makeFetch({
    '/api/user/self': () => ({
      ok: true, status: 200,
      async json() { return { data: { quota: 1_000_000, used_quota: 200_000, username: 'me' } } },
    }),
  })
  const r1 = await probeBalance({ baseUrl: 'https://relay.test', apiKey: 'sk-x', fetchImpl: newApi })
  check('new-api 探测成功', r1.ok, true)
  check('new-api 识别类型', r1.kind, 'new-api')
  check('new-api 余额', r1.usd, 2)
  check('new-api 上限=余额+已用', r1.limitUsd, 2.4)

  // new-api 失败 -> 回退到 one-api
  const fallback = makeFetch({
    '/api/user/self': () => ({ ok: false, status: 404, async json() { return {} } }),
    '/v1/dashboard/billing/subscription': () => ({
      ok: true, status: 200, async json() { return { hard_limit_usd: 30 } },
    }),
    '/dashboard/billing/usage': () => ({
      ok: true, status: 200, async json() { return { total_usage: 1000 } },
    }),
  })
  const r2 = await probeBalance({ baseUrl: 'https://relay.test', apiKey: 'sk-x', fetchImpl: fallback })
  check('回退到 one-api', r2.ok, true)
  check('one-api 识别类型', r2.kind, 'one-api')
  check('one-api 用量', r2.usedUsd, 10)
  check('one-api 剩余=额度-用量', r2.usd, 20)

  // 全部失败：返回错误而不是抛异常
  const allFail = async () => ({ ok: false, status: 500, async json() { return {} } })
  const r3 = await probeBalance({ baseUrl: 'https://relay.test', apiKey: 'sk-x', fetchImpl: allFail })
  check('全部失败返回 ok:false', r3.ok, false)
  checkTrue('失败带错误信息', typeof r3.error === 'string' && r3.error !== '')

  // 网络异常也不能抛出去
  const throwing = async () => { throw new Error('ECONNREFUSED') }
  const r4 = await probeBalance({ baseUrl: 'https://relay.test', apiKey: 'sk-x', fetchImpl: throwing })
  check('网络异常被捕获', r4.ok, false)

  // 上游返回非 JSON 时不崩
  const notJson = async () => ({ ok: true, status: 200, async json() { throw new Error('bad json') } })
  const r5 = await probeBalance({ baseUrl: 'https://relay.test', apiKey: 'sk-x', fetchImpl: notJson })
  check('非 JSON 响应被处理', r5.ok, false)

  // 指定 balanceKind 时只试对应端点，不在错误端点上白等
  {
    const tried = []
    const spy = async (url) => {
      tried.push(String(url))
      return { ok: false, status: 404, async json() { return {} } }
    }
    await probeBalance({ baseUrl: 'https://r.test', apiKey: 'k', fetchImpl: spy, balanceKind: 'sub2api' })
    check('只请求 sub2api 端点', tried.length, 1)
    checkTrue('请求的是 /v1/usage', tried[0].endsWith('/v1/usage'), tried[0])

    tried.length = 0
    await probeBalance({ baseUrl: 'https://r.test', apiKey: 'k', fetchImpl: spy, balanceKind: 'newapi' })
    check('只请求 new-api 端点', tried.length, 1)
    checkTrue('请求的是 /api/user/self', tried[0].endsWith('/api/user/self'), tried[0])
  }

  // 缺参数时直接拒绝，不发请求
  let called = false
  const spy = async () => { called = true; return { ok: false } }
  const r6 = await probeBalance({ baseUrl: '', apiKey: 'sk', fetchImpl: spy })
  check('缺地址时不发请求', called, false)
  check('缺地址返回错误', r6.ok, false)
}

//#endregion

//#region BalanceBook：持久化与密钥安全

{
  const dir = mkdtempSync(join(tmpdir(), 'dtu-bal-'))
  const path = join(dir, 'balance.json')
  const book = new BalanceBook({ dataDir: dir, now: () => 5000 })

  // 回归：新增站点时 upsertSite 必须返回新站点（早先返回 undefined，
  // 导致同步流程误判为「缺少 id」）
  const created = book.upsertSite({
    id: 'relay-a', label: '中转 A', baseUrl: 'https://a.test/v1',
    keyRef: 'dsh-token-metrics/relay-a',
  })
  check('新增返回站点对象', created?.id, 'relay-a')
  check('新增返回含 models 字段', Array.isArray(created?.models), true)
  book.upsertSite({ id: 'relay-b', label: '中转 B', baseUrl: 'https://b.test' })
  check('站点数量', book.sites.length, 2)
  check('baseUrl 已归一化', book.sites[0].baseUrl, 'https://a.test')

  book.recordResult('relay-a', { ok: true, usd: 12.5, useUsd: 0, usedUsd: 1.5, limitUsd: 14, kind: 'new-api', username: 'u' })
  check('记录余额', book.sites[0].lastBalance.usd, 12.5)
  check('记录时间', book.sites[0].lastCheckedAt, 5000)

  book.recordResult('relay-b', { ok: false, error: 'HTTP 401' })
  check('记录失败原因', book.sites[1].error, 'HTTP 401')

  book.saveTo(path)

  // 关键：磁盘上绝不能出现密钥
  const raw = readFileSync(path, 'utf8')
  checkTrue('磁盘不含密钥字段', !/"(apiKey|token|secret|password)"/i.test(raw), raw.slice(0, 200))

  const reloaded = new BalanceBook({ dataDir: dir }).loadFrom(path)
  check('重启后站点仍在', reloaded.sites.length, 2)
  check('重启后余额仍在', reloaded.sites[0].lastBalance.usd, 12.5)
  check('keyRef 保留', reloaded.sites[0].keyRef, 'dsh-token-metrics/relay-a')

  // 试图塞密钥进来必须被过滤掉
  reloaded.upsertSite({ id: 'evil', apiKey: 'sk-should-not-persist', label: 'x' })
  const evil = reloaded.sites.find((s) => s.id === 'evil')
  check('apiKey 未写入', evil.apiKey, undefined)
  reloaded.saveTo(path)
  checkTrue('磁盘仍不含 sk- 前缀的密钥', !readFileSync(path, 'utf8').includes('sk-should-not-persist'))

  // 回归：models 与 keyEnv 必须在白名单里存活
  // 早先 sanitizeSite 漏了它们，导致模型列表被剥掉、同步到 DSH 必然失败。
  reloaded.removeSite('evil')
  reloaded.upsertSite({
    id: 'with-models',
    label: '带模型',
    baseUrl: 'https://m.test/v1',
    keyEnv: 'MY_KEY',
    models: [
      { id: 'm1', name: 'M1', contextWindow: 131072, maxOutput: 8192, junk: 'drop-me' },
      { id: 'm2' },
      { notId: 'ignored' },
    ],
  })
  const withModels = reloaded.sites.find((s) => s.id === 'with-models')
  check('模型列表被保留', withModels.models.length, 2)
  check('模型 id 保留', withModels.models[0].id, 'm1')
  check('模型名称保留', withModels.models[0].name, 'M1')
  check('上下文窗口保留', withModels.models[0].contextWindow, 131072)
  check('最大输出保留', withModels.models[0].maxOutput, 8192)
  check('多余字段被丢弃', withModels.models[0].junk, undefined)
  check('keyEnv 被保留', withModels.keyEnv, 'MY_KEY')

  // 重启后仍在（持久化不能丢）
  reloaded.saveTo(path)
  const afterSave = new BalanceBook({ dataDir: dir }).loadFrom(path)
  const roundTrip = afterSave.sites.find((s) => s.id === 'with-models')
  check('模型列表可持久化', roundTrip.models.length, 2)
  check('keyEnv 可持久化', roundTrip.keyEnv, 'MY_KEY')

  // 删除（此时有三个：relay-a、relay-b、with-models）
  check('删除存在站点', reloaded.removeSite('with-models'), true)
  check('删除不存在的返回 false', reloaded.removeSite('nope'), false)
  check('删除后数量', reloaded.sites.length, 2)

  // 状态视图不含 keyRef 之外的可疑字段
  const status = reloaded.status()
  check('状态含站点', status.sites.length, 2)
  check('状态不含 keyRef 值以外的密钥', JSON.stringify(status).includes('sk-'), false)

  rmSync(dir, { recursive: true, force: true })
}

//#endregion

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 余额模块全部断言通过')
console.log('  归一化 / 解析 / 探测回退 / 持久化 / 密钥不落盘')
