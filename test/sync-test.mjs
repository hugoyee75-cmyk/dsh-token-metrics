/**
 * 同步模块自检：配置片段构造、合并、以及「写回 DSH」的完整链路。
 *
 * 这里刻意覆盖失败路径——写别人的配置是危险操作，宁可拒绝也不能写坏。
 */

import {
  findProviderEntry, buildProviderConfig, mergeProvider,
  syncProviderToDsh, defaultKeyEnvName, DEFAULT_API,
} from '../src/sync.js'

const failures = []

function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function checkTrue(label, condition, detail = '') {
  if (condition !== true) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

//#region 定位可写入的行

{
  const rows = [
    { entry: { options: { id: 'llm-deepseek' } }, override: {}, inherited: {} },
    { entry: { options: { id: 'llm-pi-ai' } }, override: { providers: { a: { baseURL: 'https://a' } } }, inherited: {} },
  ]
  const found = findProviderEntry(rows)
  check('找到 pi-ai 行', found?.id, 'llm-pi-ai')
  check('带出已有 providers', Object.keys(found.providers), ['a'])

  // 只有非多 provider 的插件时应当找不到——写进去会坏
  const none = findProviderEntry([
    { entry: { options: { id: 'llm-deepseek' } }, override: {}, inherited: {} },
  ])
  check('没有合适行时返回 undefined', none, undefined)
  check('空输入安全', findProviderEntry(null), undefined)

  // providers 在 inherited 层也要能找到
  const inherited = findProviderEntry([
    { entry: { options: { id: 'llm-pi-ai' } }, override: {}, inherited: { providers: { b: {} } } },
  ])
  check('从 inherited 层读取', Object.keys(inherited?.providers ?? {}), ['b'])
}

//#endregion

//#region 配置片段构造

{
  const config = buildProviderConfig({
    id: 'relay', label: '中转站', baseUrl: 'https://relay.test/v1', keyEnv: 'RELAY_KEY',
    models: [
      { id: 'm1', name: 'M1', contextWindow: 128000, maxOutput: 8192 },
      { id: 'm2' },
    ],
  })
  check('显示名', config.displayName, '中转站')
  check('默认接口格式', config.api, DEFAULT_API)
  check('地址原样保留', config.baseURL, 'https://relay.test/v1')
  check('凭据引用名', config.apiKeyEnv, 'RELAY_KEY')
  check('模型数量', config.models.length, 2)
  check('模型 id', config.models[0].id, 'm1')
  check('模型名称', config.models[0].name, 'M1')
  check('上下文窗口', config.models[0].contextWindow, 128000)
  // 只有 id 的模型不应出现多余字段
  check('最简模型只有 id', Object.keys(config.models[1]), ['id'])

  // 没有 keyEnv 时不写该字段（让路由保持无密钥状态，而不是写个空串）
  const noKey = buildProviderConfig({ id: 'x', baseUrl: 'https://x' })
  check('无 keyEnv 时不写该字段', noKey.apiKeyEnv, undefined)

  // 没有模型时不写 models（否则会清空目录）
  const noModels = buildProviderConfig({ id: 'x', baseUrl: 'https://x' })
  check('无模型时不写 models', noModels.models, undefined)

  // 思考档位：只写用户勾选的，且转成 pi-ai 的 reasoningEfforts
  const withLevels = buildProviderConfig({
    id: 'x', baseUrl: 'https://x',
    models: [{ id: 'm', thinkingLevels: ['off', 'low', 'high', 'max'] }],
  })
  check('档位写成 reasoningEfforts', Object.keys(withLevels.models[0].reasoningEfforts),
    ['off', 'low', 'high', 'max'])
  // 未勾选就不写该字段——pi-ai 对空对象会拒绝整条配置
  const noLevels = buildProviderConfig({
    id: 'x', baseUrl: 'https://x', models: [{ id: 'm', thinkingLevels: [] }],
  })
  check('未勾选档位时不写该字段', noLevels.models[0].reasoningEfforts, undefined)

  // 附件能力
  const textOnly = buildProviderConfig({
    id: 'x', baseUrl: 'https://x', models: [{ id: 'm', image: false }],
  })
  check('仅文本模型声明 input', textOnly.models[0].input, ['text'])
}

//#endregion

//#region 合并

{
  const providers = {
    keep: { displayName: '不动的', baseURL: 'https://keep' },
    relay: { displayName: '旧名', baseURL: 'https://old' },
  }
  const merged = mergeProvider(providers, {
    id: 'relay', label: '新名', baseUrl: 'https://new/v1', keyEnv: 'K',
  })
  check('其它 provider 不受影响', merged.keep.displayName, '不动的')
  check('目标被更新', merged.relay.displayName, '新名')
  check('地址被更新', merged.relay.baseURL, 'https://new/v1')
  check('原对象未被修改', providers.relay.displayName, '旧名')

  // 缺 id 时拒绝，避免写出一条名字为 undefined 的路由
  let threw = false
  try { mergeProvider({}, {}) } catch { threw = true }
  check('缺 id 时抛错', threw, true)
}

//#endregion

//#region 同步链路

{
  const makeCtx = ({ hasEditor = true, hasCredentials = true, editFails = false, setFails = false } = {}) => {
    const calls = { edited: [], set: [] }
    const entries = [
      { options: { id: 'llm-pi-ai' } },
    ]
    const ctx = {
      get(name) {
        if (name === 'configEditor' && hasEditor) {
          return {
            configuration: () => [{ entry: entries[0], override: { providers: {} }, inherited: {} }],
            edit: async (entry, change) => {
              if (editFails) throw new Error('写入被拒绝')
              calls.edited.push(change({ providers: {} }))
            },
          }
        }
        if (name === 'credentials' && hasCredentials) {
          return {
            set: async (ref, value) => {
              if (setFails) throw new Error('凭据写入失败')
              calls.set.push({ ref, value })
            },
          }
        }
        return undefined
      },
    }
    return { ctx, calls }
  }

  // 成功：配置与密钥都写入
  {
    const { ctx, calls } = makeCtx()
    const result = await syncProviderToDsh({
      ctx,
      site: { id: 'relay', label: '中转', baseUrl: 'https://relay.test/v1', keyEnv: 'RELAY_KEY', models: [{ id: 'm1' }] },
      apiKey: 'sk-secret',
    })
    check('同步成功', result.ok, true)
    check('返回路由名', result.route, 'relay')
    check('报告已写密钥', result.wroteKey, true)
    check('密钥写入了凭据服务', calls.set.length, 1)
    check('密钥值正确', calls.set[0].value, 'sk-secret')
    check('凭据引用名正确', calls.set[0].ref, 'RELAY_KEY')
    check('配置已写入', calls.edited.length, 1)
    check('写入的 provider 存在', calls.edited[0].providers.relay !== undefined, true)
    // 关键：配置里绝不能出现明文密钥
    checkTrue('配置不含明文密钥', !JSON.stringify(calls.edited[0]).includes('sk-secret'))
    check('配置里只有引用名', calls.edited[0].providers.relay.apiKeyEnv, 'RELAY_KEY')
  }

  // 不给密钥：只写配置
  {
    const { ctx, calls } = makeCtx()
    const result = await syncProviderToDsh({
      ctx, site: { id: 'relay2', baseUrl: 'https://r2.test', models: [{ id: 'm' }] },
    })
    check('无密钥时仍成功', result.ok, true)
    check('无密钥时不写凭据', calls.set.length, 0)
    check('自动生成引用名', result.keyEnv, defaultKeyEnvName('relay2'))
  }

  // 没有 configEditor：明确拒绝
  {
    const { ctx } = makeCtx({ hasEditor: false })
    const result = await syncProviderToDsh({ ctx, site: { id: 'x', baseUrl: 'https://x' } })
    check('无配置编辑器时失败', result.ok, false)
    checkTrue('说明原因', result.error.includes('配置编辑器'))
  }

  // 没有 credentials 但要写密钥：拒绝（不能静默丢弃密钥）
  {
    const { ctx } = makeCtx({ hasCredentials: false })
    const result = await syncProviderToDsh({
      ctx, site: { id: 'x', baseUrl: 'https://x' }, apiKey: 'sk-1',
    })
    check('无凭据服务时失败', result.ok, false)
    checkTrue('说明原因', result.error.includes('凭据'))
  }

  // 配置写入失败：把原因带出来
  {
    const { ctx } = makeCtx({ editFails: true })
    const result = await syncProviderToDsh({ ctx, site: { id: 'x', baseUrl: 'https://x' } })
    check('配置写入失败时报告', result.ok, false)
    checkTrue('带出原始错误', result.error.includes('写入被拒绝'))
  }

  // 缺必要字段
  check('缺 baseUrl 时拒绝',
    (await syncProviderToDsh({ ctx: makeCtx().ctx, site: { id: 'x' } })).ok, false)
  check('缺 id 时拒绝',
    (await syncProviderToDsh({ ctx: makeCtx().ctx, site: { baseUrl: 'https://x' } })).ok, false)
}

//#endregion

//#region 默认环境变量名

check('生成合法变量名', defaultKeyEnvName('my-relay.1'), 'DSH_TOKEN_METRICS_MY_RELAY_1_KEY')
check('大写与特殊字符', defaultKeyEnvName('a/b c'), 'DSH_TOKEN_METRICS_A_B_C_KEY')

//#endregion

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 同步模块全部断言通过')
console.log('  定位行 / 片段构造 / 合并 / 成功与拒绝路径 / 密钥不进配置')
