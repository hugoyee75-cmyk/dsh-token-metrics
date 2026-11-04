/**
 * 「模型接入 → 可添加」的发现逻辑自检。
 *
 * 两块都是纯函数，可以脱离宿主跑：
 *   · collectProviderEndpoints —— 把 configEditor 的配置行摊平成端点列表；
 *   · loadCatalogEndpoints    —— 从 pi-ai 目录读各 provider 的默认端点。
 *
 * 重点覆盖「配置里省略 baseURL」这条路径：DSH 允许只写 apiKeyEnv，
 * 地址由 pi-ai 内置目录在运行时补齐（opencode-go 就是这种）。早先的实现
 * 只看配置文本，这类 provider 会在页面上整条消失。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectProviderEndpoints, loadCatalogEndpoints, credentialConfigured } from '../src/providers.js'

const failures = []

function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

/** 造一行 configEditor.configuration() 的形状。 */
const row = (id, providers, extra = {}) => ({
  entry: { options: { id } },
  override: { providers, ...extra },
})

//#region 配置里写了 baseURL

{
  const rows = [row('llm-pi-ai', {
    'corp-gateway': {
      displayName: '公司大模型网关',
      baseURL: 'https://gateway.example.com/llm/v1',
    },
    'backup-relay': { displayName: '备用网关', baseURL: 'https://relay.example.com/v1' },
  })]
  const out = collectProviderEndpoints({ rows })
  check('显式 baseURL 全部列出', out.map((entry) => entry.id), ['corp-gateway', 'backup-relay'])
  check('展示名优先用 displayName', out[0].label, '公司大模型网关')
  check('地址原样保留（不剥 /v1）', out[0].baseUrl, 'https://gateway.example.com/llm/v1')
  check('来源标记为 config', out[0].source, 'config')
  check('带上所在配置行 id', out[0].configRow, 'llm-pi-ai')
  // 凭据引用名要带出来：表单据此复用 DSH 已有的 key，不必二次粘贴
  check('没写 apiKeyEnv 时不带该字段', out[0].apiKeyEnv, undefined)
}

//#endregion

//#region 省略 baseURL：用目录兜底

{
  // opencode-go 的真实形态：只有 apiKeyEnv + models，没有 baseURL
  const rows = [row('llm-pi-ai', {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
  })]
  const catalog = { 'opencode-go': { baseUrl: 'https://opencode.ai/inference/go/v1' } }

  const without = collectProviderEndpoints({ rows })
  check('目录不可用时省略 baseURL 的 provider 不出现', without, [])

  const out = collectProviderEndpoints({ rows, catalog })
  check('目录兜底让 opencode-go 出现', out.map((entry) => entry.id), ['opencode-go'])
  check('兜底地址取自目录', out[0].baseUrl, 'https://opencode.ai/inference/go/v1')
  check('兜底来源标记为 catalog', out[0].source, 'catalog')
  check('带上凭据引用名', out[0].apiKeyEnv, 'OPENCODE_GO_API_KEY')

  // 目录里同时有 api 时一并带出，表单据此选对协议
  const withApi = collectProviderEndpoints({
    rows,
    catalog: { 'opencode-go': { baseUrl: 'https://opencode.ai/inference/go/v1', api: 'openai-completions' } },
  })
  check('带上目录推断的协议', withApi[0].api, 'openai-completions')

  // 配置里写了地址时，配置优先于目录
  const explicit = collectProviderEndpoints({
    rows: [row('llm-pi-ai', {
      'opencode-go': { apiKeyEnv: 'X', baseURL: 'https://relay.example.com/v1' },
    })],
    catalog,
  })
  check('配置优先于目录', explicit[0].baseUrl, 'https://relay.example.com/v1')
  check('配置优先时来源为 config', explicit[0].source, 'config')
}

//#endregion

//#region 去重与形态兼容

{
  // 用户 override 与继承值都会出现，同名 provider 只保留第一个
  const rows = [{
    entry: { options: { id: 'llm-pi-ai' } },
    inherited: { providers: { 'opencode-go': { apiKeyEnv: 'A' } } },
    override: { providers: { 'opencode-go': { apiKeyEnv: 'B' } } },
  }]
  const out = collectProviderEndpoints({
    rows,
    catalog: { 'opencode-go': { baseUrl: 'https://opencode.ai/inference/go/v1' } },
  })
  check('同名 provider 去重', out.length, 1)
}

{
  // 单 provider 形态：baseURL 直接挂在配置顶层
  const rows = [{
    entry: { options: { id: 'llm-deepseek' } },
    inherited: { displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com/anthropic' },
  }]
  const out = collectProviderEndpoints({ rows })
  check('顶层单 provider 形态', out.map((entry) => entry.id), ['llm-deepseek'])
  check('顶层形态保留地址', out[0].baseUrl, 'https://api.deepseek.com/anthropic')
}

{
  // 脏输入不能抛
  check('rows 为空', collectProviderEndpoints({ rows: [] }), [])
  check('rows 缺失', collectProviderEndpoints(), [])
  check('catalog 为 null', collectProviderEndpoints({
    rows: [row('llm-pi-ai', { x: { apiKeyEnv: 'K' } })], catalog: null,
  }), [])
  check('provider 条目为 null', collectProviderEndpoints({
    rows: [{ entry: { options: { id: 'r' } }, override: { providers: { x: null } } }],
  }), [])
}

//#endregion

//#region 读 pi-ai 目录

{
  const dir = mkdtempSync(join(tmpdir(), 'tm-catalog-'))
  try {
    writeFileSync(join(dir, 'opencode-go.json'), JSON.stringify({
      'openai-completions': {
        'chat:deepseek-v4.1-flash': {
          id: 'deepseek-v4.1-flash', api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/go/v1',
        },
      },
      'openai-responses': {
        'chat:gpt-5.6-luna': {
          id: 'gpt-5.6-luna', api: 'openai-responses', baseUrl: 'https://opencode.ai/inference/go/v1',
        },
      },
      // 少数模型挂在裸前缀上：按模型数投票，默认端点应该是 /v1 那个
      'anthropic-messages': {
        'chat:claude-haiku-5-5': {
          id: 'claude-haiku-5-5', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/inference/go',
        },
      },
    }))
    writeFileSync(join(dir, 'deepseek.json'), JSON.stringify({
      'openai-completions': {
        'chat:deepseek-flash': {
          id: 'deepseek-flash', api: 'openai-completions', baseUrl: 'https://api.deepseek.com',
        },
      },
    }))
    // 坏文件与无关文件都要被跳过
    writeFileSync(join(dir, 'broken.json'), '{not json')
    writeFileSync(join(dir, 'README.md'), 'x')

    const endpoints = loadCatalogEndpoints({ dataDir: dir, ttlMs: 0 })
    check('目录里每个 provider 一个端点', Object.keys(endpoints).sort(), ['deepseek', 'opencode-go'])
    check('opencode-go 端点', endpoints['opencode-go'].baseUrl, 'https://opencode.ai/inference/go/v1')
    check('opencode-go 多数派 api', endpoints['opencode-go'].api, 'openai-completions')
    // 模型全集要带出来：同步侧靠它判断「能不能完全交给目录」
    check('opencode-go 模型全集', endpoints['opencode-go'].modelIds,
      ['claude-haiku-5-5', 'deepseek-v4.1-flash', 'gpt-5.6-luna'])
    check('deepseek 端点', endpoints.deepseek.baseUrl, 'https://api.deepseek.com')
    check('deepseek 模型全集', endpoints.deepseek.modelIds, ['deepseek-flash'])
    check('坏文件被跳过', endpoints.broken, undefined)

    // 缓存：默认 TTL 内不重读，ttlMs:0 才重读
    writeFileSync(join(dir, 'added.json'), JSON.stringify({
      'openai-completions': { a: { id: 'a', baseUrl: 'https://added.example.com' } },
    }))
    const cached = loadCatalogEndpoints({ dataDir: dir })
    check('缓存内不重读', cached.added, undefined)
    const fresh = loadCatalogEndpoints({ dataDir: dir, ttlMs: 0 })
    check('ttlMs:0 时重读', fresh.added, {
      baseUrl: 'https://added.example.com', modelIds: ['a'],
    })

    const empty = loadCatalogEndpoints({ dataDir: join(dir, 'not-exist'), ttlMs: 0 })
    check('目录不存在返回空映射', empty, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

//#region 凭据复用判定

{
  const configured = { describe: async (name) => ({ configured: name === 'OPENCODE_GO_API_KEY' }) }
  check('已配置的凭据', await credentialConfigured(configured, 'OPENCODE_GO_API_KEY'), true)
  check('未配置的凭据', await credentialConfigured(configured, 'NOPE_API_KEY'), false)
  check('空名字不算已配置', await credentialConfigured(configured, ''), false)
  check('凭据服务缺失', await credentialConfigured(undefined, 'A'), false)
  check('describe 抛错不崩', await credentialConfigured({ describe: async () => { throw new Error('x') } }, 'A'), false)
  check('describe 返回空', await credentialConfigured({ describe: async () => undefined }, 'A'), false)
}

//#endregion

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 模型接入发现逻辑全部断言通过')
console.log('  显式 baseURL / 目录兜底 / 模型全集 / 去重 / 单 provider 形态 / 目录读取与缓存')
