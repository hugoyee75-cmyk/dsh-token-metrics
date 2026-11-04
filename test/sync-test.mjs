/**
 * 同步模块自检：配置片段构造、合并、以及「写回 DSH」的完整链路。
 *
 * 这里刻意覆盖失败路径——写别人的配置是危险操作，宁可拒绝也不能写坏。
 */

import {
  findProviderEntry, buildProviderConfig, mergeProvider, diffProviders, removeProvider,
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

  // pi-ai 目录里已有的路由：模型全集命中时不能写 route 级 api，否则 DSH
  // 不再复用目录 provider，opencode 的 x-opencode-session 中间件会丢，请求 400。
  const knownCatalog = {
    'opencode-go': {
      baseUrl: 'https://opencode.ai/inference/go/v1',
      api: 'openai-completions',
      modelIds: ['deepseek-v4.1-flash', 'gpt-6-luna', 'claude-haiku-5-5'],
    },
  }
  const known = buildProviderConfig({
    id: 'opencode-go', label: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/v1',
    api: 'openai-completions', models: [{ id: 'deepseek-v4.1-flash' }],
  }, { catalog: knownCatalog })
  check('目录内路由不写 api', known.api, undefined)
  // 地址与目录默认端点一致时也交给目录：opencode-go 的 5 个 anthropic 模型
  // 在 `/go` 而不是 `/go/v1`，写死地址会让它们请求 `/go/v1/v1/messages`。
  check('目录内路由不写地址', known.baseURL, undefined)
  check('目录内路由仍写模型', known.models.map((m) => m.id), ['deepseek-v4.1-flash'])

  // 目录不认得的模型：必须写 api + 地址，否则 DSH strict 校验直接拒绝写入
  // （混合协议路由没有公共 api，model "x" needs an api）。
  const unknownModel = buildProviderConfig({
    id: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/v1',
    api: 'openai-completions', models: [{ id: 'brand-new-model' }],
  }, { catalog: knownCatalog })
  check('目录外模型写 api', unknownModel.api, 'openai-completions')
  check('目录外模型写地址', unknownModel.baseURL, 'https://opencode.ai/inference/go/v1')

  // 模型全命中、但地址是用户自己换的中转：保留地址，协议仍交给目录
  const customEndpoint = buildProviderConfig({
    id: 'opencode-go', baseUrl: 'https://relay.test/go/v1',
    api: 'openai-completions', models: [{ id: 'deepseek-v4.1-flash' }],
  }, { catalog: knownCatalog })
  check('自定义地址保留', customEndpoint.baseURL, 'https://relay.test/go/v1')
  check('自定义地址时仍不写 api', customEndpoint.api, undefined)

  // 旧版插件写坏过的路由：合并时必须把遗留的 api/baseURL 删掉，
  // 否则「重新保存」无法自愈（展开合并不会删除键）。
  const legacy = {
    'opencode-go': {
      displayName: 'OpenCode Go', apiKeyEnv: 'OPENCODE_GO_API_KEY',
      api: 'openai-completions', baseURL: 'https://opencode.ai/inference/go/v1',
      models: [{ id: 'deepseek-v4.1-flash' }],
    },
  }
  const repaired = mergeProvider(legacy, {
    id: 'opencode-go', label: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/v1',
    api: 'openai-completions', keyEnv: 'OPENCODE_GO_API_KEY',
    models: [{ id: 'deepseek-v4.1-flash' }],
  }, { catalog: knownCatalog })
  check('合并后遗留 api 被删除', repaired['opencode-go'].api, undefined)
  check('合并后遗留 baseURL 被删除', repaired['opencode-go'].baseURL, undefined)
  check('合并后模型仍在', repaired['opencode-go'].models.map((m) => m.id), ['deepseek-v4.1-flash'])
  // 目录外的自定义路由不能受这条规则影响
  const relayMerged = mergeProvider({
    relay: { api: 'anthropic-messages', baseURL: 'https://relay.test/v1' },
  }, {
    id: 'relay', label: 'Relay', baseUrl: 'https://relay.test/v1',
    api: 'anthropic-messages', models: [{ id: 'm1' }],
  })
  check('自定义路由保留 api', relayMerged.relay.api, 'anthropic-messages')

  // 目录外的自定义路由：必须写协议，否则 DSH 不知道用哪种 wire protocol
  const unknown = buildProviderConfig({
    id: 'my-relay', baseUrl: 'https://relay.test/v1', api: 'anthropic-messages',
  }, { catalog: knownCatalog })
  check('目录外路由写 api', unknown.api, 'anthropic-messages')

  // 没有 keyEnv 时不写该字段（让路由保持无密钥状态，而不是写个空串）
  const noKey = buildProviderConfig({ id: 'x', baseUrl: 'https://x' })
  check('无 keyEnv 时不写该字段', noKey.apiKeyEnv, undefined)

  // 没传 models 时不写该键（调用方没打算动模型）
  const noModels = buildProviderConfig({ id: 'x', baseUrl: 'https://x' })
  check('未传 models 时不写该键', noModels.models, undefined)
  // 传了 models 就必须完整覆盖（含空数组，由 mergeProvider 决定删 route）
  const emptyModels = buildProviderConfig({ id: 'x', baseUrl: 'https://x', models: [] })
  check('传空数组时写空 models', emptyModels.models, [])
  const oneModel = buildProviderConfig({ id: 'x', baseUrl: 'https://x', models: [{ id: 'm1' }] })
  check('传模型时写完整数组', oneModel.models.length, 1)

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

  // 协议拼写自定义：网关不认档位名时（如把 max 叫 ultra），
  // 档位条目写成 { level, wire }，同步时按 wire 落盘。
  const custom = buildProviderConfig({
    id: 'x', baseUrl: 'https://x',
    models: [{ id: 'm', thinkingLevels: ['low', { level: 'max', wire: 'ultra' }] }],
  })
  check('自定义协议值生效', custom.models[0].reasoningEfforts, { low: 'low', max: 'ultra' })
  // 字符串形式仍按「同名映射」处理（兼容旧配置）
  const plain = buildProviderConfig({
    id: 'x', baseUrl: 'https://x', models: [{ id: 'm', thinkingLevels: ['low', 'high'] }],
  })
  check('字符串形式同档位名', plain.models[0].reasoningEfforts, { low: 'low', high: 'high' })
  // wire 为空时退回档位名，不能写出空串
  const emptyWire = buildProviderConfig({
    id: 'x', baseUrl: 'https://x', models: [{ id: 'm', thinkingLevels: [{ level: 'max', wire: '' }] }],
  })
  check('空 wire 退回档位名', emptyWire.models[0].reasoningEfforts, { max: 'max' })

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

//#region 移除模型 / 移除供应商要同步 DSH

{
  // 移除部分模型：剩余模型必须完整覆盖旧数组
  const before = {
    relay: {
      displayName: '旧', baseURL: 'https://x',
      models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    },
  }
  const after = mergeProvider(before, {
    id: 'relay', label: '旧', baseUrl: 'https://x/v1',
    models: [{ id: 'a' }, { id: 'c' }],
  })
  check('移除部分模型后只剩两个', after.relay.models.length, 2)
  check('被移除的 b 不在了', after.relay.models.some((m) => m.id === 'b'), false)
  check('保留的模型还在', after.relay.models.map((m) => m.id).join(','), 'a,c')

  // 移除**全部**模型：整条 route 删掉（pi-ai 要求至少一个模型）
  const emptied = mergeProvider(before, {
    id: 'relay', label: '旧', baseUrl: 'https://x', models: [],
  })
  check('模型全删后 route 被移除', emptied.relay, undefined)
  check('其它 provider 不受影响',
    mergeProvider({ keep: { displayName: 'k' }, relay: { displayName: 'r' } },
      { id: 'relay', label: 'r', baseUrl: 'u', models: [] }).keep?.displayName, 'k')

  // 没传 models：不动原有模型（只改名字/地址的场景）
  const renamed = mergeProvider(before, { id: 'relay', label: '新名' })
  check('未传 models 时保留原模型', renamed.relay.models.length, 3)
  check('未传 models 时名字已更新', renamed.relay.displayName, '新名')
}

//#endregion

//#region 双向同步：比对 DSH 与插件站点

{
  const sites = [
    { id: 'a', models: [{ id: 'm1' }, { id: 'm2' }], keyEnv: 'K_A' },
    { id: 'b', models: [{ id: 'm3' }], keyEnv: 'K_B' },
    { id: 'local-only', models: [] },   // 没 keyEnv，从未同步过
  ]
  // DSH 里有 a、b、c；插件有 a、b、local-only
  const diff = diffProviders({ dshRoutes: ['a', 'b', 'c'], sites })
  check('DSH 有插件没有的列出', diff.onlyInDsh.join(','), 'c')
  check('插件有 DSH 没有的列出', diff.onlyInPlugin.join(','), 'local-only')

  // 模型差异
  const withDshModels = [
    { id: 'a', models: [{ id: 'm1' }, { id: 'm2' }], __dshModels: ['m1', 'm9'] },
  ]
  const d2 = diffProviders({ dshRoutes: ['a'], sites: withDshModels })
  check('找出 DSH 缺失的模型', d2.modelDiff[0]?.missingInDsh?.join(','), 'm2')
  check('找出 DSH 多出的模型', d2.modelDiff[0]?.extraInDsh?.join(','), 'm9')

  // 完全一致时无差异
  const same = diffProviders({ dshRoutes: ['a'], sites: [{ id: 'a', models: [{ id: 'm1' }], __dshModels: ['m1'] }] })
  check('一致时无模型差异', same.modelDiff.length, 0)

  // 边界：空输入不抛错
  let threw = false
  try { diffProviders({}) } catch { threw = true }
  check('空输入不抛错', threw, false)

  // **关键安全边界**：DSH 读到空列表时，不能据此认为「插件所有站点都是孤儿」。
  // 调用方必须自己拦截（index.js 里有 dsh.length === 0 的闸门）。
  // 这里固化这个语义：空 dshRoutes 会让所有站点落进 onlyInPlugin。
  const dangerous = diffProviders({ dshRoutes: [], sites: [{ id: 'a', keyEnv: 'K' }] })
  check('空 DSH 列表会把所有站点标为孤儿（调用方须拦截）',
    dangerous.onlyInPlugin.join(','), 'a')
}

//#endregion

//#region baseURL 的 /v1 必须原样保留

// 回归点：用户实测「地址配置了带 v1，同步到 DSH 之后就没了」。
// 排查发现保存站点、写入 DSH 两条链路都是对的，问题在**读回显示**那一步
// 调了 normalizeBaseUrl（它会无条件剥末尾 /v1）。读回必须如实反映存的是什么。
check('写入 DSH 时保留 /v1',
  buildProviderConfig({ id: 'r', label: 'R', baseUrl: 'https://api.x.com/v1' }).baseURL,
  'https://api.x.com/v1')
check('写入时保留路径前缀 + /v1',
  buildProviderConfig({ id: 'r', label: 'R', baseUrl: 'https://x.com/gw/v1' }).baseURL,
  'https://x.com/gw/v1')
check('无 /v1 时不变',
  buildProviderConfig({ id: 'r', label: 'R', baseUrl: 'https://x.com' }).baseURL,
  'https://x.com')

//#endregion

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 同步模块全部断言通过')
console.log('  定位行 / 片段构造 / 合并 / 成功与拒绝路径 / 密钥不进配置')
