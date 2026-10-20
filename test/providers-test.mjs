/**
 * 官方平台余额/配额适配器自检。
 *
 * 官方接口各不相同且都要真 key，所以这里全部用注入的假 fetch，
 * 覆盖「响应形态解析」与「错误归类」两部分。
 */

import {
  detectProvider, probeOfficial, isSupportedProvider, PROVIDER_LABELS, windowLabel,
} from '../src/providers.js'

const failures = []

function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function checkTrue(label, condition, detail = '') {
  if (condition !== true) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

/** 构造一个只对指定路径返回给定 body 的假 fetch。 */
const respond = (routes) => async (url) => {
  const target = String(url)
  for (const [fragment, body] of Object.entries(routes)) {
    if (target.includes(fragment)) {
      return { ok: true, status: 200, async json() { return body } }
    }
  }
  return { ok: false, status: 404, async json() { return {} } }
}

//#region 平台识别

check('DeepSeek', detectProvider('https://api.deepseek.com'), 'deepseek')
check('DeepSeek 带路径', detectProvider('https://api.deepseek.com/v1'), 'deepseek')
check('GLM 大模型平台', detectProvider('https://open.bigmodel.cn/api/anthropic'), 'glm')
check('GLM z.ai', detectProvider('https://api.z.ai'), 'glm')
check('Kimi', detectProvider('https://api.kimi.com'), 'kimi')
check('OpenRouter', detectProvider('https://openrouter.ai/api/v1'), 'openrouter')
check('SiliconFlow', detectProvider('https://api.siliconflow.cn'), 'siliconflow')
check('Novita', detectProvider('https://api.novita.ai'), 'novita')
check('MiniMax', detectProvider('https://api.minimax.io'), 'minimax')
// 中转站不应被误判成官方
check('中转站不识别', detectProvider('https://sub.100xlabs.space'), undefined)
check('另一个中转站', detectProvider('https://cmd.mrhear.us.ci'), undefined)
check('空值安全', detectProvider(''), undefined)

check('官方平台标记为支持', isSupportedProvider('https://api.deepseek.com'), true)
// 能识别但不支持查询：识别是为了给出准确说明
check('Codex 能被识别', detectProvider('https://chatgpt.com/backend-api'), 'codex')
check('Codex 标记为不支持查询', isSupportedProvider('https://chatgpt.com/backend-api'), false)
check('中转站标记为不支持', isSupportedProvider('https://relay.test'), false)
check('有展示名', PROVIDER_LABELS.deepseek, 'DeepSeek')

//#endregion

//#region DeepSeek

{
  const ok = await probeOfficial({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-x',
    fetchImpl: respond({
      '/user/balance': {
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '12.34' }],
      },
    }),
  })
  check('DeepSeek 余额', ok.usd, 12.34)
  check('DeepSeek 类型', ok.kind, 'balance')
  check('DeepSeek 平台', ok.provider, 'deepseek')

  // 只有 CNY 时不做汇率换算，保留原始币种
  const cny = await probeOfficial({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-x',
    fetchImpl: respond({ '/user/balance': { balance_infos: [{ currency: 'CNY', total_balance: '88' }] } }),
  })
  check('CNY 保留币种', cny.currency, 'CNY')
  check('CNY 不谎报美元', cny.usd, undefined)
  check('CNY 原始金额', cny.raw, 88)

  // 余额不可用（key 失效）
  const bad = await probeOfficial({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-x',
    fetchImpl: respond({ '/user/balance': { is_available: false, balance_infos: [] } }),
  })
  check('无余额字段时失败', bad.ok, false)
}

//#endregion

//#region OpenRouter / SiliconFlow / Novita

{
  const or = await probeOfficial({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
    fetchImpl: respond({ '/api/v1/credits': { data: { total_credits: 50, total_usage: 12.5 } } }),
  })
  check('OpenRouter 剩余=额度-已用', or.usd, 37.5)
  check('OpenRouter 已用', or.usedUsd, 12.5)
  check('OpenRouter 额度', or.limitUsd, 50)

  const sf = await probeOfficial({
    baseUrl: 'https://api.siliconflow.cn',
    apiKey: 'k',
    fetchImpl: respond({ '/v1/user/info': { data: { totalBalance: '20.5' } } }),
  })
  check('SiliconFlow 余额', sf.usd, 20.5)
  check('SiliconFlow 币种', sf.currency, 'CNY')

  const nv = await probeOfficial({
    baseUrl: 'https://api.novita.ai',
    apiKey: 'k',
    fetchImpl: respond({ '/v1/user/balance': { balance_infos: [{ currency: 'USD', total_balance: 7.25 }] } }),
  })
  check('Novita 余额', nv.usd, 7.25)
}

//#endregion

//#region 配额型：Kimi

{
  // limits 数组形态
  const kimi = await probeOfficial({
    baseUrl: 'https://api.kimi.com',
    apiKey: 'k',
    fetchImpl: respond({
      '/coding/v1/usages': {
        data: {
          limits: [
            { window: { five_hour: {} }, detail: { remaining: 60, limit: 100, resetTime: 1_900_000_000_000 } },
            { window: { weekly_limit: {} }, detail: { remaining: 20, limit: 100 } },
          ],
        },
      },
    }),
  })
  check('Kimi 类型为配额', kimi.kind, 'quota')
  check('Kimi 配额数', kimi.quotas.length, 2)
  check('Kimi 5小时已用', kimi.quotas[0].used, 40)
  check('Kimi 5小时上限', kimi.quotas[0].limit, 100)
  check('Kimi 窗口名', kimi.quotas[1].label, 'Weekly')
  check('Kimi 重置时间', kimi.quotas[0].resetsAt, 1_900_000_000_000)

  // usage 扁平形态
  const flat = await probeOfficial({
    baseUrl: 'https://api.kimi.com',
    apiKey: 'k',
    fetchImpl: respond({
      '/coding/v1/usages': {
        usage: {
          five_hour: { used_value_usd: 2.5, max_value_usd: 10 },
          weekly_limit: { used_value_usd: 15, max_value_usd: 50 },
        },
      },
    }),
  })
  check('Kimi 扁平形态已用', flat.quotas[0].used, 2.5)
  check('Kimi 扁平形态单位', flat.quotas[0].unit, 'USD')

  // 没有订阅：这是有效状态，要能和「失败」区分开
  const noPlan = await probeOfficial({
    baseUrl: 'https://api.kimi.com',
    apiKey: 'k',
    fetchImpl: respond({ '/coding/v1/usages': { msg: 'No active Coding Plan subscription' } }),
  })
  check('Kimi 无订阅', noPlan.noPlan, true)
  check('Kimi 无订阅不算成功', noPlan.ok, false)
}

//#endregion

//#region 配额型：GLM

{
  const glm = await probeOfficial({
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'k',
    fetchImpl: respond({
      '/api/monitor/usage/quota/limit': {
        code: 0, success: true,
        data: {
          limits: [
            { type: 'five_hour', used: 30, limit: 100, resetTime: 1_900_000_000_000 },
            { type: 'weekly_limit', used: 80, limit: 100 },
          ],
        },
      },
    }),
  })
  check('GLM 配额数', glm.quotas.length, 2)
  check('GLM 5小时已用', glm.quotas[0].used, 30)

  // 实测过的真实响应：账号没有 coding plan
  const noPlan = await probeOfficial({
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'k',
    fetchImpl: respond({
      '/api/monitor/usage/quota/limit': { code: 500, msg: '当前用户不存在coding plan', success: false },
    }),
  })
  check('GLM 无订阅被识别', noPlan.noPlan, true)
  check('GLM 无订阅带原因', noPlan.error.includes('coding plan'), true)
  check('GLM 无订阅不算成功', noPlan.ok, false)
}

//#endregion

//#region 窗口名归一化

// 不能只认写死的键，否则新窗口会静默丢失（周限额看不到就是这么来的）
check('5 小时窗口', windowLabel('five_hour'), '5-hour')
check('周窗口', windowLabel('weekly_limit'), 'Weekly')
check('月窗口', windowLabel('monthly'), 'Monthly')
check('日窗口', windowLabel('daily'), 'Daily')
check('对象形态取键', windowLabel({ five_hour: {} }), '5-hour')
check('未知窗口原样返回', windowLabel('custom_window'), 'custom_window')
check('空对象', windowLabel({}), 'Quota')
check('null 安全', windowLabel(null), 'Quota')

//#endregion

//#region 不支持的平台：要给出准确原因，而不是含糊失败

// ChatGPT 订阅额度绑定在账号 OAuth 上，API key 请求实测返回 403。
// Gemini 没有公开配额接口。两者都必须明确说明，不能假装支持。
{
  const codex = await probeOfficial({
    baseUrl: 'https://chatgpt.com/backend-api',
    apiKey: 'sk-test',
    fetchImpl: respond({}),
  })
  check('Codex 标记为不支持', codex.unsupported, true)
  check('Codex 不算成功', codex.ok, false)
  checkTrue('Codex 说明绑定登录态', codex.error.includes('登录态'), codex.error)

  const gemini = await probeOfficial({
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'k',
    fetchImpl: respond({}),
  })
  check('Gemini 标记为不支持', gemini.unsupported, true)
  checkTrue('Gemini 说明无公开接口', gemini.error.includes('配额'), gemini.error)

  // 关键：不支持时**绝不能发请求**——发了也只是白费并可能触发风控
  let called = false
  const spy = async () => { called = true; return { ok: false, status: 403, async json() { return {} } } }
  await probeOfficial({ baseUrl: 'https://chatgpt.com/backend-api', apiKey: 'k', fetchImpl: spy })
  check('不支持时零请求', called, false)
}

//#endregion

//#region 配额型：MiniMax//#region 配额型：MiniMax

{
  const mm = await probeOfficial({
    baseUrl: 'https://api.minimax.io',
    apiKey: 'k',
    fetchImpl: respond({
      '/v1/usage': {
        base_resp: { status_code: 0 },
        data: { five_hour: { used_value_usd: 1, max_value_usd: 4 } },
      },
    }),
  })
  check('MiniMax 配额', mm.quotas[0].used, 1)

  // status_code 非 0 要报错而不是当成成功
  const err = await probeOfficial({
    baseUrl: 'https://api.minimax.io',
    apiKey: 'k',
    fetchImpl: respond({
      '/v1/usage': { base_resp: { status_code: 1001, status_msg: 'invalid api key' } },
    }),
  })
  check('MiniMax 错误码被识别', err.ok, false)
  checkTrue('MiniMax 带错误信息', err.error.includes('invalid api key'), err.error)
}

//#endregion

//#region 边界

{
  // 识别不出平台时要明确告诉调用方「不支持」，
  // 好让它回退到中转站的通用探测。
  const unknown = await probeOfficial({ baseUrl: 'https://relay.test', apiKey: 'k' })
  check('未知平台标记 unsupported', unknown.unsupported, true)
  check('未知平台不算成功', unknown.ok, false)

  // 网络异常不能抛出去
  const throwing = async () => { throw new Error('ECONNREFUSED') }
  const failed = await probeOfficial({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: throwing })
  check('网络异常被捕获', failed.ok, false)

  // 非 JSON 也不崩
  const badJson = async () => ({ ok: true, status: 200, async json() { throw new Error('bad') } })
  const bad = await probeOfficial({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: badJson })
  check('非 JSON 被处理', bad.ok, false)
}

//#endregion

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 官方平台适配器全部断言通过')
console.log('  平台识别 / DeepSeek / OpenRouter / SiliconFlow / Novita / Kimi / GLM / MiniMax')
