/**
 * 把供应商配置同步回 DSH 的模型配置。
 *
 * 这是整个插件里唯一**写**别的插件配置的地方，因此格外克制：
 *
 *  1. 只改用户明确要求同步的那条 provider 路由，不碰其它行；
 *  2. 密钥走凭据服务，绝不写进配置文件；
 *  3. 写之前先校验目标行存在且属于 llm 适配器，否则拒绝；
 *  4. 任何一步失败都给出可读原因，不做静默失败。
 *
 * pi-ai 的 `providers` 结构（见 @deepseek-ai/dsh-llm-pi-ai 的说明）：
 *
 *   providers:
 *     <routeName>:
 *       displayName: 显示名
 *       apiKeyEnv: 环境变量名      # 凭据引用，不是密钥本身
 *       api: openai-completions
 *       baseURL: https://x/v1
 *       models:
 *         - id: model-id
 *           name: 显示名
 *           contextWindow: 262144
 *           reasoningEfforts: {...}
 */

/** 默认接口格式：绝大多数中转站都是 OpenAI Chat Completions 兼容。 */
export const DEFAULT_API = 'openai-completions'

/**
 * 找一个可用于写入 provider 配置的 Loader 条目。
 *
 * 只认 `llm-pi-ai` 这一类「多 provider 字典」插件——它才是能承载自定义
 * 中转站的地方。其它 llm 插件（如 deepseek 直连）结构不同，写进去会坏。
 *
 * @returns {{entry: object, id: string, providers: object}|undefined}
 */
export function findProviderEntry(rows) {
  for (const row of rows ?? []) {
    const id = row?.entry?.options?.id ?? ''
    if (!/llm-pi-ai|llm-openai-compatible|llm-custom/.test(id)) continue
    for (const layer of [row?.override, row?.inherited]) {
      if (layer === null || typeof layer !== 'object') continue
      if (layer.providers !== null && typeof layer.providers === 'object') {
        return {
          entry: row.entry,
          id,
          providers: layer.providers,
        }
      }
    }
  }
  return undefined
}

/**
 * 把一个供应商描述转换成 pi-ai 的 provider 配置片段。
 *
 * @param {object} site 供应商（含 baseUrl / label / keyEnv / models）
 * @returns {object}
 */
export function buildProviderConfig(site) {
  const config = {
    displayName: String(site.label ?? site.id ?? ''),
    api: site.api ?? DEFAULT_API,
    baseURL: String(site.baseUrl ?? ''),
  }
  // apiKeyEnv 是「凭据引用名」，不是密钥。没有就省略，让路由保持无密钥状态。
  if (typeof site.keyEnv === 'string' && site.keyEnv !== '') {
    config.apiKeyEnv = site.keyEnv
  }
  // 只有调用方**明确传了** models 才写这个键。
  //
  // 回归点：早先只在 models.length > 0 时才赋值，而 mergeProvider 用展开
  // 运算合并：`{...(旧配置), ...(新配置)}`。新配置里没有 models 键时，展开
  // 会保留**旧配置里的 models** —— 用户移除部分模型后校验不过，看起来
  // 像「移除没同步」。现在只要传了 models（哪怕非空）就完整覆盖旧数组。
  //
  // 传了空数组的情形由 mergeProvider 处理（整条 route 删掉），因为 pi-ai
  // 要求每条 route 至少有一个模型。
  if (Array.isArray(site.models)) config.models = site.models.map((model) => {
    const entry = { id: String(model.id) }
    if (typeof model.name === 'string' && model.name !== '') entry.name = model.name
    if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
      entry.contextWindow = model.contextWindow
    }
    if (Number.isFinite(model.maxOutput) && model.maxOutput > 0) {
      // 注意字段名：pi-ai 校验的是 `maxTokens`，不是 maxOutput。
      // 早先写成 maxOutput，DSH 直接忽略且不报错——静默失效。
      entry.maxTokens = model.maxOutput
    }
    // 思考等级：pi-ai 期望 { 等级 -> 协议里的拼写 } 或 false。
    //
    // 关键细节（从 pi-ai 的 models.js 读到）：
    //  - 它的等级全集是 off/minimal/low/medium/high/xhigh/max；
    //  - `xhigh` 与 `max` 只有在 map 里**显式出现**时才算支持，
    //    其余等级只要不是 null 就视为可用；
    //  - 把某档映射成 null 表示「不支持这一档」。
    // 所以用户勾选哪些档，就只写哪些档，不要一股脑全写。
    if (Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0) {
      // 档位条目可以是两种形式：
      //   'high'                      -> 协议拼写与档位名相同
      //   { level: 'max', wire: 'ultra' } -> 网关用别的词（如 ultra）
      // 后者是给「协议拼写与档位名不一致」的网关用的。
      const efforts = {}
      for (const item of model.thinkingLevels) {
        if (typeof item === 'string' && item !== '') {
          efforts[item] = item
        } else if (item !== null && typeof item === 'object'
          && typeof item.level === 'string' && item.level !== '') {
          const wire = typeof item.wire === 'string' && item.wire !== '' ? item.wire : item.level
          efforts[item.level] = wire
        }
      }
      if (Object.keys(efforts).length > 0) entry.reasoningEfforts = efforts
    } else if (model.reasoningEfforts !== undefined) {
      entry.reasoningEfforts = model.reasoningEfforts
    }
    // 附件能力：pi-ai 的 input 数组声明模型接受哪些输入类型。
    if (Array.isArray(model.input) && model.input.length > 0) {
      entry.input = model.input
    } else if (model.image === false) {
      // 界面上「不支持图片」= 只接受文本
      entry.input = ['text']
    }
    return entry
  })
  return config
}

/**
 * 计算把 supplier 同步进 providers 后的新字典。
 *
 * 纯函数，便于测试：不读文件、不碰服务。
 */
export function mergeProvider(providers, site) {
  const routeName = String(site.id ?? '')
  if (routeName === '') throw new Error('供应商缺少 id，无法同步')
  const next = { ...(providers ?? {}) }
  const config = buildProviderConfig(site)
  /**
   * 模型被**明确清空**时移除整个 provider，而不是写 `models: []`。
   *
   * 三条约束共同决定这个行为：
   *  ① pi-ai 要求「Provider routes with at least one currently available
   *     catalog model」——空 models 的 route 是无效的；
   *  ② mergeProvider 用展开合并，若新配置不含 models 键，旧 models 会被
   *     保留，导致「移除模型不同步」；
   *  ③ **必须区分「没传 models」与「传了空数组」**：前者是调用方没打算
   *     动模型（例如只改名字/地址），后者才是用户真的把模型全删了。
   *     只判断 length === 0 会把「没传」也当成清空，误删整个 provider。
   */
  const modelsProvided = Array.isArray(site.models)
  if (modelsProvided && config.models.length === 0) {
    delete next[routeName]
    return next
  }
  next[routeName] = {
    ...(next[routeName] ?? {}),
    ...config,
  }
  return next
}

/**
 * 从 providers 字典中移除一个 provider。
 *
 * @param {object} providers
 * @param {string} routeName
 * @returns {object} 新字典（不改原对象）
 */
export function removeProvider(providers, routeName) {
  const next = { ...(providers ?? {}) }
  delete next[routeName]
  return next
}

/**
 * 执行同步：把供应商写进 DSH 的模型配置，并把密钥存进凭据服务。
 *
 * @param {object} options
 * @param {object} options.ctx 插件上下文（用于取 configEditor / credentials）
 * @param {object} options.site 供应商描述
 * @param {string} [options.apiKey] 明文密钥；给了才写凭据
 * @returns {Promise<{ok:boolean, route?:string, wroteKey?:boolean, error?:string}>}
 */
export async function syncProviderToDsh({ ctx, site, apiKey }) {
  const routeName = String(site?.id ?? '')
  if (routeName === '') return { ok: false, error: '供应商缺少 id' }
  if (typeof site.baseUrl !== 'string' || site.baseUrl === '') {
    return { ok: false, error: '供应商缺少接口地址' }
  }

  const editor = ctx.get('configEditor')
  if (editor === undefined) {
    return { ok: false, error: 'DSH 的配置编辑器不可用，无法同步' }
  }

  // 1) 定位目标行
  let rows
  try {
    rows = editor.configuration()
  } catch (error) {
    return { ok: false, error: `读取配置失败：${error?.message ?? error}` }
  }
  const target = findProviderEntry(rows)
  if (target === undefined) {
    return { ok: false, error: '没有找到可写入的模型配置行（需要 llm-pi-ai 类插件）' }
  }

  // 2) 写密钥（如果给了）
  //
  // 注意：`CredentialRef` 是 branded string，不是对象。凭空造一个字符串
  // 可能过不了品牌的运行时校验，所以通过宿主的 credentialRef 工厂构造；
  // 拿不到工厂时退化为按名字直接传，由服务端自行校验。
  let wroteKey = false
  const keyEnv = typeof site.keyEnv === 'string' && site.keyEnv !== ''
    ? site.keyEnv
    : defaultKeyEnvName(routeName)
  if (typeof apiKey === 'string' && apiKey !== '') {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      return { ok: false, error: 'DSH 的凭据服务不可用，无法保存密钥' }
    }
    try {
      const ref = makeCredentialRef(ctx, keyEnv)
      await credentials.set?.(ref, apiKey)
      wroteKey = true
    } catch (error) {
      return { ok: false, error: `保存密钥失败：${error?.message ?? error}` }
    }
  }

  // 3) 写 provider 配置
  try {
    await editor.edit(target.entry, (current) => {
      const providers = current?.providers ?? {}
      return {
        ...current,
        providers: mergeProvider(providers, { ...site, keyEnv }),
      }
    })
  } catch (error) {
    return { ok: false, error: `写入模型配置失败：${error?.message ?? error}` }
  }

  return { ok: true, route: routeName, keyEnv, wroteKey }
}

/**
 * 从 DSH 模型配置中移除一个 provider（删除供应商时调用）。
 *
 * 为什么需要：早先删除供应商只删了插件自己的记录，DSH 里那条 route 仍在，
 * 模型选择器里还能看到、还能继续调用——用户以为删掉了其实没删。
 *
 * 幂等：route 本来就不存在时返回成功（`removed: false`），
 * 避免「删除一个从未同步过的站点」报错。
 *
 * @param {object} options
 * @param {object} options.ctx 插件上下文
 * @param {string} options.routeName provider 的 id
 * @returns {Promise<{ok:boolean, removed?:boolean, error?:string}>}
 */
export async function removeProviderFromDsh({ ctx, routeName }) {
  const name = String(routeName ?? '')
  if (name === '') return { ok: false, error: '缺少供应商 id' }

  const editor = ctx.get('configEditor')
  if (editor === undefined) {
    return { ok: false, error: 'DSH 的配置编辑器不可用，无法同步删除' }
  }

  let rows
  try {
    rows = editor.configuration()
  } catch (error) {
    return { ok: false, error: `读取配置失败：${error?.message ?? error}` }
  }
  const target = findProviderEntry(rows)
  if (target === undefined) {
    // 没有可写入的配置行，等于 DSH 里本来就没有这条 route
    return { ok: true, removed: false }
  }
  if (target.providers?.[name] === undefined) {
    return { ok: true, removed: false }
  }

  try {
    await editor.edit(target.entry, (current) => {
      const providers = current?.providers ?? {}
      return {
        ...current,
        providers: removeProvider(providers, name),
      }
    })
  } catch (error) {
    return { ok: false, error: `删除模型配置失败：${error?.message ?? error}` }
  }
  return { ok: true, removed: true }
}

/**
 * 对比「DSH 配置里的 provider」与「插件记录的站点」，找出差异。
 *
 * 纯函数，便于测试。两个方向的差异都要能看出来：
 *   · onlyInDsh  —— DSH 有、插件没有 → 插件应补上（DSH 侧手动添加的）
 *   · onlyInPlugin —— 插件有、DSH 没有 → 提示可同步过去
 *   · modelDiff  —— 两边都有，但模型集合不一致
 *
 * @param {object} input
 * @param {string[]} input.dshRoutes  DSH 里已有的 provider 名
 * @param {Array<{id:string, models:Array<{id:string}>}>} input.sites 插件站点
 * @returns {{onlyInDsh:string[], onlyInPlugin:string[], modelDiff:Array<object>}}
 */
export function diffProviders({ dshRoutes, sites }) {
  const routes = Array.isArray(dshRoutes) ? dshRoutes.filter((x) => typeof x === 'string' && x !== '') : []
  const list = Array.isArray(sites) ? sites.filter((s) => s !== null && typeof s === 'object') : []
  const dshSet = new Set(routes)
  const siteMap = new Map(list.map((s) => [String(s.id ?? ''), s]))

  const onlyInDsh = routes.filter((name) => !siteMap.has(name))
  const onlyInPlugin = [...siteMap.keys()].filter((id) => id !== '' && !dshSet.has(id))

  const modelDiff = []
  for (const [id, site] of siteMap) {
    if (id === '' || !dshSet.has(id)) continue
    const siteModels = (Array.isArray(site.models) ? site.models : [])
      .map((m) => String(m?.id ?? ''))
      .filter((x) => x !== '')
    // 该 provider 在 DSH 里的模型名由调用方提供，这里只做集合比较
    const dshModels = Array.isArray(site.__dshModels) ? site.__dshModels : []
    const a = new Set(siteModels)
    const b = new Set(dshModels)
    const missingInDsh = siteModels.filter((x) => !b.has(x))
    const extraInDsh = dshModels.filter((x) => !a.has(x))
    if (missingInDsh.length > 0 || extraInDsh.length > 0) {
      modelDiff.push({ id, missingInDsh, extraInDsh })
    }
  }
  return { onlyInDsh, onlyInPlugin, modelDiff }
}

/** 由路由名生成一个合法的默认环境变量名。 */
export function defaultKeyEnvName(routeName) {
  return `DSH_TOKEN_METRICS_${String(routeName).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`
}

/**
 * 构造 CredentialRef。
 *
 * 优先用宿主的 `credentialRef()` 工厂——品牌字段只能在它内部产生。
 * 宿主没暴露时退回裸字符串：`describe`/`set` 会自行校验并报错，
 * 比我们自己伪造一个品牌值安全。
 */
function makeCredentialRef(ctx, name) {
  for (const key of ['credentialRef', 'credentialsRef']) {
    const factory = ctx.get(key)
    if (typeof factory === 'function') return factory(name)
  }
  return name
}
