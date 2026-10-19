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
  parseOneApiUsage, BalanceBook,
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

  book.upsertSite({ id: 'relay-a', label: '中转 A', baseUrl: 'https://a.test/v1', keyRef: 'dsh-token-metrics/relay-a' })
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

  // 删除
  check('删除存在站点', reloaded.removeSite('evil'), true)
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
