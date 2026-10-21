/**
 * Token 用量统计 —— Client 侧。
 *
 * 两个贡献：
 *   1. `sidebar.panellist` —— 侧边栏的全局面板入口（图标按钮），id 与
 *      `main` 面板的 key 相同，点击即切换中央面板。
 *   2. `main` —— 独立统计页，key 与上面一致。
 *
 * 数据走插件自己的同源 `/api/dsh-token-metrics/summary` 路由，而不是类型化
 * Remote：聚合在 Host 侧完成，浏览器只负责渲染。
 *
 * 手写 ModuleLoader bundle，无构建步骤；除 shell 已提供的 `react` 外无依赖。
 * 所有颜色走主题 token，因此亮/暗色切换自动跟随。
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-metrics',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo, useRef } = React

    /** 可选的自动刷新间隔（毫秒）。0 表示只在打开页面时读一次。 */
    const REFRESH_OPTIONS = [
      { id: 0, labelKey: 'refresh.off' },
      { id: 10_000, labelKey: 'refresh.10s' },
      { id: 30_000, labelKey: 'refresh.30s' },
      { id: 60_000, labelKey: 'refresh.60s' },
      { id: 300_000, labelKey: 'refresh.5m' },
    ]
    /** 默认刷新间隔。Host 侧有快照缓存，轮询本身很轻，但仍然默认放宽。 */
    const DEFAULT_REFRESH_MS = 30_000
    /** 记住用户选择的 key。 */
    const REFRESH_STORAGE_KEY = 'dsh-token-metrics:refresh-ms'

    /** 与 Host 侧路由、locale 命名空间保持一致。 */
    const NS = 'settings.tokenUsage'
    const PANEL_ID = 'token-metrics'
    const SUMMARY_ROUTE = '/api/dsh-token-metrics/summary'
    const FLUSH_ROUTE = '/api/dsh-token-metrics/flush'
    const VERSION_ROUTE = '/api/dsh-token-metrics/version'
    const UPDATE_CHECK_ROUTE = '/api/dsh-token-metrics/update/check'
    const UPDATE_APPLY_ROUTE = '/api/dsh-token-metrics/update/apply'
    const RELOAD_ROUTE = '/api/dsh-token-metrics/reload'
  const PRICING_OVERRIDE_ROUTE = '/api/dsh-token-metrics/pricing/override'
  const PRICING_MULTIPLIER_ROUTE = '/api/dsh-token-metrics/pricing/multiplier'
  const PRICING_REFRESH_ROUTE = '/api/dsh-token-metrics/pricing/refresh'
  const BALANCE_ROUTE = '/api/dsh-token-metrics/balance'
  const EVENTS_ROUTE = '/api/dsh-token-metrics/events'
  const BALANCE_SITE_ROUTE = '/api/dsh-token-metrics/balance/site'
  const BALANCE_REMOVE_ROUTE = '/api/dsh-token-metrics/balance/remove'
  const BALANCE_PROBE_ROUTE = '/api/dsh-token-metrics/balance/probe'
  const PRICING_ALIAS_ROUTE = '/api/dsh-token-metrics/pricing/alias'
  /**
   * 各家服务的预设连接信息。
   *
   * 客户端独立维护一份：让用户先选「服务」，自动填好地址与协议，
   * 避免把 Anthropic 的地址配成 OpenAI 协议这类错误。
   * `balance` 说明该服务的余额能否用 API key 查询。
   */
  /**
   * 各家服务的接入预设。
   *
   * 关键区分：同一家厂商的「按量计费 API」与「Coding Plan」用的是**不同地址**
   * 与**不同协议**。例如智谱：
   *   - 按量计费： https://open.bigmodel.cn/api/paas/v4      (OpenAI 协议)
   *   - Coding Plan: https://open.bigmodel.cn/api/anthropic   (Anthropic 协议)
   * 填错地址会直接 404，所以拆成两条独立预设，让用户按自己买的套餐选。
   *
   * `balance` 说明余额/配额能否用 API key 查询。
   */
  const SERVICE_PRESETS = [
    // ═══ 国内 · 国产模型（优先展示）═══
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', api: 'openai-completions', balance: 'yes' },
    { id: 'kimi', label: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions', balance: 'yes' },
    { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', balance: 'yes' },
    { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', api: 'openai-completions', balance: 'yes' },
    { id: 'qwen', label: '阿里百炼（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', balance: 'no', keyHint: '无公开余额接口，请到百炼控制台查看' },
    { id: 'volcano', label: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions', balance: 'yes', keyHint: '余额走 /api/v3/billing/balance' },
    { id: 'qianfan', label: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', api: 'openai-completions', balance: 'no' },
    { id: 'hunyuan', label: '腾讯混元', baseUrl: 'https://hunyuan.tencentcloudapi.com/v1', api: 'openai-completions', balance: 'no' },
    { id: 'baichuan', label: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1', api: 'openai-completions', balance: 'no' },
    { id: 'stepfun', label: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', api: 'openai-completions', balance: 'yes' },
    { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', api: 'openai-completions', balance: 'yes' },

    // ═══ 国内 · Coding Plan（订阅制）═══
    //
    // 地址标注规则：**实测存在**的写真实地址（401/400 表示需鉴权而非不存在），
    // 无法验证的留空让用户按官方文档填——给一个填了就 404 的地址比留空更糟。
    { id: 'glm-coding', label: '智谱 GLM Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/anthropic', api: 'anthropic-messages', balance: 'yes', plan: true, keyHint: '与按量计费的 /api/paas/v4 不同' },
    { id: 'kimi-coding', label: 'Kimi Coding Plan', baseUrl: '', api: 'anthropic-messages', balance: 'yes', plan: true, keyHint: '额度可查（/coding/v1/usages）；推理地址请按官方文档填写' },
    { id: 'minimax-coding', label: 'MiniMax Coding Plan', baseUrl: '', api: 'anthropic-messages', balance: 'yes', plan: true, keyHint: '推理地址请按官方文档填写' },
    { id: 'qwen-coding', label: '阿里百炼 Coding Plan', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', api: 'anthropic-messages', balance: 'no', plan: true },
    { id: 'volcano-coding', label: '火山方舟 Coding Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/anthropic', api: 'anthropic-messages', balance: 'no', plan: true },

    // ═══ 国际主流 ═══
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', balance: 'admin', keyHint: 'sk- 开头；查用量需 sk-admin- 组织密钥' },
    { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages', balance: 'no', keyHint: 'sk-ant- 开头' },
    { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'openai-completions', balance: 'no', keyHint: 'Google AI Studio 的 key' },
    { id: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', api: 'openai-completions', balance: 'no' },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions', balance: 'no' },
    { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions', balance: 'no' },
    { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', api: 'openai-completions', balance: 'no' },
    { id: 'fireworks', label: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', api: 'openai-completions', balance: 'no' },
    { id: 'deepinfra', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', api: 'openai-completions', balance: 'no' },
    { id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', api: 'openai-completions', balance: 'no' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', balance: 'yes' },
    { id: 'novita', label: 'Novita AI', baseUrl: 'https://api.novita.ai/v3/openai', api: 'openai-completions', balance: 'yes' },

    // ═══ 自定义中转站 ═══
    // 按网关类型区分，从源头决定用哪个余额接口——不自动探测，
    // 省掉「先试 sub2api 404 再试 new-api」的白等。
    { id: 'custom-sub2api', label: '自定义 · Sub2API 中转', baseUrl: '', api: 'openai-completions', balance: 'yes', balanceKind: 'sub2api', keyHint: '余额走 /v1/usage' },
    { id: 'custom-newapi', label: '自定义 · new-api 中转', baseUrl: '', api: 'openai-completions', balance: 'yes', balanceKind: 'newapi', keyHint: '余额走 /api/user/self' },
    { id: 'custom-oneapi', label: '自定义 · one-api 中转', baseUrl: '', api: 'openai-completions', balance: 'yes', balanceKind: 'oneapi', keyHint: '余额走 /dashboard/billing' },
    { id: 'custom', label: '自定义端点（不查余额）', baseUrl: '', api: 'openai-completions', balance: 'none', balanceKind: 'none' },
  ]

  const SUPPLIER_MODELS_ROUTE = '/api/dsh-token-metrics/supplier/models'
  const BUDGET_ROUTE = '/api/dsh-token-metrics/budget'
  const SUPPLIER_SYNC_ROUTE = '/api/dsh-token-metrics/supplier/sync'
  const PRICING_MULTIPLIER_ROUTE2 = '/api/dsh-token-metrics/pricing/multiplier'

    const name = 'dsh-token-metrics-client'
    // 只声明真正使用的服务：slots 承载两个注册，locale 提供文案。
    // 不声明 layout —— 侧边栏条目的 id 本身就是 main 面板的 key，
    // 宿主自己负责切换，插件不需要主动 selectPanel。
    const inject = ['slots', 'locale']

    //#region 文案

    const zh = {
      'panel.title': 'Token 用量统计',
      'panel.subtitle': '统计所有经过 dsh 的模型调用',
      'range.today': '今日',
      'range.week': '近 7 天',
      'range.all': '全部',
      'filter.model': '模型',
      'filter.allModels': '全部模型',
      'filter.pickModels': '选择模型',
      'filter.selectedCount': '已选',
      'filter.clear': '清除选择',
      'field.total': '总量',
      'field.cost': '总成本',
      'budget.daily': '今日预算',
      'budget.monthly': '本月预算',
      'budget.used': '已用',
      'budget.left': '剩',
      'budget.over': '已超',
      'budget.set': '设置预算',
      'budget.title': '预算管理',
      'budget.subtitle': '给花销一个参照系：今天用了多少、还剩多少，心里有数才好规划',
      'budget.global': '全局预算',
      'budget.dailyLabel': '每日预算（USD）',
      'budget.monthlyLabel': '每月预算（USD）',
      'budget.dailyHint': '留空或 0 表示不启用',
      'budget.monthlyHint': '留空或 0 表示不启用',
      'budget.warnLabel': '提醒阈值（%）',
      'budget.warnHint': '已用超过这个比例时提醒，默认 80',
      'budget.groupsTitle': '按模型分组',
      'budget.groupsHint': '一个分组可包含单个或多个模型，组内额度是这些模型的合计',
      'budget.addGroup': '添加分组',
      'budget.groupName': '分组名称',
      'budget.groupModels': '包含的模型',
      'budget.groupModelsHint': '从已有模型中选，可多选',
      'budget.groupDaily': '每日（USD）',
      'budget.groupMonthly': '每月（USD）',
      'budget.removeGroup': '删除分组',
      'budget.save': '保存预算',
      'budget.saved': '已保存',
      'budget.emptyModels': '还没有可选的模型',
      'budget.noGroups': '还没有分组。给某几个模型单独设额度时再添加。',
      'heat.title': '活动热力图',
      'heat.subtitle': '过去一年每天用了多少，颜色越深用得越多',
      'heat.less': '少',
      'heat.more': '多',
      'heat.click': '点击某天可筛选当天数据',
      'heat.today': '今天',
      'heat.days': '活跃天数',
      'heat.average': '日均',
      'heat.peak': '单日峰值',
      'heat.ttft': '首字延迟',
      'heat.tps': '输出速度',
      'balance.title': '供应商余额',
      'view.stats': '统计',
      'view.suppliers': '模型接入',
      'view.budget': '预算',
      'supplier.title': '模型接入',
      'supplier.subtitle': '接入第三方中转站与官方平台：余额、可用模型，并同步到 DSH 模型配置',
      'supplier.add': '添加供应商',
      'supplier.added': '已添加',
      'supplier.discovered': '可添加',
      'supplier.models': '个模型',
      'models.title': '可用模型',
      'models.empty': '该供应商还没有配置模型。点「编辑」添加。',
      'models.inDsh': '已写入 DSH',
      'models.context': '上下文',
      'models.maxOutput': '输出上限',
      'models.thinking': '思考档位',
      'models.copy': '复制 ID',
      'models.copied': '已复制',
      'models.viewTitle': '点击查看可用模型',
      'supplier.default': '默认',
      'supplier.current': '当前默认',
      'supplier.setDefault': '设为默认',
      'supplier.balance': '余额',
      'supplier.edit': '编辑',
      'supplier.sync': '同步到 DSH',
      'supplier.syncing': '同步中…',
      'supplier.synced': '已同步',
      'supplier.empty': '还没有供应商。可以从下方「可添加」里选一个，或手动添加。',
      'supplier.formTitle': '添加供应商',
      'supplier.formEdit': '编辑供应商',
      'supplier.name': '名称',
      'supplier.baseUrl': '接口地址',
      'supplier.apiKey': 'API 密钥',
      'supplier.apiFormat': '接口格式',
      'supplier.apiHint': '按上游实际协议选择，选错会导致调用失败',
      'api.openai-completions': 'OpenAI Chat Completions',
      'api.openai-responses': 'OpenAI Responses',
      'api.anthropic-messages': 'Anthropic Messages',
      'supplier.fetchModels': '获取列表',
      'supplier.fetching': '获取中…',
      'supplier.modelList': '该服务的模型',
      'supplier.modelSettings': '模型设置',
      'supplier.selected': '已选',
      'supplier.alias': '别名',
      'supplier.context': '上下文窗口',
      'supplier.maxOutput': '最大输出',
      'supplier.reasoning': '思考等级',
      'supplier.noModels': '还没有选择模型。先在左侧列表里勾选。',
      'supplier.needUrl': '填写地址后即可获取模型列表。',
      'supplier.save': '保存',
      'supplier.saveAndSync': '保存并同步',
      'supplier.cancel': '取消',
      'supplier.remove': '移除',
      'supplier.keyHint': '密钥只保存在 DSH 凭据里，不会写入配置文件，也不会显示在此页面。',
      'supplier.syncOk': '已同步到 DSH 模型配置',
      'supplier.syncFail': '同步失败',
      'supplier.fetchFail': '获取模型列表失败',
      'supplier.probeAll': '刷新全部余额',
      'supplier.groupBasic': '基础信息',
      'supplier.service': '服务',
      'supplier.required': '必填',
      'err.nameRequired': '请填写名称',
      'err.urlRequired': '请填写接口地址',
      'err.urlInvalid': '接口地址必须以 http:// 或 https:// 开头',
      'err.keyRequired': '请填写 API 密钥（编辑时留空表示沿用已保存的）',
      'err.modelsRequired': '请至少选择一个模型，否则无法写入 DSH 配置',
      'err.serviceRequired': '请选择服务类型',
      'err.dupId': '已存在同名的供应商，请换个名称',
      'supplier.serviceHint': '选择服务后会自动填好地址与接口格式',
      'supplier.servicePick': '选择服务',
      'supplier.customEndpoint': '自定义端点',
      'supplier.balanceCap': '余额查询',
      'supplier.quotaCap': '用量与限额查询',
      'supplier.balanceYes': '支持',
      'supplier.balanceNo': '不支持',
      'supplier.balanceAdmin': '需管理员密钥',
      'supplier.balanceOauth': '需账号登录态',
      'supplier.keyHintLabel': '凭据要求',
      'supplier.groupService': '服务与凭据',
      'supplier.groupModels': '模型选择',
      'supplier.optional': '可选',
      'supplier.keyPlaceholder': '粘贴访问令牌，留空则沿用已保存的',
      'supplier.urlPlaceholder': 'https://api.example.com/v1',
      'supplier.namePlaceholder': '例如：某某中转站',
      'supplier.searchModel': '搜索模型 ID…',
      'supplier.noResult': '没有匹配的模型',
      'supplier.fetchHint': '填好地址和密钥后点「获取列表」，从服务端拉取可用模型。',
      'supplier.pickHint': '勾选需要的模型，右侧可为每个模型设置别名与容量。',
      'supplier.syncExplain': '「保存并同步」会把该供应商写入 DSH 的模型配置，之后就能在选择器里直接选它的模型。',
      'supplier.editing': '编辑中',
      'supplier.addNew': '新建',
      'supplier.secretNote': '密钥经 DSH 凭据服务保存，不会写进配置文件，也不会回显。',
      'supplier.preset': '常用',
      'supplier.custom': '自定义',
      'supplier.thinking': '思考',
      'supplier.attach': '附件',
      'supplier.attachImage': '图片',
      'supplier.attachPdf': 'PDF',
      'supplier.addCustomModel': '手动添加模型 ID',
      'supplier.customModelPlaceholder': '如 my-model-v2',
      'supplier.add': '添加',
      'supplier.capacity': '容量',
      'supplier.noCapacity': '未声明',
      'supplier.modelCountHint': '勾选后会写入 DSH 模型配置；未勾选的模型不会出现在选择器里。',
      'supplier.pickOne': '在左侧选一个模型来设置它的参数',
      'supplier.notPicked': '未勾选',
      'supplier.picked': '已勾选（未配置参数）',
      'supplier.ready': '已配置',
      'supplier.autoDetected': '端点报告',
      'supplier.fromCatalog': '目录',
      'supplier.notReasoning': '该模型不是推理模型（目录判定）',
      'supplier.levelsFromCatalog': '目录推荐的档位已勾选，也可自行增删',
      'supplier.levelsRecommended': '目录推荐',
      'supplier.levelsAll': '全部档位',
      'supplier.levelsManual': '目录未给出档位，请按模型实际能力勾选',
      'supplier.levelsShowAll': '显示全部档位',
      'supplier.levelsHideAll': '只看推荐',
      'supplier.wire': '协议值',
      'supplier.wireHint': '网关不认档位名时，在这里填它实际接受的词（如 ultra）',
      'supplier.wireSame': '同档位名',
      'supplier.noCatalogEntry': '目录里没有这个模型，档位请手动确认',
      'supplier.adopt': '采用',
      'supplier.pickHint': '勾选后才会写入 DSH 配置',
      'supplier.contextHint': '模型能接受的最大输入长度',
      'supplier.outputHint': '单次回复的最大 token 数',
      'supplier.thinkingHint': '勾选模型支持的思考档位，对话里就能在这些档位间切换',
      'supplier.thinkingNone': '未声明（非推理模型）',
      'supplier.thinkingPick': '勾选该模型支持的档位',
      'level.off': '关闭',
      'level.minimal': '极简',
      'level.low': '低',
      'level.medium': '中',
      'level.high': '高',
      'level.xhigh': '超高',
      'level.max': '最高',
      'supplier.attachHint': '该模型支持的输入类型',
      'supplier.autoDispatch': '可供 AI 自动调度',
      'supplier.setBalance': '手动填写余额',
      'supplier.balanceUsd': '余额（USD）',
      'quota.used': '已用',
      'quota.left': '剩余',
      'quota.resetsIn': '后重置',
      'quota.resetAt': '重置于',
      'quota.expired': '数据已过期，请刷新',
      'unit.day': '天',
      'unit.hour': '小时',
      'unit.minute': '分',
      'quota.exhausted': '已用尽',
      'quota.noPlan': '无订阅',
      'quota.official': '官方余额',
      'quota.balanceOnly': '余额',
      'kind.balance': '余额',
      'kind.quota': '订阅额度',
      'kind.balanceHint': '预充值，按用量扣减',
      'kind.quotaHint': '订阅制，按时间窗口限流',
      'supplier.balanceSaved': '余额已保存',
      'supplier.probeUnsupported': '该站点没有标准的余额接口，可手动填写余额',
      'balance.add': '添加站点',
      'balance.empty': '还没有配置任何站点。可以从下面自动发现的地址一键添加，或手动填写。',
      'balance.discovered': '自动发现的站点',
      'balance.adopt': '添加',
      'balance.probe': '查询余额',
      'balance.probeQuota': '刷新用量',
      'balance.probeQuotaHint': '订阅制按时间窗口限流，没有「余额」概念，这里刷新的是各窗口的用量',
      'balance.probing': '查询中…',
      'balance.remove': '移除',
      'balance.remaining': '剩余',
      'balance.used': '已用',
      'balance.limit': '总额度',
      'balance.noData': '尚未查询',
      'balance.lastChecked': '查询于',
      'balance.manual': '手动配置',
      'balance.name': '名称',
      'balance.baseUrl': '站点地址',
      'balance.keyEnv': '密钥环境变量',
      'balance.keyHint': '插件不会保存密钥。请在环境变量或 DSH 凭据里配置，这里只填变量名。',
      'balance.save': '保存',
      'balance.cancel': '取消',
      'balance.error': '查询失败',
      'balance.kind': '类型',
      'currency.usd': 'USD',
      'currency.cny': 'RMB',
      'currency.toggleTitle': '点击换算为人民币 / 美元',
      'cost.unpriced': '未定价',
      'cost.priced': '已定价',
      'cost.overrideTitle': '补价',
      'cost.overrideHint': '填每百万 token 的美元单价，留空表示恢复自动匹配',
      'cost.inputPerM': '输入 $/M',
      'cost.outputPerM': '输出 $/M',
      'cost.save': '保存',
      'cost.remove': '恢复自动',
      'cost.refresh': '刷新价目表',
      'cost.refreshHint': '从 LiteLLM 拉取最新价目表与汇率',
      'cost.status': '价目表',
      'cost.models': '个模型',
      'cost.updatedAt': '更新于',
      'cost.fx': '汇率',
      'cost.neverUpdated': '尚未更新',
      'cost.multiplier': '倍率',
      'alias.title': '模型别名',
      'alias.hint': '部分供应商上报的是内部代号（如 Qoder 的 qfmodel），不是真实模型名。填写真实模型名后，所有视图都会按它显示。',
      'alias.raw': '原始代号',
      'alias.display': '显示为',
      'alias.save': '保存',
      'alias.remove': '清除',
      'alias.none': '暂无可设置的别名。',
      'alias.manage': '管理别名',
      'column.cost': '成本',
      'column.ttft': '首字',
      'column.tps': '速度',
      'field.input': '输入',
      'field.output': '输出',
      'field.cacheRead': '缓存读',
      'field.cacheWrite': '缓存写',
      'field.avgTtft': '平均首字',
      'field.reasoning': '推理',
      'field.calls': '调用次数',
      'section.byModel': '按模型',
      'section.byProvider': '按供应商',
      'section.byDay': '按日期',
      'section.bySession': '按会话',
      'field.cacheHitRate': '缓存命中率',
      'chart.title': '用量趋势',
      'chart.mode.total': '总量',
      'chart.mode.cache': '命中率',
      'chart.mode.cost': '成本',
      'chart.mode.compose': '构成',
      'chart.mode.model': '按模型',
      'chart.modelDisabled': '先在「模型」下拉里选择一个或多个模型，再切到「按模型」查看各模型曲线',
      'chart.groupRest': '其他',
      'chart.pie.share': '占比',
      'chart.tip.total': '总量',
      'chart.tip.cache': '命中率',
      'table.tabs': '明细视图',
      'table.model': '模型',
      'table.provider': '供应商',
      'table.project': '项目',
      'table.origin': '来源',
      'table.day': '按日期',
      'pager.prev': '上一页',
      'pager.next': '下一页',
      'pager.info': '第',
      'pager.of': '/',
      'pager.pages': '页',
      'pager.rows': '条',
      'day.from': '起',
      'day.to': '止',
      'day.clear': '全部日期',
      'day.range': '日期范围',
      'table.account': '账号',
      'chart.pie.title': '模型用量占比',
      'chart.pie.total': '总计',
      'chart.pie.rest': '其他',
      'chart.trend': '每日用量趋势',
      'chart.stacked': '输入构成（堆积）',
      'chart.cache': '缓存命中趋势',
      'chart.legend.input': '新输入',
      'chart.legend.cacheRead': '缓存命中',
      'chart.legend.output': '输出',
      'chart.empty': '数据不足以绘制图表',
      'chart.points': '天',
      'sessions.hidden': '「按会话」明细已隐藏（可在插件配置里打开 showSessions）',
      'section.byProject': '按项目',
      'section.byOrigin': '按来源',
      'section.accounts': '账号用量',
      'column.project': '项目目录',
      'column.origin': '来源',
      'column.account': '账号',
      'column.firstSeen': '首次记录',
      'origin.main': '主会话',
      'origin.subagent': '子代理',
      'origin.workflow': 'Workflow',
      'account.current': '当前登录',
      'account.none': '未登录',
      'account.unknown': '未知（历史数据无账号信息）',
      'account.currentNoName': '当前登录账号',
      'account.otherAccount': '其他账号（{id}）',
      'account.balance': '余额',
      'account.usagePage': '查看官方用量',
      'account.topUp': '充值',
      'account.note': '日志不含账号归属，切换账号前的历史数据无法回溯；此处仅区分切换后的用量。',
      'failed.title': '失败请求',
      'failed.count': '失败次数',
      'failed.billable': '已计费失败',
      'failed.note': '当前适配器在失败路径上报全 0 的 usage，因此失败请求通常只有次数、没有 token 计入。若上游开始上报，这里会自动出现用量。',
      'failed.tokens': '失败消耗',
      'version.label': '版本',
      'version.current': '当前',
      'version.latest': '最新',
      'version.upToDate': '已是最新',
      'version.check': '检查更新',
      'version.checking': '检查中…',
      'version.update': '更新并重载',
      'version.updating': '更新中…',
      'version.reload': '重载插件',
      'version.star': '点个 Star',
      'version.starTitle': '到 GitHub 给这个插件点个 Star',
      'version.reloadWhy': '磁盘上的代码已更新，但运行中的仍是旧版本——点此加载新代码',
      'version.dotNew': '有新版本可用',
      'version.dotOk': '已是最新',
      'version.dotUnknown': '点击检查更新',
      'version.checkTitle': '版本检查',
      'version.newBody': '发现新版本，是否现在更新并重载？',
      'version.sameBody': '当前已是最新版本。',
      'version.dialogUpdate': '更新并重载',
      'version.dialogLater': '稍后',
      'version.dialogOk': '知道了',
      'version.notes': '更新说明',
      'version.progressDownload': '正在下载新版本…',
      'version.progressInstall': '正在替换文件…',
      'version.progressActivate': '正在热重载…',
      'version.success': '更新成功',
      'version.successBody': '已升级到',
      'version.noNotes': '（本次无更新说明）',
      'version.reinstallTitle': '需要重新安装',
      'version.reinstallHint': '插件管理 → 卸载本插件 → 重新安装最新版本。统计数据保存在本地，卸载不会丢失。',
      'version.reinstallOk': '我知道了',
      'version.checkFailed': '检查更新失败',
      'version.reloading': '重载中…',
      'version.notes': '更新说明',
      'version.done': '更新完成，已重载',
      'version.failed': '操作失败',
      'refresh.label': '自动刷新',
      'refresh.off': '关闭',
      'refresh.10s': '10 秒',
      'refresh.30s': '30 秒',
      'refresh.60s': '1 分钟',
      'refresh.5m': '5 分钟',
      'column.model': '模型',
      'column.provider': '供应商',
      'column.providerKind': '供应商类别',
      'providerKind.apikey': '官方 API Key',
      'providerKind.balance': '余额',
      'providerKind.unknown': '其他',
      'column.date': '日期',
      'column.session': '会话',
      'column.lastUsed': '最近使用',
      'empty': '还没有记录到任何模型调用。发一条消息后再回来看看。',
      'loading': '正在读取…',
      'scan.title': '正在扫描历史会话',
      'scan.hint': '首次安装需要把已有的会话日志补算进来，请稍候…',
      'scan.progress': '已扫描',
      'scan.done': '历史补算完成',
      'error': '读取统计失败',
      'retry': '重试',
      'refresh': '刷新',
      'refreshing': '刷新中…',
      'updatedAt': '更新于',
      'storePath': '数据文件',
      'scanned': '已回扫会话',
      'noTitle': '（未命名会话）',
      'integrityWarn': '数据自检未通过：计数与去重记录不一致，建议重启 DSH 后重建。',
    }

    const en = {
      'panel.title': 'Token Usage Stats',
      'panel.subtitle': 'Every model call routed through dsh',
      'range.today': 'Today',
      'range.week': 'Last 7 days',
      'range.all': 'All time',
      'filter.model': 'Model',
      'filter.allModels': 'All models',
      'filter.pickModels': 'Pick models',
      'filter.selectedCount': 'selected',
      'filter.clear': 'Clear',
      'field.total': 'Total',
      'field.cost': 'Cost',
      'budget.daily': 'Daily budget',
      'budget.monthly': 'Monthly budget',
      'budget.used': 'used',
      'budget.left': 'left',
      'budget.over': 'over',
      'budget.set': 'Set budget',
      'budget.title': 'Budget',
      'budget.subtitle': 'Give your spending a reference point: how much today, how much left.',
      'budget.global': 'Global budget',
      'budget.dailyLabel': 'Daily budget (USD)',
      'budget.monthlyLabel': 'Monthly budget (USD)',
      'budget.dailyHint': 'Leave empty or 0 to disable',
      'budget.monthlyHint': 'Leave empty or 0 to disable',
      'budget.warnLabel': 'Warn threshold (%)',
      'budget.warnHint': 'Warn when usage exceeds this share; default 80',
      'budget.groupsTitle': 'Per-model groups',
      'budget.groupsHint': 'A group holds one or more models; its limit is their combined budget',
      'budget.addGroup': 'Add group',
      'budget.groupName': 'Group name',
      'budget.groupModels': 'Models',
      'budget.groupModelsHint': 'Pick from your models; multi-select',
      'budget.groupDaily': 'Daily (USD)',
      'budget.groupMonthly': 'Monthly (USD)',
      'budget.removeGroup': 'Remove group',
      'budget.save': 'Save budget',
      'budget.saved': 'Saved',
      'budget.emptyModels': 'No models available yet',
      'budget.noGroups': 'No groups yet. Add one to budget specific models separately.',
      'heat.title': 'Activity heatmap',
      'heat.subtitle': 'Daily usage over the past year; darker means more',
      'heat.less': 'less',
      'heat.more': 'more',
      'heat.click': 'Click a day to filter to it',
      'heat.today': 'today',
      'heat.days': 'Active days',
      'heat.average': 'Daily avg',
      'heat.peak': 'Peak day',
      'heat.ttft': 'First token',
      'heat.tps': 'Output speed',
      'balance.title': 'Provider balance',
      'view.stats': 'Stats',
      'view.suppliers': 'Model Access',
      'view.budget': 'Budget',
      'supplier.title': 'Model Access',
      'supplier.subtitle': 'Add relay stations and official platforms: balances, models, and DSH config sync',
      'supplier.add': 'Add supplier',
      'supplier.added': 'Added',
      'supplier.discovered': 'Available',
      'supplier.models': 'models',
      'models.title': 'Available models',
      'models.empty': 'No models configured for this supplier yet. Click "Edit" to add some.',
      'models.inDsh': 'in DSH',
      'models.context': 'Context',
      'models.maxOutput': 'Max output',
      'models.thinking': 'Thinking',
      'models.copy': 'Copy ID',
      'models.copied': 'Copied',
      'models.viewTitle': 'Click to view models',
      'supplier.default': 'Default',
      'supplier.current': 'Current default',
      'supplier.setDefault': 'Set default',
      'supplier.balance': 'Balance',
      'supplier.edit': 'Edit',
      'supplier.sync': 'Sync to DSH',
      'supplier.syncing': 'Syncing…',
      'supplier.synced': 'Synced',
      'supplier.empty': 'No suppliers yet. Pick one from "Available" below, or add manually.',
      'supplier.formTitle': 'Add supplier',
      'supplier.formEdit': 'Edit supplier',
      'supplier.name': 'Name',
      'supplier.baseUrl': 'Base URL',
      'supplier.apiKey': 'API key',
      'supplier.apiFormat': 'Interface format',
      'supplier.apiHint': 'Pick the protocol the endpoint actually speaks; a mismatch breaks calls',
      'api.openai-completions': 'OpenAI Chat Completions',
      'api.openai-responses': 'OpenAI Responses',
      'api.anthropic-messages': 'Anthropic Messages',
      'supplier.fetchModels': 'Fetch list',
      'supplier.fetching': 'Fetching…',
      'supplier.modelList': 'Models offered',
      'supplier.modelSettings': 'Model settings',
      'supplier.selected': 'selected',
      'supplier.alias': 'Alias',
      'supplier.context': 'Context window',
      'supplier.maxOutput': 'Max output',
      'supplier.reasoning': 'Reasoning',
      'supplier.noModels': 'No models selected yet. Pick them from the list on the left.',
      'supplier.needUrl': 'Enter a URL to fetch the model list.',
      'supplier.save': 'Save',
      'supplier.saveAndSync': 'Save and sync',
      'supplier.cancel': 'Cancel',
      'supplier.remove': 'Remove',
      'supplier.keyHint': 'Keys are stored only in DSH credentials, never in config files, and never shown on this page.',
      'supplier.syncOk': 'Synced to DSH model config',
      'supplier.syncFail': 'Sync failed',
      'supplier.fetchFail': 'Could not fetch model list',
      'supplier.probeAll': 'Refresh all balances',
      'supplier.groupBasic': 'Basics',
      'supplier.service': 'Service',
      'supplier.required': 'required',
      'err.nameRequired': 'Please enter a name',
      'err.urlRequired': 'Please enter the base URL',
      'err.urlInvalid': 'Base URL must start with http:// or https://',
      'err.keyRequired': 'Please enter the API key (leave blank when editing to keep the saved one)',
      'err.modelsRequired': 'Select at least one model, otherwise the DSH config cannot be written',
      'err.serviceRequired': 'Please pick a service',
      'err.dupId': 'A supplier with this name already exists',
      'supplier.serviceHint': 'Picking a service fills in the URL and protocol',
      'supplier.servicePick': 'Select a service',
      'supplier.customEndpoint': 'Custom endpoint',
      'supplier.balanceCap': 'Balance',
      'supplier.quotaCap': 'Usage & quota',
      'supplier.balanceYes': 'supported',
      'supplier.balanceNo': 'not supported',
      'supplier.balanceAdmin': 'needs admin key',
      'supplier.balanceOauth': 'needs sign-in',
      'supplier.keyHintLabel': 'Credential',
      'supplier.groupService': 'Service & credentials',
      'supplier.groupModels': 'Model selection',
      'supplier.optional': 'optional',
      'supplier.keyPlaceholder': 'Paste the token; leave blank to keep the saved one',
      'supplier.urlPlaceholder': 'https://api.example.com/v1',
      'supplier.namePlaceholder': 'e.g. My relay station',
      'supplier.searchModel': 'Search model ID…',
      'supplier.noResult': 'No matching models',
      'supplier.fetchHint': 'Fill in the URL and key, then click "Fetch list" to load models from the endpoint.',
      'supplier.pickHint': 'Tick the models you need; set an alias and capacity for each on the right.',
      'supplier.syncExplain': '"Save and sync" writes this supplier into the DSH model config so its models appear in the picker.',
      'supplier.editing': 'Editing',
      'supplier.addNew': 'New',
      'supplier.secretNote': 'The key is stored via DSH credentials; it is never written to config files or echoed back.',
      'supplier.preset': 'Presets',
      'supplier.custom': 'Custom',
      'supplier.thinking': 'Thinking',
      'supplier.attach': 'Attachments',
      'supplier.attachImage': 'Image',
      'supplier.attachPdf': 'PDF',
      'supplier.addCustomModel': 'Add model ID manually',
      'supplier.customModelPlaceholder': 'e.g. my-model-v2',
      'supplier.add': 'Add',
      'supplier.capacity': 'Capacity',
      'supplier.noCapacity': 'not declared',
      'supplier.modelCountHint': 'Checked models are written to the DSH model config; unchecked ones never appear in the picker.',
      'supplier.pickOne': 'Pick a model on the left to configure it',
      'supplier.notPicked': 'not selected',
      'supplier.picked': 'selected (no params yet)',
      'supplier.ready': 'configured',
      'supplier.autoDetected': 'endpoint reports',
      'supplier.fromCatalog': 'catalog',
      'supplier.notReasoning': 'Not a reasoning model (per catalog)',
      'supplier.levelsFromCatalog': 'Catalog-recommended levels are ticked; you can add or remove any',
      'supplier.levelsRecommended': 'recommended',
      'supplier.levelsAll': 'all levels',
      'supplier.levelsManual': 'The catalog lists no levels; tick what the model actually supports',
      'supplier.levelsShowAll': 'Show all levels',
      'supplier.levelsHideAll': 'Recommended only',
      'supplier.wire': 'Wire value',
      'supplier.wireHint': 'If the gateway uses a different word (e.g. ultra), set it here',
      'supplier.wireSame': 'same as level',
      'supplier.noCatalogEntry': 'Not in the catalog — please set levels manually',
      'supplier.adopt': 'use it',
      'supplier.pickHint': 'Only checked models are written to the DSH config',
      'supplier.contextHint': 'Maximum input length the model accepts',
      'supplier.outputHint': 'Maximum tokens per reply',
      'supplier.thinkingHint': 'Tick the levels this model supports; chat will offer them',
      'supplier.thinkingNone': 'not declared (non-reasoning model)',
      'supplier.thinkingPick': 'Tick the levels this model supports',
      'level.off': 'off',
      'level.minimal': 'minimal',
      'level.low': 'low',
      'level.medium': 'medium',
      'level.high': 'high',
      'level.xhigh': 'xhigh',
      'level.max': 'max',
      'supplier.attachHint': 'Input types this model accepts',
      'supplier.autoDispatch': 'Available for AI auto-dispatch',
      'supplier.setBalance': 'Set balance manually',
      'supplier.balanceUsd': 'Balance (USD)',
      'quota.used': 'used',
      'quota.left': 'left',
      'quota.resetsIn': 'until reset',
      'quota.resetAt': 'resets',
      'quota.expired': 'stale — refresh',
      'unit.day': 'd',
      'unit.hour': 'h',
      'unit.minute': 'm',
      'quota.exhausted': 'used up',
      'quota.noPlan': 'no plan',
      'quota.official': 'Official balance',
      'quota.balanceOnly': 'Balance',
      'kind.balance': 'Balance',
      'kind.quota': 'Subscription',
      'kind.balanceHint': 'Prepaid, deducted by usage',
      'kind.quotaHint': 'Subscription, rate-limited by time window',
      'supplier.balanceSaved': 'Balance saved',
      'supplier.probeUnsupported': 'This site has no standard balance endpoint; you can enter the balance manually',
      'balance.add': 'Add site',
      'balance.empty': 'No sites configured yet. Add one from the discovered endpoints below, or fill it in manually.',
      'balance.discovered': 'Discovered endpoints',
      'balance.adopt': 'Add',
      'balance.probe': 'Check balance',
      'balance.probeQuota': 'Refresh usage',
      'balance.probeQuotaHint': 'Subscription plans are rate-limited by time window; this refreshes per-window usage, not a balance',
      'balance.probing': 'Checking…',
      'balance.remove': 'Remove',
      'balance.remaining': 'Remaining',
      'balance.used': 'Used',
      'balance.limit': 'Limit',
      'balance.noData': 'Not checked yet',
      'balance.lastChecked': 'Checked',
      'balance.manual': 'Manual setup',
      'balance.name': 'Name',
      'balance.baseUrl': 'Base URL',
      'balance.keyEnv': 'Key env var',
      'balance.keyHint': 'Keys are never stored by this plugin. Configure them in the environment or DSH credentials; enter only the variable name here.',
      'balance.save': 'Save',
      'balance.cancel': 'Cancel',
      'balance.error': 'Check failed',
      'balance.kind': 'Type',
      'currency.usd': 'USD',
      'currency.cny': 'RMB',
      'currency.toggleTitle': 'Click to switch between USD and RMB',
      'cost.unpriced': 'Unpriced',
      'cost.priced': 'Priced',
      'cost.overrideTitle': 'Set price',
      'cost.overrideHint': 'USD per million tokens; leave blank to restore auto matching',
      'cost.inputPerM': 'Input $/M',
      'cost.outputPerM': 'Output $/M',
      'cost.save': 'Save',
      'cost.remove': 'Restore auto',
      'cost.refresh': 'Refresh price table',
      'cost.refreshHint': 'Fetch the latest price table and FX rate from LiteLLM',
      'cost.status': 'Price table',
      'cost.models': 'models',
      'cost.updatedAt': 'Updated',
      'cost.fx': 'FX',
      'cost.neverUpdated': 'never',
      'cost.multiplier': 'Multiplier',
      'alias.title': 'Model aliases',
      'alias.hint': 'Some providers report internal codes (e.g. Qoder\'s qfmodel) instead of real model names. Set the real name here and every view will use it.',
      'alias.raw': 'Raw code',
      'alias.display': 'Show as',
      'alias.save': 'Save',
      'alias.remove': 'Clear',
      'alias.none': 'No aliases to configure.',
      'alias.manage': 'Manage aliases',
      'column.cost': 'Cost',
      'column.ttft': 'TTFT',
      'column.tps': 'TPS',
      'field.input': 'Input',
      'field.output': 'Output',
      'field.cacheRead': 'Cache read',
      'field.cacheWrite': 'Cache write',
      'field.avgTtft': 'Avg TTFT',
      'field.reasoning': 'Reasoning',
      'field.calls': 'Calls',
      'section.byModel': 'By model',
      'section.byProvider': 'By provider',
      'section.byDay': 'By day',
      'section.bySession': 'By session',
      'field.cacheHitRate': 'Cache hit rate',
      'chart.title': 'Usage trend',
      'chart.mode.total': 'Total',
      'chart.mode.cache': 'Hit rate',
      'chart.mode.cost': 'Cost',
      'chart.mode.compose': 'Composition',
      'chart.mode.model': 'By model',
      'chart.modelDisabled': 'Pick one or more models in the filter first, then switch to "By model"',
      'chart.groupRest': 'Other',
      'chart.pie.share': 'Share',
      'chart.tip.total': 'Total',
      'chart.tip.cache': 'Hit rate',
      'table.tabs': 'Detail views',
      'table.model': 'Model',
      'table.provider': 'Provider',
      'table.project': 'Project',
      'table.origin': 'Origin',
      'table.day': 'By day',
      'pager.prev': 'Prev',
      'pager.next': 'Next',
      'pager.info': 'Page',
      'pager.of': 'of',
      'pager.pages': '',
      'pager.rows': 'rows',
      'day.from': 'From',
      'day.to': 'To',
      'day.clear': 'All dates',
      'day.range': 'Date range',
      'table.account': 'Account',
      'chart.pie.title': 'Model share',
      'chart.pie.total': 'Total',
      'chart.pie.rest': 'Other',
      'chart.trend': 'Daily usage trend',
      'chart.stacked': 'Input composition (stacked)',
      'chart.cache': 'Cache hit trend',
      'chart.legend.input': 'Fresh input',
      'chart.legend.cacheRead': 'Cache hits',
      'chart.legend.output': 'Output',
      'chart.empty': 'Not enough data to draw a chart',
      'chart.points': 'days',
      'sessions.hidden': 'Per-session details are hidden (enable showSessions in the plugin config)',
      'section.byProject': 'By project',
      'section.byOrigin': 'By origin',
      'section.accounts': 'Account usage',
      'column.project': 'Project directory',
      'column.origin': 'Origin',
      'column.account': 'Account',
      'column.firstSeen': 'First seen',
      'origin.main': 'Main',
      'origin.subagent': 'Subagent',
      'origin.workflow': 'Workflow',
      'account.current': 'Signed in',
      'account.none': 'Signed out',
      'account.unknown': 'Unknown (history has no account info)',
      'account.currentNoName': 'Current account',
      'account.otherAccount': 'Other account ({id})',
      'account.balance': 'Balance',
      'account.usagePage': 'Official usage',
      'account.topUp': 'Top up',
      'account.note': 'Session logs carry no account attribution, so history from before a switch cannot be reassigned; only usage after the switch is separated here.',
      'failed.title': 'Failed requests',
      'failed.count': 'Failures',
      'failed.billable': 'Billed failures',
      'failed.note': 'Adapters currently report all-zero usage on the failure path, so failed requests usually contribute only a count, no tokens. If an upstream starts reporting, usage appears here automatically.',
      'failed.tokens': 'Failed tokens',
      'version.label': 'Version',
      'version.current': 'Current',
      'version.latest': 'Latest',
      'version.upToDate': 'Up to date',
      'version.check': 'Check for updates',
      'version.checking': 'Checking…',
      'version.update': 'Update & reload',
      'version.updating': 'Updating…',
      'version.reload': 'Reload plugin',
      'version.star': 'Star',
      'version.starTitle': 'Star this plugin on GitHub',
      'version.reloadWhy': 'Files on disk changed but the running code is still the old version',
      'version.dotNew': 'Update available',
      'version.dotOk': 'Up to date',
      'version.dotUnknown': 'Click to check',
      'version.checkTitle': 'Version check',
      'version.newBody': 'A new version is available. Update and reload now?',
      'version.sameBody': 'You are on the latest version.',
      'version.dialogUpdate': 'Update and reload',
      'version.dialogLater': 'Later',
      'version.dialogOk': 'OK',
      'version.notes': 'Release notes',
      'version.progressDownload': 'Downloading the new version…',
      'version.progressInstall': 'Installing files…',
      'version.progressActivate': 'Hot reloading…',
      'version.success': 'Update complete',
      'version.successBody': 'Upgraded to',
      'version.noNotes': '(no release notes)',
      'version.reinstallTitle': 'Reinstall required',
      'version.reinstallHint': 'Plugins → uninstall this plugin → install the latest version again. Your usage data is stored locally and survives uninstall.',
      'version.reinstallOk': 'Got it',
      'version.checkFailed': 'Update check failed',
      'version.reloading': 'Reloading…',
      'version.notes': 'Release notes',
      'version.done': 'Updated and reloaded',
      'version.failed': 'Operation failed',
      'refresh.label': 'Auto refresh',
      'refresh.off': 'Off',
      'refresh.10s': '10s',
      'refresh.30s': '30s',
      'refresh.60s': '1 min',
      'refresh.5m': '5 min',
      'column.model': 'Model',
      'column.provider': 'Provider',
      'column.providerKind': 'Provider type',
      'providerKind.apikey': 'Official API Key',
      'providerKind.balance': 'Balance',
      'providerKind.unknown': 'Other',
      'column.date': 'Date',
      'column.session': 'Session',
      'column.lastUsed': 'Last used',
      'empty': 'No model calls recorded yet. Send a message and come back.',
      'loading': 'Loading…',
      'scan.title': 'Scanning past sessions',
      'scan.hint': 'First install backfills your existing session logs. This can take a moment.',
      'scan.progress': 'Scanned',
      'scan.done': 'Backfill complete',
      'error': 'Could not read usage',
      'retry': 'Retry',
      'refresh': 'Refresh',
      'refreshing': 'Refreshing…',
      'updatedAt': 'Updated',
      'storePath': 'Data file',
      'scanned': 'Sessions scanned',
      'noTitle': '(untitled session)',
      'integrityWarn': 'Self-check failed: counts disagree with the dedupe log. Restart DSH to rebuild.',
    }

    //#endregion

    //#region 样式

    /**
     * 页面样式。容器、表格、数值都继承宿主主题 token，因此亮/暗色、
     * 字号偏好都能自动跟随；只有图标是固定配色。
     */
    const STYLE_TEXT = `
/* 分类色：亮色模式用中饱和度，保证相邻色可区分且在白底上不刺眼；
   暗色模式整体提亮，避免低亮度色在深底上糊成一团。 */
.tu-root {
  --tu-c1: #3b7dd8;
  --tu-c2: #18a45f;
  --tu-c3: #e08a2a;
  --tu-c4: #d94a5a;
  --tu-c5: #8358c9;
  --tu-c6: #2aa5b0;
  --tu-c7: #8a7f64;
}
/* 分类色在深色下另取一套。
   选择器不只限定 .tu-root：弹窗与通知挂在 document.body 下，
   虽然它们当前只用语义 token，但放宽选择器可避免以后加分类色时踩坑。 */
[data-theme='dark'] .tu-root,
[data-theme='dark'] .tu-modal-backdrop,
[data-theme='dark'] .tu-toasts {
  --tu-c1: #66aaf0;
  --tu-c2: #47cf8c;
  --tu-c3: #f2b053;
  --tu-c4: #f0778a;
  --tu-c5: #ab8bef;
  --tu-c6: #52d0d9;
  --tu-c7: #b6ab8e;
}
.tu-root {
  height: 100%;
  overflow-y: auto;
  padding: 28px 32px 48px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  box-sizing: border-box;
}
.tu-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.tu-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.tu-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}
.tu-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.tu-button {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.tu-button:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
}
.tu-button:disabled { opacity: 0.55; cursor: default; }
.tu-refresh {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-refresh-label {
  white-space: nowrap;
}
.tu-select {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 7px;
  padding: 5px 9px;
  font-size: 12.5px;
  cursor: pointer;
}
.tu-select:hover {
  border-color: var(--dsw-alias-border-l2);
}
.tu-tabs {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  margin-bottom: 20px;
}
.tu-tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-radius: 6px;
  padding: 5px 14px;
  font-size: 13px;
  cursor: pointer;
}
.tu-tab[data-active='true'] {
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}
.tu-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 10px;
  margin-bottom: 26px;
}
.tu-card {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 11px;
  padding: 13px 15px;
}
.tu-card-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 6px;
  white-space: nowrap;
}
.tu-card-value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  word-break: break-all;
}
.tu-card[data-accent='true'] .tu-card-value {
  color: var(--dsw-alias-brand-primary);
}
.tu-section { margin-bottom: 26px; }
.tu-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 0 0 9px;
}
.tu-table-wrap {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
}
.tu-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tu-table th {
  text-align: right;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  padding: 9px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  white-space: nowrap;
  font-size: 12px;
}
.tu-table th:first-child, .tu-table td:first-child { text-align: left; }
.tu-table td {
  text-align: right;
  padding: 9px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tu-table tr:last-child td { border-bottom: 0; }
.tu-table tbody tr:hover td { background: var(--dsw-alias-bg-layer-2); }
.tu-table td.tu-cell-main {
  text-align: left;
  font-variant-numeric: normal;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tu-muted { color: var(--dsw-alias-label-secondary); }
.tu-note {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 18px;
  line-height: 1.7;
  display: flex;
  justify-content: flex-end;
}
.tu-note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 5px;
  padding: 1px 5px;
}
.tu-scan {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 12px 15px;
  margin-bottom: 16px;
}
.tu-scan-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}
.tu-scan-title {
  font-size: 13px;
  font-weight: 600;
}
.tu-scan-hint {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 2px;
  line-height: 1.6;
}
.tu-scan-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
}
.tu-scan-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary);
  transition: width 200ms ease;
}
/* 总数未知时用循环动画表示进行中，不假装有确定进度 */
.tu-scan-fill[data-indeterminate='true'] {
  width: 35%;
  animation: tu-scan-slide 1.1s ease-in-out infinite;
}
@keyframes tu-scan-slide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(320%); }
}
.tu-scan-meta {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 7px;
  font-variant-numeric: tabular-nums;
}
.tu-spinner {
  width: 13px;
  height: 13px;
  flex: none;
  margin-top: 2px;
  border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: tu-spin 720ms linear infinite;
}
@keyframes tu-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .tu-spinner { animation: none; }
  .tu-scan-fill[data-indeterminate='true'] { animation: none; width: 100%; }
}
.tu-balance {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.tu-balance-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.tu-balance-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.tu-balance-subtitle {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 8px;
}
.tu-balance-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.tu-balmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.tu-balmeta-time { margin-left: auto; }
.tu-kindtag {
  font-size: 10.5px;
  font-weight: 500;
  border-radius: 999px;
  padding: 1px 8px;
  line-height: 15px;
  flex: none;
}
.tu-kindtag[data-kind='balance'] {
  color: var(--dsw-alias-state-success-primary);
  border: 1px solid var(--dsw-alias-state-success-primary);
}
.tu-kindtag[data-kind='quota'] {
  color: var(--dsw-alias-state-warn-primary);
  border: 1px solid var(--dsw-alias-state-warn-primary);
}
.tu-balprovider {
  font-size: 10.5px;
  color: var(--dsw-alias-brand-primary);
  border: 1px solid var(--dsw-alias-brand-primary);
  border-radius: 999px;
  padding: 0 7px;
  line-height: 15px;
}
.tu-balnoplan {
  color: var(--dsw-alias-label-secondary);
  font-style: italic;
}

/* 配额窗口（Kimi / GLM 的 Coding Plan） */
.tu-quotas {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-bottom: 10px;
}
.tu-quota { display: flex; flex-direction: column; gap: 5px; }
.tu-quota-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
}
.tu-quota-label {
  color: var(--dsw-alias-label-secondary);
  font-weight: 600;
}
.tu-quota-pct {
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}
.tu-quota-bar {
  height: 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
}
.tu-quota-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 200ms ease;
}
/* 用绿/黄/红三色表达「充裕 / 吃紧 / 将尽」。
   之前 ok 档用 brand-primary，在亮色主题下是黑色——既不表意也不好看。 */
.tu-quota-fill[data-level='ok'] { background: var(--dsw-alias-state-success-primary); }
.tu-quota-fill[data-level='warn'] { background: var(--dsw-alias-state-warn-primary); }
.tu-quota-fill[data-level='danger'] { background: var(--dsw-alias-state-error-primary); }
.tu-quota-reset {
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.tu-serviceinfo {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: -4px 0 12px;
  font-size: 11.5px;
}
.tu-captag {
  border-radius: 999px;
  padding: 1px 8px;
  line-height: 16px;
  font-size: 11px;
}
.tu-captag-ok {
  color: var(--dsw-alias-state-success-primary);
  border: 1px solid var(--dsw-alias-state-success-primary);
}
.tu-captag-no {
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.tu-servicehint { color: var(--dsw-alias-label-secondary); }
.tu-balnoplan-note {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-balerror {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--dsw-alias-state-error-primary);
}
.tu-balance-discovered,
.tu-balform {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 13px 15px;
}
.tu-baldiscover {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.tu-baldiscover:first-of-type { border-top: none; }
.tu-baldiscover-name {
  font-size: 12.5px;
  font-weight: 600;
}
.tu-balform-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 10px 0 12px;
}
.tu-sheet {
  /* 之前 920x760 对「模型参数」这种信息量偏挤：左右两栏各自要塞下
     列表与多个字段。放大到 1120x880 后每栏宽裕些，纵向也不再频繁滚动。 */
  width: min(1120px, 96vw);
  max-height: min(92vh, 880px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 24px 70px -18px rgb(0 0 0 / 55%);
  overflow: hidden;
}
.tu-sheet-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 28px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
}
.tu-sheet-headings { min-width: 0; }
.tu-sheet-title { font-size: 15px; font-weight: 600; margin: 0 0 5px; }
.tu-sheet-sub {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
  max-width: 600px;
}
.tu-sheet-body {
  padding: 22px 28px 10px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
  scrollbar-width: thin;
}
.tu-sheet-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 28px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  flex: none;
}
.tu-sheet-foot-note {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tu-sheet-foot-actions { display: flex; gap: 8px; flex: none; }

/* 行/列：连接信息一次排开，不再切碎成两个分组 */
.tu-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.tu-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 0 1 200px; }
.tu-col-wide { flex: 1 1 260px; }
.tu-col-grow { flex: 2 1 320px; }
.tu-req {
  color: var(--dsw-alias-state-error-primary);
  margin-left: 2px;
  font-weight: 600;
}
.tu-flabel {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

/* 输入 */
.tu-input {
  appearance: none;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  /* 用 layer-2 而不是 base：base 在深色下是最暗的底色（950），
     放在弹窗（overlay=700）里会显得像被挖空的洞。
     layer-2 在深色下是 850、浅色下仍是白，两种主题都协调。 */
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  padding: 8px 11px;
  transition: border-color 130ms ease, box-shadow 130ms ease;
}
.tu-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: 0.6; }
.tu-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
}
.tu-input:disabled {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  opacity: 0.55;
  cursor: not-allowed;
}
.tu-input-xs { padding: 5px 8px; font-size: 12px; border-radius: 6px; }
.tu-select {
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 16px) 52%, calc(100% - 11px) 52%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 30px;
  cursor: pointer;
}

.tu-readonly {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  padding: 8px 11px;
  font-family: var(--dsw-alias-font-mono, monospace);
}
.tu-readonly-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  flex: none;
}
.tu-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 18px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  padding: 9px 12px;
}
.tu-note-icon { flex: none; opacity: 0.85; }

/* 模型区 */
.tu-sec { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 16px; }
.tu-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 11px;
  flex-wrap: wrap;
}
.tu-sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
}
.tu-sec-actions { display: flex; gap: 8px; align-items: center; }
.tu-sec-hint { margin: 9px 0 14px; }
.tu-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-brand-primary);
  border: 1px solid var(--dsw-alias-brand-primary);
  border-radius: 999px;
  padding: 0 7px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.tu-search { width: 200px; padding: 6px 10px; font-size: 12px; border-radius: 7px; }

/* 模型：左列表 + 右详情 */
.tu-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
  gap: 16px;
  min-height: 340px;
  max-height: 440px;
}
.tu-list-pane,
.tu-detail-pane {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
  overflow: hidden;
}
.tu-mlist {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  scrollbar-width: thin;
}
.tu-mlist-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: 7px;
  font-size: 12.5px;
  cursor: pointer;
  min-width: 0;
  border: 1px solid transparent;
  transition: background 110ms ease, border-color 110ms ease;
}
.tu-mlist-row:hover { background: var(--dsw-alias-bg-layer-2); }
.tu-mlist-row[data-picked='true'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);
}
.tu-mlist-row[data-active='true'] {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
}
.tu-mlist-id {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-alias-font-mono, monospace);
  font-size: 12px;
}
.tu-mlist-tag {
  flex: none;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 15px;
}
.tu-mlist-foot {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  flex: none;
}
.tu-mlist-foot .tu-input { font-size: 12px; padding: 6px 9px; }
.tu-mlist-foot .tu-btn-ghost { padding: 6px 11px; font-size: 14px; line-height: 1; }

/* 详情面板 */
.tu-detail {
  padding: 16px 18px;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  scrollbar-width: thin;
}
.tu-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.tu-detail-id {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-alias-font-mono, monospace);
  font-size: 12.5px;
  font-weight: 600;
}
.tu-dfield { display: flex; flex-direction: column; gap: 7px; }
.tu-dfield-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}
.tu-dfield-hint {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
}
.tu-input-sm { padding: 6px 9px; font-size: 12px; border-radius: 7px; }

/* 分段选择器：预设值一眼可选，比只给输入框好用 */
.tu-segmented { display: flex; gap: 4px; flex-wrap: wrap; }
.tu-seg {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1;
  padding: 5px 9px;
  border-radius: 7px;
  cursor: pointer;
  transition: all 110ms ease;
  font-variant-numeric: tabular-nums;
}
.tu-seg:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.tu-seg[data-active='true'] {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 600;
}
.tu-levels {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.tu-level {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  padding: 5px 9px;
  font-size: 11.5px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  transition: all 110ms ease;
}
.tu-level:hover { border-color: var(--dsw-alias-border-l2); }
/* 目录推荐的档位加一层淡背景，与「手动加的」区分开 */
.tu-level[data-rec='true']:not([data-on='true']) {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent);
}
.tu-wire {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 8px;
  align-items: flex-start;
}
.tu-wire-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.tu-wire-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}
.tu-wire-level {
  min-width: 56px;
  color: var(--dsw-alias-label-secondary);
}
.tu-wire-arrow { color: var(--dsw-alias-label-secondary); }
.tu-wire-row .tu-input { width: 130px; }
.tu-level-toggle {
  appearance: none;
  border: 1px dashed var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 11px;
  padding: 4px 9px;
  border-radius: 7px;
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease;
}
.tu-level-toggle:hover {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.tu-level[data-on='true'] {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
}
.tu-checks { display: flex; gap: 14px; flex-wrap: wrap; }
.tu-checkrow {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  cursor: pointer;
}

/* 空状态：给出下一步，而不是干瞪眼 */
.tu-empty-block {
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 11px;
  padding: 26px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: center;
}
.tu-empty-title { font-size: 12.5px; }
.tu-empty-hint {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
  max-width: 420px;
}
.tu-empty-action { display: flex; gap: 8px; margin-top: 6px; width: min(360px, 100%); }
.tu-center { text-align: center; margin: 16px auto; }
.tu-empty-inline {
  border: none;
  border-radius: 0;
  padding: 28px 18px;
  flex: 1 1 auto;
  justify-content: center;
}

.tu-checkbox {
  appearance: none;
  width: 14px; height: 14px;
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
  cursor: pointer;
  position: relative;
  transition: background 110ms ease, border-color 110ms ease;
}
.tu-checkbox:checked {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.tu-checkbox:checked::after {
  content: '';
  position: absolute;
  left: 4px; top: 1px;
  width: 4px; height: 8px;
  border: solid var(--dsw-alias-bg-base);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.tu-checkbox:disabled { opacity: 0.4; cursor: not-allowed; }

/* 按钮 */
.tu-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1;
  padding: 9px 15px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
  white-space: nowrap;
}
.tu-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.tu-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.tu-btn-primary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 600;
}
.tu-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.tu-btn-ghost {
  background: transparent;
  border-color: var(--dsw-alias-border-l1);
  padding: 6px 11px;
  font-size: 11.5px;
}
.tu-chip {
  flex: none;
  font-size: 11px;
  line-height: 18px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.tu-chip[data-tone='brand'] {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.tu-balance-set {
  appearance: none;
  border: 1px dashed var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.tu-balance-set:hover {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}

@media (max-width: 780px) {
  .tu-col, .tu-col-wide, .tu-col-grow { flex: 1 1 100%; }
  .tu-search { width: 100%; }
  .tu-split { grid-template-columns: minmax(0, 1fr); max-height: none; }
  .tu-list-pane { max-height: 240px; }
}

/* 顶层视图切换：与工具栏同排，做成分段控件而不是下划线标签——
   下划线标签适合页面内的内容分区，工具栏里用分段控件更协调 */
.tu-viewtabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  flex: none;
}
.tu-viewtab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1;
  padding: 7px 13px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
  white-space: nowrap;
}
.tu-viewtab:hover { color: var(--dsw-alias-label-primary); }
.tu-viewtab[data-active='true'] {
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  box-shadow: 0 1px 3px var(--dsw-alias-border-l2);
}
.tu-page { display: flex; flex-direction: column; gap: 18px; }
.tu-page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.tu-page-title { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
.tu-page-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; }
.tu-page-actions { display: flex; gap: 8px; flex: none; }
.tu-page-grouphead {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 9px;
}
.tu-suplist { display: flex; flex-direction: column; gap: 10px; }
.tu-supcard {
  /* 三栏网格：信息 | 余额/配额 | 操作。
     之前用 flex + flex-wrap，窄屏时余额块会被按钮挤到重叠，
     网格显式声明列宽与换行规则更可控。 */
  display: grid;
  grid-template-columns: minmax(180px, 1.1fr) minmax(220px, 1.4fr) auto;
  align-items: center;
  gap: 16px 20px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 14px 17px;
  transition: border-color 140ms ease;
}
.tu-supcard:hover { border-color: var(--dsw-alias-border-l2); }
.tu-supcard-discovered { border-style: dashed; }

.tu-supcard-main { min-width: 0; }
.tu-supcard-name {
  font-size: 13.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
/* 模型清单弹窗 */
/* 右下角通知：与 our-free-model 插件同一位置与观感，
   保证同一界面里的通知风格一致 */
.tu-toasts {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: min(380px, calc(100vw - 36px));
  font-family: inherit;
  pointer-events: none;
}
.tu-toast {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px 14px 12px 16px;
  border-radius: 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 94%, transparent);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  box-shadow: 0 14px 40px var(--dsw-alias-shadow-l2, rgb(0 0 0 / 26%));
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  animation: tu-toast-rise 0.32s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
  pointer-events: auto;
}
/* 左侧色条表达级别：红=用尽、黄=将尽、绿=恢复 */
.tu-toast::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--dsw-alias-state-warn-primary);
}
.tu-toast[data-level='error']::before { background: var(--dsw-alias-state-error-primary); }
.tu-toast[data-level='ok']::before { background: var(--dsw-alias-state-success-primary); }
.tu-toast-title {
  font-weight: 600;
  font-size: 12.5px;
  padding-right: 18px;
}
.tu-toast-body {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.tu-toast-close {
  position: absolute;
  top: 8px;
  right: 8px;
  appearance: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 5px;
}
.tu-toast-close:hover { background: var(--dsw-alias-bg-layer-2); }
@keyframes tu-toast-rise {
  from { opacity: 0; transform: translateY(10px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .tu-toast { animation: none; }
}

/* 模型列表的状态灯：绿点=已配置，空心点=只勾选未配置，无灯=未勾选 */
.tu-mlist-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-left: 2px;
}
.tu-mlist-dot[data-state='ready'] { background: var(--dsw-alias-state-success-primary); }
.tu-mlist-dot[data-state='picked'] {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l3);
}
/* 「端点报告了容量」的一键采用按钮 */
.tu-autofill {
  appearance: none;
  align-self: flex-start;
  border: 1px dashed var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease;
}
.tu-autofill:hover {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
/* 未勾选模型的详情提示 */
.tu-detail-warn {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
  border-radius: 7px;
  padding: 7px 10px;
}

.tu-sheet-narrow { width: min(560px, 100%); }
.tu-models-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tu-model-item {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 10px 12px;
}
.tu-model-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tu-model-item-id {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-alias-font-mono, monospace);
  font-size: 12.5px;
  font-weight: 600;
}
.tu-btn-xs { padding: 3px 8px; font-size: 10.5px; }
.tu-model-item-alias {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 3px;
}
.tu-model-item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}

.tu-supcard-badge {
  font-size: 10.5px;
  font-weight: 400;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  padding: 1px 7px;
}
/* 可点的模型数徽标：hover 时给出可交互的暗示 */
.tu-supcard-badge-btn {
  appearance: none;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease;
}
.tu-supcard-badge-btn:hover {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.tu-supcard-url {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 3px;
}

/* 中栏：余额或配额 */
.tu-supcard-value { min-width: 0; }
.tu-supcard-money {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}
.tu-supcard-money-label { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
/* 余额可点：提示可切换货币，与统计页的金额卡片行为一致 */
.tu-supcard-money-click {
  cursor: pointer;
  border-radius: 8px;
  padding: 4px 8px;
  margin: -4px -8px;
  transition: background 130ms ease;
}
.tu-supcard-money-click:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.tu-supcard-money-click:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.tu-supcard-money-value {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-state-success-primary);
}
.tu-supcard-quotas {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 右栏：操作按钮，始终同一行 */
.tu-supcard-actions {
  display: flex;
  gap: 6px;
  flex: none;
  justify-content: flex-end;
}

/* 状态说明横跨整行 */
.tu-supcard-note {
  grid-column: 1 / -1;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  padding-top: 2px;
}
.tu-supcard-note-error { color: var(--dsw-alias-state-error-primary); }

@media (max-width: 900px) {
  .tu-supcard {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .tu-supcard-value { grid-column: 1 / -1; }
  .tu-supcard-money { align-items: flex-start; }
}

.tu-notice {
  border-radius: 9px;
  padding: 9px 13px;
  font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l1);
}
.tu-notice[data-kind='ok'] {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
}
.tu-notice[data-kind='error'] {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
/* 宽弹窗：模型勾选与设置需要并排 */
.tu-modal-wide { max-width: 920px; width: min(920px, 94vw); }
.tu-aliaslist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
  max-height: 320px;
  overflow-y: auto;
}
.tu-aliasrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.tu-aliasraw {
  min-width: 110px;
  font-family: var(--dsw-alias-font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tu-aliasarrow { color: var(--dsw-alias-label-secondary); }
/* —— 预算进度 ——
   给「花了多少」一个参照系。与 Coding Plan 额度条同一套视觉语言，
   用户不必学第二套理解方式。 */
.tu-budget {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.tu-budget-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.tu-budget-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--dsw-alias-state-success-primary);
  transition: width 200ms ease, background 200ms ease;
}
.tu-budget[data-level='warn'] .tu-budget-fill { background: var(--dsw-alias-state-warn-primary); }
.tu-budget[data-level='over'] .tu-budget-fill { background: var(--dsw-alias-state-error-primary); }
.tu-budget-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 10.5px;
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary);
}
/* 金额单独一行，避免被 nowrap + 省略号截掉 */
.tu-budget-amount {
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
}
.tu-budget[data-level='warn'] .tu-budget-text { color: var(--dsw-alias-state-warn-primary); }
.tu-budget[data-level='over'] .tu-budget-text { color: var(--dsw-alias-state-error-primary); }
/* 热力图：竖排。标题 → 网格（含月份）→ 图例 → 三个数字。
   放在右侧栏（环形图下方），宽度约 500px，10~26 周刚好铺满。 */
.tu-heat {
  margin-top: 18px;
  /* 下方留白：明细视图紧贴热力图时，两块内容会糊在一起分不清 */
  margin-bottom: 26px;
  padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.tu-heat-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.tu-heat-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  align-items: center;
}
/* 月份与格子共用同一套列宽，标签自然对齐到对应周 */
.tu-heat-months,
.tu-heat-grid {
  display: grid;
  /* 列宽用 1fr 均分容器宽度；配合格子的 aspect-ratio: 1，
     格子始终是正方形并铺满整行——这是「热力图永远填满卡片」的关键。 */
  grid-template-columns: repeat(var(--tu-heat-weeks, 53), minmax(0, 1fr));
  gap: 3px;
  width: 100%;
  max-width: var(--tu-heat-maxw, 100%);
  margin: 0 auto;
}
.tu-heat-grid {
  grid-auto-flow: column;
  grid-template-rows: repeat(7, auto);
}
.tu-heat-month {
  font-size: 9.5px;
  line-height: 1;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  /* 1fr 列可能在标签多的月份被压窄，允许溢出到右侧空白而不是撑列 */
  overflow: visible;
  min-width: 0;
}
/* 三个关键数字：横排一行，紧跟图例 */
.tu-heat-summary {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 0;
  /* 与热力图拉开距离，不要紧贴 */
  margin-top: 16px;
  /* 独立面板：淡背景 + 圆角，读成一块整体而不是「一排浮着的数字」 */
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.tu-heat-stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  min-width: 0;
  padding: 0 16px;
}
.tu-heat-stat:first-child { padding-left: 0; }
.tu-heat-stat:last-child { padding-right: 0; }
.tu-heat-stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}
.tu-heat-stat-label {
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
/* 预算项的告警色：超过阈值转黄、超支转红 */
.tu-heat-stat-value[data-level='warn'] { color: var(--dsw-alias-state-warn-primary); }
.tu-heat-stat-value[data-level='over'] { color: var(--dsw-alias-state-error-primary); }
.tu-heat-stat-hint {
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.tu-heat-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.tu-heat-sub {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-heat-cell {
  appearance: none;
  /* 宽度由 grid 的 1fr 决定，aspect-ratio 保证正方形；
     不再写死 13px，否则在宽卡片里格子会缩成一小撮。 */
  width: 100%;
  aspect-ratio: 1;
  padding: 0;
  border: none;
  border-radius: 2px;
  cursor: pointer;
  background: var(--dsw-alias-bg-layer-2);
  transition: transform 90ms ease;
}
.tu-heat-cell:hover { transform: scale(1.25); }
.tu-heat-cell[data-level='1'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent); }
.tu-heat-cell[data-level='2'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
.tu-heat-cell[data-level='3'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent); }
.tu-heat-cell[data-level='4'] { background: var(--dsw-alias-brand-primary); }
.tu-heat-cell[data-active='true'] {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: 1px;
}
.tu-heat-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-heat-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--dsw-alias-bg-layer-2);
}
.tu-heat-dot[data-level='1'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent); }
.tu-heat-dot[data-level='2'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
.tu-heat-dot[data-level='3'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent); }
.tu-heat-dot[data-level='4'] { background: var(--dsw-alias-brand-primary); }
.tu-heat-hint { margin-left: 6px; opacity: 0.75; }

.tu-budget-section {
  margin-top: 18px;
  padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.tu-budget-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.tu-budget-h3 {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.tu-budget-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 320px;
}
.tu-budget-fields .tu-input { margin-bottom: 4px; }
.tu-budget-group-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}
.tu-budget-group-card {
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.tu-budget-group-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.tu-budget-name { flex: 1 1 auto; }
.tu-budget-group-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.tu-budget-group-row .tu-flabel { min-width: auto; }
.tu-budget-models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  max-height: 130px;
  overflow-y: auto;
}
.tu-budget-model {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  font-size: 11.5px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.tu-budget-model[data-on='true'] {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
}

.tu-budget-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.tu-budget-group {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
}
.tu-budget-group-name {
  flex: none;
  min-width: 76px;
  color: var(--dsw-alias-label-secondary);
}
.tu-budget-group .tu-budget { flex: 1 1 auto; margin-top: 0; }

.tu-card-cost {
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease;
}
.tu-card-cost:hover {
  border-color: var(--dsw-alias-brand-primary);
}
.tu-card-cost:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
/* 顶部工具栏：页签 + 未定价模型 + 价目表操作同排。
   常驻显示（不再只在有未定价模型时出现），否则页签会跟着消失。 */
.tu-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.tu-toolbar-spacer { flex: 1 1 auto; }
.tu-toolbar-actions {
  display: flex;
  gap: 8px;
  flex: none;
  margin-left: auto;
}
/* 工具栏里的未定价条不再自带边框与背景，改由工具栏统一承载 */
.tu-toolbar .tu-unpriced {
  border: none;
  background: transparent;
  padding: 0;
  margin: 0;
  flex: 1 1 auto;
  min-width: 0;
}

.tu-unpriced {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 10px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12.5px;
}
.tu-unpriced-label {
  color: var(--dsw-alias-label-secondary);
  font-weight: 600;
}
.tu-unpriced-item {
  border: 1px dashed var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  border-radius: 7px;
  padding: 3px 9px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.tu-unpriced-item:hover {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.tu-unpriced-refresh { margin-left: auto; }
.tu-priceform {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}
.tu-pricefield {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.tu-priceinput {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 7px;
  padding: 6px 9px;
  font-size: 13px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  width: 130px;
}
.tu-daterange {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-datefield {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tu-dateinput {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 7px;
  padding: 4px 8px;
  font-size: 12.5px;
  font-family: inherit;
}
.tu-daterange-meta {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.tu-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-pager-info {
  font-variant-numeric: tabular-nums;
  min-width: 90px;
  text-align: center;
}
.tu-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 11px;
}
.tu-headtools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
}
.tu-star {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tu-star-icon {
  font-size: 12px;
  line-height: 1;
}
.tu-filterbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}
.tu-filterbar .tu-tabs {
  margin-bottom: 0;
}
.tu-dropdown {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-dropbtn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12.5px;
  cursor: pointer;
  min-width: 130px;
  max-width: 240px;
}
.tu-dropbtn:hover {
  border-color: var(--dsw-alias-border-l2);
}
.tu-dropbtn[data-open='true'] {
  border-color: var(--dsw-alias-brand-primary);
}
.tu-dropbtn-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.tu-caret {
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  flex: none;
}
.tu-dropmenu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 5;
  min-width: 220px;
  max-height: 300px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 8px 24px rgb(0 0 0 / 26%);
}
.tu-dropitem {
  appearance: none;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tu-dropitem:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.tu-dropitem[data-checked='true'] {
  color: var(--dsw-alias-brand-primary);
}
.tu-check {
  color: var(--dsw-alias-brand-primary);
  font-size: 11px;
  text-align: center;
}
/* 版本指示：按钮 + 下方「指示灯 + 版本号」，紧凑排布在右上角工具区里。 */
.tu-verctl {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.tu-verline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  padding-left: 2px;
}
.tu-verdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  /* 默认灰：尚未检查更新 */
  background: var(--dsw-alias-state-idle-primary);
}
/* 绿 = 已是最新（安稳状态） */
.tu-verdot[data-state='ok'] {
  background: var(--dsw-alias-state-success-primary);
}
/* 蓝 = 有新版本可用（需要动作，但不是错误，所以不用红） */
.tu-verdot[data-state='new'] {
  background: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
}
.tu-vercode {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}
.tu-verlatest {
  color: var(--dsw-alias-brand-primary);
  font-variant-numeric: tabular-nums;
}
.tu-verbtn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  max-width: 240px;
}
.tu-verbtn:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2);
}
.tu-verbtn:disabled {
  opacity: 0.6;
  cursor: default;
}
.tu-verbusy {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}
.tu-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 42%);
  padding: 24px;
}
.tu-modal {
  width: min(420px, 100%);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  padding: 18px 20px 16px;
  box-shadow: 0 18px 60px -14px rgb(0 0 0 / 45%);
}
.tu-modal-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}
.tu-modal-body {
  font-size: 13px;
  line-height: 1.7;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 16px;
  overflow-wrap: anywhere;
}
.tu-modal-notes {
  margin-bottom: 14px;
}
.tu-modal-notes-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.tu-modal-notes-body {
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 9px 11px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tu-modal-progress {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.tu-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.tu-button-primary {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.tu-account {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 11px 15px;
  margin-bottom: 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 13px;
}
.tu-account-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.tu-account-name {
  font-weight: 600;
}
.tu-account-balance {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.tu-link {
  color: var(--dsw-alias-brand-primary);
  text-decoration: none;
  font-size: 12.5px;
}
.tu-link:hover {
  text-decoration: underline;
}
.tu-failed {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
  padding: 10px 15px;
  margin-bottom: 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-failed-note {
  flex: 1 1 100%;
  font-size: 11.5px;
  line-height: 1.6;
  opacity: 0.85;
}
.tu-hint {
  margin: 7px 2px 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.tu-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 9px;
  /* 固定标题行高度：左列有模式切换按钮（更高），右列只有标题；
     不锁高度两列卡片顶部会错开。 */
  min-height: 26px;
}
/* 图表与饼图都撑满各自单元格，配合网格的等高拉伸实现上下对齐 */
.tu-grid-2 > .tu-section {
  display: flex;
  flex-direction: column;
  margin-bottom: 0;
}
.tu-grid-2 .tu-chart,
.tu-grid-2 .tu-pie {
  flex: 1 1 auto;
}
.tu-section-head .tu-section-title {
  margin-bottom: 0;
}
.tu-tabs-sm {
  margin-bottom: 0;
  padding: 2px;
}
.tu-tabs-sm .tu-tab {
  padding: 3px 10px;
  font-size: 12px;
}
.tu-tabs-wrap {
  flex-wrap: wrap;
}
.tu-chart-canvas {
  position: relative;
}
.tu-chart-tip {
  position: absolute;
  top: 6px;
  /* 不用 translateX(-50%)：贴近图表左右边缘时提示框会被推出容器。
     改由 JS 按位置比例计算偏移，并留出最小边距。 */
  max-width: 220px;
  pointer-events: none;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  box-shadow: 0 4px 14px rgb(0 0 0 / 22%);
  z-index: 2;
}
.tu-chart-tip-label {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}
.tu-chart-tip-value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tu-chart-tip-multi {
  max-width: 220px;
  white-space: normal;
}
.tu-chart-tip-row {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  font-variant-numeric: tabular-nums;
}
.tu-chart-tip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-chart-tip-num {
  font-weight: 600;
}
.tu-chart-tip-sub {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.tu-pie {
  /* 用 Grid 而不是 flex-wrap：显式两列，容器再窄也不会换行成上下堆叠，
     图例始终在圆环右侧。flex-basis 会被内容与宿主全局样式左右，Grid 不会。 */
  display: grid;
  align-content: center;
  grid-template-columns: 116px minmax(0, 1fr);
  /* 图例可滚动时，顶部对齐比垂直居中更稳——居中会让滚动区上下都留白 */
  align-items: start;
  gap: 16px;
  /* 兜底：无论图例多长，容器都不超过这个高度 */
  max-height: 190px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 14px;
  min-width: 0;
}
/* 容器确实放不下两列时才退化为上下排布（罕见，例如极窄的可视区域） */
@media (max-width: 380px) {
  .tu-pie {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
  }
}
.tu-pie-figure {
  position: relative;
  flex: 0 0 116px;
  width: 116px;
  height: 116px;
}
.tu-pie-svg {
  display: block;
  width: 116px;
  height: 116px;
}
.tu-pie-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  text-align: center;
}
.tu-pie-total {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.tu-pie-total-label {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 1px;
}
.tu-pie-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 模型多时图例会撑高卡片并顶出容器。给它自己的滚动区，
     而不是让整个卡片跟着变高——卡片高度由圆环决定。 */
  max-height: 150px;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 滚动条不挤占内容宽度；Firefox 与 WebKit 各写一条 */
  scrollbar-width: thin;
  scrollbar-gutter: stable;
}
.tu-pie-legend::-webkit-scrollbar {
  width: 6px;
}
.tu-pie-legend::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l2);
  border-radius: 999px;
}
.tu-pie-legend::-webkit-scrollbar-track {
  background: transparent;
}
.tu-pie-legend-item {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  transition: opacity 120ms ease;
}
.tu-pie-legend-item[data-dim='true'] {
  opacity: 0.45;
}
.tu-pie-legend-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 图例在窄容器里换行成单列，而不是挤成一团 */

.tu-pie-legend-pct {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.tu-pie-legend-value {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  min-width: 54px;
  text-align: right;
}
.tu-chart {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 12px 14px 8px;
}
.tu-chart-svg {
  display: block;
  width: 100%;
  height: 160px;
}
.tu-chart-axis {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.tu-chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 8px;
}
.tu-chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tu-dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
  flex: none;
}
.tu-dot-input { background: var(--dsw-alias-brand-primary); }
.tu-dot-cache { background: var(--dsw-alias-state-success-primary); }
.tu-dot-output { background: var(--dsw-alias-state-warn-primary); }
.tu-chart-empty {
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 11px;
  padding: 28px 16px;
  text-align: center;
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.tu-grid-2 {
  display: grid;
  /* 主图占大头（趋势曲线需要横向空间），饼图占固定偏窄一列。
     显式比例比 auto-fit 更可预测：饼图那列不会被压到放不下图例。 */
  grid-template-columns: minmax(0, 1.55fr) minmax(260px, 1fr);
  gap: 14px;
  /* 等高拉伸：两列卡片上下边缘对齐，看起来是一个整体而不是两块拼图。
     早先用 align-items: start，两张卡片各自高度不同、底部参差不齐。 */
  align-items: stretch;
}
@media (max-width: 760px) {
  .tu-grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
.tu-card[data-rate='true'] .tu-card-value {
  color: var(--dsw-alias-state-success-primary);
}
.tu-warn {
  margin-top: 14px;
  padding: 10px 14px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12.5px;
}
.tu-error {
  padding: 14px 16px;
  border-radius: 11px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
`

    //#endregion

    //#region 格式化

    /** 千分位 + 紧凑单位。统计页要能一眼读出量级。 */
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
      return Math.round(value).toLocaleString()
    }

    /** 大数用 1.2M / 34.5K 之类的紧凑写法。 */
    function formatCompact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return '0'
      const abs = Math.abs(value)
      if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`
      if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`
      if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`
      return formatNumber(value)
    }

/**
 * 格式化金额。
 *
 * 平台返回的余额常是高精度小数字符串（如 `10.00000000000000000`），
 * 直接渲染会拖出一长串无意义的零。这里按数值大小取合理位数：
 *   - 0：显示 `0`
 *   - < 1：保留 4 位（小额余额需要精度，例如 $0.0082）
 *   - 其余：保留 2 位
 *
 * 接受字符串或数字；无法解析时原样返回，避免丢信息。
 */
function formatMoneyText(value) {
  if (value === null || value === undefined || value === '') return '0'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1) return n.toFixed(4)
  if (abs < 1000) return n.toFixed(2)
  // 大额也保留 2 位，但不加千分位（余额通常不会很大）
  return n.toFixed(2)
}

    function formatTime(timestamp, locale) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      try {
        return new Date(timestamp).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return new Date(timestamp).toISOString().slice(5, 16).replace('T', ' ')
      }
    }

    /**
     * 跟踪宿主当前语言 id。
     *
     * 初始值由 slot inject 传入（注册时读一次），之后通过
     * `ctx.locale.subscribe` 跟随变化——这样用户切语言时页面立刻重渲染。
     */
    function useLocaleId(initial) {
      const [id, setId] = useState(initial ?? 'zh')
      useEffect(() => {
        const subscribe = localeSubscribeRef.current
        if (typeof subscribe !== 'function') return undefined
        return subscribe(() => {
          const next = localeReaderRef.current?.()
          if (typeof next === 'string') setId(next)
        })
      }, [])
      return id
    }

    /** 路径只保留末两段，避免长目录撑破表格。 */
    function shortPath(path) {
      if (typeof path !== 'string' || path === '') return '—'
      const parts = path.split(/[/\\]/).filter(Boolean)
      if (parts.length <= 2) return path
      return `…/${parts.slice(-2).join('/')}`
    }

    /** 与 Host 同口径的命中率兜底（Host 未提供时使用）。 */
    function hitRateOf(counters) {
      if (counters === undefined || counters === null) return 0
      const read = counters.cacheReadTokens ?? 0
      const input = counters.inputTokens ?? 0
      const denominator = read + input
      return denominator > 0 ? read / denominator : 0
    }

    /** 计数器全为 0 时视为空。 */
    function isEmpty(counters) {
      return counters === undefined
        || counters === null
        || (counters.calls ?? 0) === 0 && (counters.totalTokens ?? 0) === 0
    }

    //#endregion

    //#region 数据

    /** 读取一次快照。失败时返回带 error 的对象，不抛出。 */
    async function readSummary() {
      const response = await fetch(SUMMARY_ROUTE, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /**
     * 快照订阅。
     *
     * 页面可见时按固定间隔轮询；页面隐藏时停表，避免后台空转。
     * 手动刷新走同一入口，保证两条路径的竞态由同一个序号裁决。
     */
    function useSummary(intervalMs) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: undefined })
      const [refreshing, setRefreshing] = useState(false)
      const requestSeq = useRef(0)
      // intervalMs 变化时重启定时器；用 ref 读最新值，避免把 load 也重建。
      const intervalRef = useRef(intervalMs)
      intervalRef.current = intervalMs

      const load = useCallback(async (mode) => {
        const seq = ++requestSeq.current
        if (mode === 'manual') setRefreshing(true)
        try {
          const data = await readSummary()
          if (seq !== requestSeq.current) return
          setState({ status: 'ready', data, error: undefined })
        } catch (error) {
          if (seq !== requestSeq.current) return
          setState((previous) => ({
            status: previous.data === undefined ? 'error' : 'ready',
            data: previous.data,
            error: error instanceof Error ? error.message : String(error),
          }))
        } finally {
          if (seq === requestSeq.current && mode === 'manual') setRefreshing(false)
        }
      }, [])

      useEffect(() => {
        let disposed = false
        let timer

        const schedule = () => {
          if (disposed) return
          const interval = intervalRef.current
          // 0 = 关闭自动刷新：只在进入页面时读一次。
          if (!interval || interval <= 0) return
          if (typeof document !== 'undefined' && document.hidden === true) return
          timer = setTimeout(async () => {
            await load('auto')
            schedule()
          }, interval)
          timer?.unref?.()
        }

        load('initial').then(schedule)

        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.hidden === false) {
            clearTimeout(timer)
            load('auto').then(schedule)
          }
        }
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility)
        }

        return () => {
          disposed = true
          clearTimeout(timer)
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }
      }, [load, intervalMs])

      const refresh = useCallback(async () => {
        // 先让 Host 落盘，再读，避免刚结束的调用还没写进去。
        try {
          await fetch(FLUSH_ROUTE, {
            method: 'GET',
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          })
        } catch {
          // 落盘失败不影响读取：内存里的数据已经是完整的。
        }
        await load('manual')
      }, [load])

      return { ...state, refreshing, refresh }
    }

    //#endregion

    //#region 视图

    /** 一张指标卡。`suffix` 用于百分比，`rate` 给它一个强调色。 */
    /**
     * 指标卡。
     *
     * `raw: true` 表示 value 已经是格式化好的文本（如 `245ms`），
     * 直接显示，不再过 formatCompact —— 否则字符串会被当成 0。
     */
    function MetricCard({ label, value, accent, rate, suffix, raw }) {
      const text = raw === true
        ? String(value)
        : suffix === undefined ? formatCompact(value) : `${value}${suffix}`
      return h('div', {
        className: 'tu-card',
        'data-accent': accent === true ? 'true' : 'false',
        'data-rate': rate === true ? 'true' : 'false',
      },
      h('div', { className: 'tu-card-label' }, label),
      h('div', {
        className: 'tu-card-value',
        title: raw === true ? undefined : formatNumber(value),
      }, text),
      )
    }

    //#region 图表
    //
    // 全部手写 SVG，不引第三方图表库：插件保持零依赖、无构建步骤，
    // 且颜色全部走主题 token，亮/暗色自动跟随。

    /** 图表通用尺寸。 */
    const CHART = { width: 720, height: 180, padTop: 12, padBottom: 22, padLeft: 8, padRight: 8 }

    /** 把数据点映射成折线路径（尖角，用于需要精确对齐的场合）。 */
    function linePath(points) {
      if (points.length === 0) return ''
      return points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join(' ')
    }

    /**
     * 平滑曲线路径。
     *
     * 原本用直线段连接，折角明显、观感生硬。这里用 Catmull-Rom 转三次
     * 贝塞尔：控制点取相邻点的差分，得到的曲线**穿过每个数据点**（这点
     * 很重要——如果只是普通平滑，悬停定位会与曲线对不上）。
     *
     * 张力系数 1/6 是 Catmull-Rom 的标准取值；整体乘 0.65 让曲线更收敛，
     * 避免在峰值附近冲过头（overshoot）造成「假高点」。
     */
    function smoothPath(points, options = {}) {
      if (points.length === 0) return ''
      if (points.length < 3) return linePath(points)
      // 面积图的上下边界必须用**同一条**平滑曲线，否则一条顺滑、一条是
      // 直线段，接缝处会显得生硬。张力也调小一些：面积图靠面积表达量级，
      // 过冲会在峰值处造出「假高点」。
      const tension = (options.tension ?? 0.65) / 6
      let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
      for (let index = 0; index < points.length - 1; index += 1) {
        const p0 = points[index - 1] ?? points[index]
        const p1 = points[index]
        const p2 = points[index + 1]
        const p3 = points[index + 2] ?? p2
        const c1x = p1.x + (p2.x - p0.x) * tension
        const c1y = p1.y + (p2.y - p0.y) * tension
        const c2x = p2.x - (p3.x - p1.x) * tension
        const c2y = p2.y - (p3.y - p1.y) * tension
        path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`
      }
      return path
    }

    /**
     * 多序列趋势图：每日用量按模型拆分。
     *
     * 参照同类工具的「每日 Token 趋势」：每个模型一条曲线，共用一条时间轴，
     * 悬停显示当天各模型的数值。所有序列按同一个最大值缩放，这样曲线的
     * 高低可以直接比较——若各自归一化，视觉上就失去意义。
     */
    function ModelTrendChart({ modelTrend, t, seriesLabel }) {
      const [hoverIndex, setHoverIndex] = useState(-1)
      const [tipLeft, setTipLeft] = useState(50)
      const days = modelTrend?.days ?? []
      const series = modelTrend?.series ?? []

      if (days.length < 2 || series.length === 0) {
        return h('div', { className: 'tu-chart-empty' }, t('chart.empty'))
      }

      const innerWidth = CHART.width - CHART.padLeft - CHART.padRight
      const innerHeight = CHART.height - CHART.padTop - CHART.padBottom
      const stepX = innerWidth / (days.length - 1)
      const toX = (index) => CHART.padLeft + index * stepX

      // 单一缩放基准：所有序列共用一个 max，曲线高低才可比较。
      const max = Math.max(
        ...series.flatMap((item) => days.map((day) => item.values[day] ?? 0)),
        1,
      )
      const toY = (value) => CHART.padTop + innerHeight - (value / max) * innerHeight

      const onMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        if (rect.width <= 0) return
        const ratio = (event.clientX - rect.left) / rect.width
        const x = ratio * CHART.width
        setHoverIndex(Math.max(0, Math.min(days.length - 1, Math.round((x - CHART.padLeft) / (stepX || 1)))))
        // 同一套钳制：多序列提示框更宽，也绝不能越出容器。
        const half = Math.min(110, rect.width / 2)
        const center = Math.max(half, Math.min(rect.width - half, ratio * rect.width))
        setTipLeft((center / rect.width) * 100)
      }
      const onLeave = () => setHoverIndex(-1)

      const hoverDay = hoverIndex >= 0 ? days[hoverIndex] : undefined

      return h('div', { className: 'tu-chart' },
        h('div', { className: 'tu-chart-canvas' },
          h('svg', {
            viewBox: `0 0 ${CHART.width} ${CHART.height}`,
            preserveAspectRatio: 'none',
            className: 'tu-chart-svg',
            role: 'img',
            onMouseMove: onMove,
            onMouseLeave: onLeave,
          },
          // 网格线
          [0, 0.5, 1].map((ratio) => h('line', {
            key: `grid${ratio}`,
            x1: CHART.padLeft, x2: CHART.padLeft + innerWidth,
            y1: CHART.padTop + innerHeight * (1 - ratio),
            y2: CHART.padTop + innerHeight * (1 - ratio),
            stroke: 'var(--dsw-alias-border-l1)',
            strokeWidth: 1,
            strokeDasharray: '3 5',
            opacity: 0.5,
          })),
          series.map((item, seriesIndex) => {
            const color = seriesColor(seriesIndex)
            const coords = days.map((day, dayIndex) => ({
              x: toX(dayIndex),
              y: toY(item.values[day] ?? 0),
            }))
            return h('path', {
              key: item.key,
              d: smoothPath(coords),
              fill: 'none',
              stroke: color,
              strokeWidth: 2,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              opacity: 0.95,
            })
          }),
          hoverIndex >= 0
            ? h('line', {
              x1: toX(hoverIndex), x2: toX(hoverIndex),
              y1: CHART.padTop, y2: CHART.padTop + innerHeight,
              stroke: 'var(--dsw-alias-label-primary)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.6,
            })
            : null,
          // 悬停点：每条序列标一个圆点
          hoverDay !== undefined
            ? series.map((item, seriesIndex) => h('circle', {
              key: `dot-${item.key}`,
              cx: toX(hoverIndex),
              cy: toY(item.values[hoverDay] ?? 0),
              r: 3,
              fill: seriesColor(seriesIndex),
              stroke: 'var(--dsw-alias-bg-layer-1)',
              strokeWidth: 1,
            }))
            : null,
          ),
          hoverDay !== undefined
            ? h('div', {
              className: 'tu-chart-tip tu-chart-tip-multi',
              style: { left: `${tipLeft}%`, transform: 'translateX(-50%)' },
            },
            h('div', { className: 'tu-chart-tip-label' }, hoverDay.slice(5)),
            series.map((item, seriesIndex) => h('div', {
              key: item.key,
              className: 'tu-chart-tip-row',
            },
            h('i', { className: 'tu-dot', style: { background: seriesColor(seriesIndex) } }),
            h('span', { className: 'tu-chart-tip-name', title: item.key },
              item.label === 'rest' ? t('chart.groupRest') : item.label),
            h('span', { className: 'tu-chart-tip-num' }, formatCompact(item.values[hoverDay] ?? 0)),
            )),
            )
            : null,
        ),
        h('div', { className: 'tu-chart-legend' },
          series.map((item, seriesIndex) => h('span', { key: item.key },
            h('i', { className: 'tu-dot', style: { background: seriesColor(seriesIndex) } }),
            item.label === 'rest' ? t('chart.groupRest') : item.label,
          )),
        ),
        h('div', { className: 'tu-chart-axis' },
          h('span', null, days[0].slice(5)),
          h('span', null, `${formatCompact(max)} ↑`),
          h('span', null, days[days.length - 1].slice(5)),
        ),
      )
    }

    /**
     * 交互式趋势图。一张图承载三种视角，用模式切换取代三个独立图表。
     *
     * 关键点：
     *   - 悬停显示具体数值（这是之前缺的），用一条竖直参考线 + 数据点强调；
     *   - 命中率是百分比量纲，所以按模式单独缩放，不能和 token 混在一个 Y 轴；
     *   - 图表宽度随容器走，但内部坐标固定，保证鼠标定位与绘制一致。
     */
    function TrendChart({ points, mode, t, modelTrend, seriesLabel }) {
      const [hoverIndex, setHoverIndex] = useState(-1)
      // 提示框的水平位置（百分比）。用实际容器宽度钳制，避免贴边时被推出。
      const [tipLeft, setTipLeft] = useState(50)
      const svgRef = useRef(null)

      // 「按模型」模式：多条曲线共用一张图，与单曲线模式分开实现——
      // 多序列需要自己的色板、图例与缩放基准。
      if (mode === 'model') {
        return h(ModelTrendChart, { modelTrend, t, seriesLabel })
      }

      if (points.length < 2) {
        return h('div', { className: 'tu-chart-empty' }, t('chart.empty'))
      }

      const innerWidth = CHART.width - CHART.padLeft - CHART.padRight
      const innerHeight = CHART.height - CHART.padTop - CHART.padBottom
      const stepX = points.length > 1 ? innerWidth / (points.length - 1) : 0

      const toX = (index) => CHART.padLeft + index * stepX
      const baseY = CHART.padTop + innerHeight
      const toY = (value, max) => baseY - (value / max) * innerHeight

      // 鼠标定位：按容器宽度换算到内部坐标，与 preserveAspectRatio=none 一致。
      // 必须定义在 compose 分支之前——那个分支也会用它，放到后面会触发
      // 「Cannot access 'onMove' before initialization」，整张图渲染不出来。
      const onMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        if (rect.width <= 0) return
        const ratio = (event.clientX - rect.left) / rect.width
        const x = ratio * CHART.width
        const index = Math.round((x - CHART.padLeft) / (stepX || 1))
        setHoverIndex(Math.max(0, Math.min(points.length - 1, index)))
        // 钳制：提示框约 220px 宽，让它整体留在容器内。
        const half = Math.min(110, rect.width / 2)
        const center = Math.max(half, Math.min(rect.width - half, ratio * rect.width))
        setTipLeft(rect.width > 0 ? (center / rect.width) * 100 : 50)
      }
      const onLeave = () => setHoverIndex(-1)

      // compose 模式画三层堆叠面积（新输入 / 缓存命中 / 输出），
      // 与其它模式共用同一张图，因此不需要第三个独立图表。
      if (mode === 'compose') {
        const totals = points.map((point) => point.input + point.cacheRead + point.output)
        const max = Math.max(...totals, 1)
        const layers = [
          { key: 'input', color: 'var(--dsw-alias-brand-primary)', value: (p) => p.input },
          { key: 'cacheRead', color: 'var(--dsw-alias-state-success-primary)', value: (p) => p.cacheRead },
          { key: 'output', color: 'var(--dsw-alias-state-warn-primary)', value: (p) => p.output },
        ]
        // 自下而上累积，每一层画成闭合区域。
        //
        // 关键：上下边界必须用**同一套**平滑参数。早先只把上边界做了
        // 贝塞尔、下边界仍是折线，两者曲率不一致，接缝处看起来就很生硬。
        // 面积图的张力也调小（0.45）——过冲会在峰值处造出假高点。
        const AREA_TENSION = 0.45
        let lower = points.map(() => 0)
        const layerPaths = layers.map((layer) => {
          const upper = points.map((point, index) => lower[index] + layer.value(point))
          const topPoints = points.map((point, index) => ({
            x: toX(index),
            y: toY(upper[index], max),
          }))
          // 下边界反向拼回，形成闭合区域；同样走平滑曲线
          const bottomPoints = points.map((point, index) => ({
            x: toX(index),
            y: toY(lower[index], max),
          })).reverse()
          // smoothPath 返回的路径以 M 开头，拼到闭合区域里要换成 L 续接
          const topPath = smoothPath(topPoints, { tension: AREA_TENSION })
          const bottomPath = smoothPath(bottomPoints, { tension: AREA_TENSION })
          const path = `${topPath} ${bottomPath.replace(/^M/, 'L')} Z`
          lower = upper
          return { key: layer.key, color: layer.color, path }
        })
        const hoverPoint = hoverIndex >= 0 ? points[hoverIndex] : undefined
        return h('div', { className: 'tu-chart' },
          h('div', { className: 'tu-chart-canvas' },
            h('svg', {
              viewBox: `0 0 ${CHART.width} ${CHART.height}`,
              preserveAspectRatio: 'none',
              className: 'tu-chart-svg',
              role: 'img',
              onMouseMove: onMove,
              onMouseLeave: onLeave,
            },
            layerPaths.map((layer) => h('path', {
              key: layer.key, d: layer.path, fill: layer.color, opacity: 0.75, stroke: 'none',
            })),
            hoverIndex >= 0
              ? h('line', {
                x1: toX(hoverIndex), x2: toX(hoverIndex),
                y1: CHART.padTop, y2: baseY,
                stroke: 'var(--dsw-alias-label-primary)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.7,
              })
              : null,
            ),
            hoverPoint !== undefined
              ? h('div', {
                className: 'tu-chart-tip',
                style: { left: `${tipLeft}%`, transform: 'translateX(-50%)' },
              },
              h('div', { className: 'tu-chart-tip-label' }, hoverPoint.label),
              h('div', { className: 'tu-chart-tip-value' },
                `${t('chart.tip.total')} ${formatCompact(hoverPoint.input + hoverPoint.cacheRead + hoverPoint.output)}`),
              h('div', { className: 'tu-chart-tip-sub' },
                `${t('chart.legend.input')} ${formatCompact(hoverPoint.input)}`),
              h('div', { className: 'tu-chart-tip-sub' },
                `${t('chart.legend.cacheRead')} ${formatCompact(hoverPoint.cacheRead)}`),
              h('div', { className: 'tu-chart-tip-sub' },
                `${t('chart.legend.output')} ${formatCompact(hoverPoint.output)}`),
              )
              : null,
          ),
          h('div', { className: 'tu-chart-legend' },
            h('span', null, h('i', { className: 'tu-dot tu-dot-input' }), t('chart.legend.input')),
            h('span', null, h('i', { className: 'tu-dot tu-dot-cache' }), t('chart.legend.cacheRead')),
            h('span', null, h('i', { className: 'tu-dot tu-dot-output' }), t('chart.legend.output')),
          ),
          h('div', { className: 'tu-chart-axis' },
            h('span', null, points[0].label),
            h('span', null, `${formatCompact(Math.max(...totals, 0))} ↑`),
            h('span', null, points[points.length - 1].label),
          ),
        )
      }

      // 其它模式：单条曲线，按自己的量纲缩放。
      const rawValues = points.map((point) => (
        mode === 'cache' ? point.rate * 100
          // 成本模式：点位上带 costUsd（由调用方按天算好）
          : mode === 'cost' ? (point.costUsd ?? 0) * 1000
            : point.total
      ))
      const max = Math.max(...rawValues, 1)
      const formatValue = mode === 'cache'
        ? (value) => `${value.toFixed(1)}%`
        // 成本内部按「毫美元」放大画图（否则 0.03 这种值在图上贴底），
        // 显示时还原成美元
        : mode === 'cost' ? (value) => `$${(value / 1000).toFixed(3)}`
          : formatCompact

      const coords = rawValues.map((value, index) => ({
        x: toX(index), y: toY(value, max), value, point: points[index],
      }))
      const path = smoothPath(coords)
      const area = `${path} L${coords[coords.length - 1].x.toFixed(2)},${baseY.toFixed(2)}`
        + ` L${coords[0].x.toFixed(2)},${baseY.toFixed(2)} Z`
      const stroke = mode === 'cache' ? 'var(--dsw-alias-state-success-primary)'
        : mode === 'cost' ? 'var(--dsw-alias-state-warn-primary)'
          : 'var(--dsw-alias-brand-primary)'
      const gradientId = `tu-grad-${mode}`

      const hovered = hoverIndex >= 0 ? coords[hoverIndex] : undefined

      return h('div', { className: 'tu-chart' },
        h('div', { className: 'tu-chart-canvas' },
          h('svg', {
            ref: svgRef,
            viewBox: `0 0 ${CHART.width} ${CHART.height}`,
            preserveAspectRatio: 'none',
            className: 'tu-chart-svg',
            role: 'img',
            onMouseMove: onMove,
            onMouseLeave: onLeave,
          },
          h('defs', null,
            h('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 },
              h('stop', { offset: '0%', stopColor: stroke, stopOpacity: 0.3 }),
              h('stop', { offset: '100%', stopColor: stroke, stopOpacity: 0.02 }),
            ),
          ),
          // 网格线：让数值可估读
          [0, 0.5, 1].map((ratio) => h('line', {
            key: `grid${ratio}`,
            x1: CHART.padLeft, x2: CHART.padLeft + innerWidth,
            y1: CHART.padTop + innerHeight * (1 - ratio),
            y2: CHART.padTop + innerHeight * (1 - ratio),
            stroke: 'var(--dsw-alias-border-l1)',
            strokeWidth: 1,
            strokeDasharray: '3 5',
            opacity: 0.5,
          })),
          h('path', { d: area, fill: `url(#${gradientId})`, stroke: 'none' }),
          h('path', { d: path, fill: 'none', stroke, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
          // 悬停参考线
          hovered !== undefined
            ? h('line', {
              x1: hovered.x, x2: hovered.x,
              y1: CHART.padTop, y2: CHART.padTop + innerHeight,
              stroke: stroke, strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.6,
            })
            : null,
          // 数据点：悬停时全部显示，否则只标首尾与峰值
          coords.map((coord, index) => {
            const isEdge = index === 0 || index === points.length - 1
            const isPeak = coord.value === max
            if (!isEdge && !isPeak && index !== hoverIndex) return null
            return h('circle', {
              key: `p${index}`,
              cx: coord.x, cy: coord.y,
              r: index === hoverIndex ? 4 : 2.5,
              fill: stroke,
              stroke: 'var(--dsw-alias-bg-layer-1)',
              strokeWidth: index === hoverIndex ? 1.5 : 0,
            })
          }),
          ),
          // 悬停提示：用 DOM 而非 SVG 文本，避免被 preserveAspectRatio 拉伸变形
          hovered !== undefined
            ? h('div', {
              className: 'tu-chart-tip',
              style: { left: `${tipLeft}%`, transform: 'translateX(-50%)' },
            },
            h('div', { className: 'tu-chart-tip-label' }, hovered.point.label),
            h('div', { className: 'tu-chart-tip-value' },
              `${t(mode === 'cache' ? 'chart.tip.cache' : 'chart.tip.total')} ${formatValue(hovered.value)}`),
            mode === 'compose'
              ? null
              : h('div', { className: 'tu-chart-tip-sub' },
                `${t('field.calls')} ${formatNumber(hovered.point.calls ?? 0)}`),
            mode === 'total'
              ? h('div', { className: 'tu-chart-tip-sub' },
                `${t('chart.tip.cache')} ${(hovered.point.rate * 100).toFixed(1)}%`)
              : null,
            )
            : null,
        ),
        h('div', { className: 'tu-chart-axis' },
          h('span', null, points[0].label),
          h('span', null, `${formatValue(max)} ↑`),
          h('span', null, points[points.length - 1].label),
        ),
      )
    }

    /** 图表配色。按索引取，保证同一份数据每次渲染颜色一致。 */
    /**
     * 分类色板。
     *
     * 不用 `--dsw-alias-*` 语义 token：它们表达的是状态（成功/警告/错误），
     * 不是分类，深色主题里 `brand-primary` 甚至会渲染成近白色，画环形图
     * 会出现一条白弧。分类色因此用自己声明的 CSS 变量，并在样式表里给出
     * 亮/暗两套值（见 STYLE_TEXT 的 `[data-theme='dark']` 块）。
     */
    const SERIES_COLORS = [
      'var(--tu-c1)',
      'var(--tu-c2)',
      'var(--tu-c3)',
      'var(--tu-c4)',
      'var(--tu-c5)',
      'var(--tu-c6)',
      'var(--tu-c7)',
    ]

    /** 取第 index 个分类色。 */
    function seriesColor(index) {
      return SERIES_COLORS[index % SERIES_COLORS.length]
    }

    /**
     * 环形图（甜甜圈）。用于「模型用量占比」。
     *
     * 用 SVG 的 stroke-dasharray 画圆弧，不引入任何图表库；中点图标显示总量。
     * 图例单独用 DOM 渲染，因此长模型名可以换行、可以悬停高亮。
     */
    /**
     * 活动热力图：过去 8 周每天一格，颜色深浅代表当天用量。
     *
     * 一眼看出「我什么时候在用 AI」——趋势图看的是量，热力图看的是节奏。
     * 点击某天可以筛选到那天。
     */
    /**
     * 活动热力图。
     *
     * 布局取舍：热力图本身只有 8 周 × 7 天，约 150px 宽。独占一整行卡片
     * 会让右侧留下大片空白（就是之前「不协调」的来源）。这里做成两栏：
     * 左边热力图，右边配一组当期关键数字，把这条横向空间用满。
     *
     * @param {object} props
     * @param {object} props.byDay day -> counters
     * @param {object} props.summary 当期汇总（活跃天数、日均、峰值）
     */
    function ActivityHeatmap({ byDay, t, onPickDay, activeDay, summary }) {
      const WEEK = 7
      const days = Object.keys(byDay ?? {}).sort()
      // 固定 53 周（一年）。参考 GitHub 日历风：格子边长由容器宽度反算，
      // 一年 53 列正好把整行铺满（约 22px/格）；若只显示 10 周，
      // 每格会被撑到 100px 以上，变成一堆大方块。
      const WEEKS = 53
      // 格子边长上限 22px：超宽屏下不让格子无限变大，居中留白即可
      const MAX_CELL = 22
      const GAP = 3

      /** 月份标签：只在对齐月份第一周时显示，避免堆满。 */
      const monthLabel = (date) => `${date.getMonth() + 1}月`

      const head = h('div', { className: 'tu-heat-head' },
        h('span', { className: 'tu-heat-title' }, t('heat.title')),
        h('span', { className: 'tu-heat-sub' }, t('heat.subtitle')),
      )

      if (days.length === 0) {
        return h('div', { className: 'tu-heat' }, head,
          h('p', { className: 'tu-chart-empty' }, t('chart.empty')))
      }

      // 网格对齐到「周」：每一列必须是从周日开始的连续 7 天，
      // 否则行不对应固定星期（第 1 行有时是周三、有时是周六），
      // 热力图就失去了「每周节奏」这个最重要的读法。
      //
      // 做法：先算出窗口起点，再回退到它所在周的周日。
      const last = days[days.length - 1]
      const lastDate = new Date(`${last}T00:00:00`)
      const start = new Date(lastDate)
      start.setDate(start.getDate() - (WEEKS * WEEK - 1))
      // getDay(): 0=周日。回退到本周周日
      start.setDate(start.getDate() - start.getDay())

      const cells = []
      const cursor = new Date(start)
      let max = 0
      for (let i = 0; i < WEEKS * WEEK; i += 1) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
        const value = byDay[key]?.totalTokens ?? 0
        if (value > max) max = value
        cells.push({
          key,
          value,
          // 每列的第一天用于画月份标签；具体显示与否还要看月份有没有变
          isWeekStart: i % WEEK === 0,
          month: cursor.getMonth(),
          date: new Date(cursor),
        })
        cursor.setDate(cursor.getDate() + 1)
      }

      // 分 5 档着色。用「相对峰值」而不是绝对分位：
      // 用户关心的是「哪天比平常多」，不是精确的分位统计。
      const levelOf = (value) => {
        if (value <= 0 || max <= 0) return 0
        const ratio = value / max
        if (ratio <= 0.2) return 1
        if (ratio <= 0.4) return 2
        if (ratio <= 0.7) return 3
        return 4
      }

      return h('div', { className: 'tu-heat' },
        head,
        h('div', {
          className: 'tu-heat-body',
          style: {
            '--tu-heat-weeks': String(WEEKS),
            // 网格最大宽度 = 列数 × 上限边长 + 间隙，超宽屏时居中而不撑大格子
            '--tu-heat-maxw': `${WEEKS * MAX_CELL + (WEEKS - 1) * GAP}px`,
          },
        },
          h('div', { className: 'tu-heat-months' },
            // 月份标签两条规则同时满足才显示：
            //   ① 月份变了（同一月只标一次）
            //   ② 与上一个标签至少隔 2 列（否则跨月时「8月9月」会叠字）
            ...(() => {
              const labels = []
              let lastMonth = -1
              let lastColumn = -99
              cells.forEach((c, index) => {
                if (!c.isWeekStart) return
                const column = Math.floor(index / WEEK) + 1
                if (c.month === lastMonth) return
                if (column - lastColumn < 2) return
                lastMonth = c.month
                lastColumn = column
                labels.push(h('span', {
                  key: c.key,
                  className: 'tu-heat-month',
                  style: { gridColumn: String(column) },
                }, monthLabel(c.date)))
              })
              return labels
            })(),
          ),
          h('div', { className: 'tu-heat-grid' },
            ...cells.map((cell) => h('button', {
              key: cell.key,
              type: 'button',
              className: 'tu-heat-cell',
              'data-level': String(levelOf(cell.value)),
              'data-active': activeDay === cell.key ? 'true' : 'false',
              title: `${cell.key} · ${formatCompact(cell.value)} tokens`,
              onClick: () => onPickDay?.(cell.key),
            })),
          ),
          h('div', { className: 'tu-heat-foot' },
            h('span', null, t('heat.less')),
            ...[0, 1, 2, 3, 4].map((lv) =>
              h('i', { key: lv, className: 'tu-heat-dot', 'data-level': String(lv) })),
            h('span', null, t('heat.more')),
          ),
        ),
        // 三个关键数字：横排在热力图下方，不占右侧空间
        summary === undefined
          ? null
          : h('div', { className: 'tu-heat-summary' },
            ...(summary ?? []).map((item) => h('div', {
              key: item.label, className: 'tu-heat-stat',
            },
            h('span', {
              className: 'tu-heat-stat-value',
              'data-level': item.level,
            }, item.value),
            h('span', { className: 'tu-heat-stat-label' }, item.label),
            item.hint === undefined
              ? null
              : h('span', { className: 'tu-heat-stat-hint' }, item.hint),
            )),
          ),
      )
    }

    function DonutChart({ items, t, centerLabel }) {
      const total = items.reduce((sum, item) => sum + item.value, 0)
      if (total <= 0) {
        return h('div', { className: 'tu-chart-empty' }, t('chart.empty'))
      }
      const radius = 54
      const circumference = 2 * Math.PI * radius
      const [hoverIndex, setHoverIndex] = useState(-1)

      let offset = 0
      const arcs = items.map((item, index) => {
        const fraction = item.value / total
        const arc = {
          key: item.key,
          color: seriesColor(index),
          dash: `${(fraction * circumference).toFixed(3)} ${(circumference * (1 - fraction)).toFixed(3)}`,
          offset: -offset,
          fraction,
        }
        offset += fraction * circumference
        return arc
      })

      // 拆成局部变量再组装：深层嵌套的 h(...) 很容易数错括号，
      // 早先图例就被多出的一个右括号挤到 tu-pie 之外，导致它换行到圆环下方。
      const figure = h('div', { className: 'tu-pie-figure' },
        h('svg', {
          viewBox: '0 0 140 140',
          className: 'tu-pie-svg',
          role: 'img',
          'aria-label': t('chart.pie.title'),
        },
        h('g', { transform: 'translate(70,70) rotate(-90)' },
          h('circle', {
            r: radius, fill: 'none',
            stroke: 'var(--dsw-alias-border-l1)',
            strokeWidth: 16,
          }),
          arcs.map((arc, index) => h('circle', {
            key: arc.key,
            r: radius, fill: 'none',
            stroke: arc.color,
            strokeWidth: index === hoverIndex ? 20 : 16,
            strokeDasharray: arc.dash,
            strokeDashoffset: arc.offset,
            opacity: hoverIndex === -1 || hoverIndex === index ? 1 : 0.35,
            onMouseEnter: () => setHoverIndex(index),
            onMouseLeave: () => setHoverIndex(-1),
            style: { cursor: 'default', transition: 'stroke-width 120ms ease, opacity 120ms ease' },
          })),
        ),
        ),
        h('div', { className: 'tu-pie-center' },
          h('div', { className: 'tu-pie-total' }, formatCompact(total)),
          h('div', { className: 'tu-pie-total-label' }, centerLabel ?? t('chart.pie.total')),
        ),
      )

      const legend = h('ul', { className: 'tu-pie-legend' },
        items.map((item, index) => h('li', {
          key: item.key,
          className: 'tu-pie-legend-item',
          onMouseEnter: () => setHoverIndex(index),
          onMouseLeave: () => setHoverIndex(-1),
          'data-dim': hoverIndex !== -1 && hoverIndex !== index ? 'true' : 'false',
        },
        h('i', { className: 'tu-dot', style: { background: seriesColor(index) } }),
        h('span', { className: 'tu-pie-legend-name', title: item.label }, item.label),
        h('span', { className: 'tu-pie-legend-pct' }, `${((item.value / total) * 100).toFixed(1)}%`),
        h('span', { className: 'tu-pie-legend-value' }, formatCompact(item.value)),
        )),
      )

      return h('div', {
        className: 'tu-pie',
        style: {
          display: 'grid',
          gridTemplateColumns: '116px minmax(0, 1fr)',
          alignItems: 'center',
          gap: '16px',
          minWidth: 0,
        },
      }, figure, legend)

    }

    /**
     * 由 apply 填充：读当前语言、订阅语言变化。
     *
     * 放在 factory 作用域而不是 apply 里，因为面板组件要用它们注册订阅；
     * 用 ref 对象而不是普通变量，是为了让 apply 后写入的值能被已定义的
     * 闭包读到。
     */
    const localeReaderRef = { current: undefined }
    const localeSubscribeRef = { current: undefined }
    const localeNotifierRef = { current: undefined }

    /** 稳定的小哈希，用来生成唯一的 gradient id。 */
    function hashString(value) {
      let hash = 0
      for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) | 0
      }
      return hash
    }

    //#endregion

    /**
     * 配额进度条：展示「已用 / 上限」与重置时间。
     *
     * Kimi 与 GLM 的 Coding Plan 用时间窗口限流（5 小时、每周），
     * 只给一个百分比是不够的——用户更关心「什么时候恢复」。
     */
    function QuotaBar({ entry, t, locale }) {
      const used = Number(entry.used)
      const limit = Number(entry.limit)
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
      const ratio = Math.max(0, Math.min(1, used / limit))
      const percent = Math.round(ratio * 100)
      const left = Math.max(0, 100 - percent)

      // 重置时间：给绝对时间 + 相对倒计时，两者互补
      let resetText
      if (Number.isFinite(entry.resetsAt) && entry.resetsAt > 0) {
        const remainMs = entry.resetsAt - Date.now()
        if (remainMs > 0) {
          // 超过一天用「天」表达：周限/月限显示成 120h、432h 没法读
          const days = Math.floor(remainMs / 86_400_000)
          const hours = Math.floor((remainMs % 86_400_000) / 3_600_000)
          const minutes = Math.floor((remainMs % 3_600_000) / 60_000)
          let relative
          if (days > 0) relative = `${days}${t('unit.day')} ${hours}${t('unit.hour')}`
          else if (hours > 0) relative = `${hours}${t('unit.hour')} ${minutes}${t('unit.minute')}`
          else relative = `${minutes}${t('unit.minute')}`
          resetText = `${relative} ${t('quota.resetsIn')}`
        } else {
          // 已过重置点：数据已过期，提示重新查询（而不是留一个「重置于」空标签）
          resetText = t('quota.expired')
        }
      }

      return h('div', { className: 'tu-quota' },
        h('div', { className: 'tu-quota-head' },
          h('span', { className: 'tu-quota-label' }, entry.label ?? 'Quota'),
          h('span', { className: 'tu-quota-pct' },
            // 用「剩余」表述更直观；用尽时改用明确措辞
            left === 0 ? t('quota.exhausted') : `${left}% ${t('quota.left')}`),
        ),
        h('div', { className: 'tu-quota-bar' },
          h('div', {
            className: 'tu-quota-fill',
            'data-level': percent >= 95 ? 'danger' : percent >= 75 ? 'warn' : 'ok',
            style: { width: `${percent}%` },
          }),
        ),
        resetText === undefined
          ? null
          : h('div', { className: 'tu-quota-reset' }, resetText),
      )
    }

    /**
     * 历史扫描进度条。
     *
     * 首次安装要把已有会话日志全部补算一遍，耗时随会话数增长。这里给出
     * 明确进度（已扫描 / 总数 + 百分比），而不是让用户对着空统计猜。
     */
    function ScanProgress({ scan, t }) {
      if (scan === undefined || scan === null || scan.active !== true) return null
      const total = scan.total > 0 ? scan.total : 0
      const rawDone = scan.done ?? 0
      // total 已知时不该出现「已扫 > 总数」的读数
      const done = total > 0 ? Math.min(rawDone, total) : rawDone
      const percent = total > 0 ? Math.round((done / total) * 100) : 0
      return h('div', { className: 'tu-scan', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'tu-scan-head' },
          h('span', { className: 'tu-spinner', 'aria-hidden': true }),
          h('div', null,
            h('div', { className: 'tu-scan-title' }, t('scan.title')),
            h('div', { className: 'tu-scan-hint' }, t('scan.hint')),
          ),
        ),
        h('div', { className: 'tu-scan-bar' },
          h('div', {
            className: 'tu-scan-fill',
            // total 未知时用满格动画表示「进行中」，不假装有确定进度。
            'data-indeterminate': total > 0 ? 'false' : 'true',
            style: total > 0 ? { width: `${percent}%` } : undefined,
          }),
        ),
        h('div', { className: 'tu-scan-meta' },
          `${t('scan.progress')} ${done}${total > 0 ? ` / ${total}（${percent}%）` : ''}`,
        ),
      )
    }

    /** 通用表格。columns 描述列，rows 是已经投影好的行。 */
    function UsageTable({ columns, rows, emptyText }) {
      if (rows.length === 0) {
        return h('div', { className: 'tu-empty' }, emptyText)
      }
      return h('div', { className: 'tu-table-wrap' },
        h('table', { className: 'tu-table' },
          h('thead', null,
            h('tr', null, columns.map((column) =>
              h('th', { key: column.key }, column.label)))),
          h('tbody', null,
            rows.map((row, index) =>
              h('tr', { key: row.key ?? index },
                columns.map((column) =>
                  h('td', {
                    key: column.key,
                    className: column.main === true ? 'tu-cell-main' : undefined,
                    title: typeof row[column.key] === 'string' ? row[column.key] : undefined,
                  }, row[column.key]))))),
        ),
      )
    }

    /** 统计页主体。 */
    function TokenUsagePanel(props) {
      // 刷新间隔：从 localStorage 恢复用户上次的选择，读不到就用默认值。
      const [refreshMs, setRefreshMs] = useState(() => {
        try {
          const saved = window.localStorage?.getItem(REFRESH_STORAGE_KEY)
          if (saved !== null && saved !== undefined) {
            const parsed = Number(saved)
            if (Number.isFinite(parsed) && parsed >= 0) return parsed
          }
        } catch { /* 隐私模式下 localStorage 可能抛错 */ }
        return DEFAULT_REFRESH_MS
      })
      const changeRefresh = (next) => {
        setRefreshMs(next)
        try {
          window.localStorage?.setItem(REFRESH_STORAGE_KEY, String(next))
        } catch { /* 存不了就只在本次生效 */ }
      }

      const { status, data, error, refreshing, refresh } = useSummary(refreshMs)
      const [range, setRange] = useState('all')
      // 图表模式：合并一张图承载总量 / 命中率两种视角，省下纵向空间。
      const [chartMode, setChartMode] = useState('total')
      // 明细表当前视图：一次只显示一张表，用标签切换，取代纵向堆叠。
      const [tableView, setTableView] = useState('model')
      // 模型筛选（可多选）：空数组表示全部模型汇总。
      const [selectedModels, setSelectedModels] = useState([])
      // 下拉是否展开。
      const [modelMenuOpen, setModelMenuOpen] = useState(false)
      const dropdownRef = useRef(null)

      // 点击组件外部 / 按 Esc 时收起下拉。
      // 用户不必先回到箭头那里再点一次——这是常见交互预期。
      useEffect(() => {
        if (!modelMenuOpen) return undefined
        const onDocClick = (event) => {
          const host = dropdownRef.current
          if (host === null || host === undefined) return
          // contains 判断点击是否落在下拉内部；内部点击由菜单自己处理。
          if (typeof host.contains === 'function' && host.contains(event?.target)) return
          setModelMenuOpen(false)
        }
        const onKey = (event) => {
          if (event?.key === 'Escape') setModelMenuOpen(false)
        }
        document.addEventListener('mousedown', onDocClick)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDocClick)
          document.removeEventListener('keydown', onKey)
        }
      }, [modelMenuOpen])
      // 版本检查弹窗：{ kind: 'new' | 'same' | 'error', latest, message }
      const [versionDialog, setVersionDialog] = useState(null)
      // 「按日期」表的时间范围与分页。日期多时一次全渲染会很卡，
      // 所以默认每页 20 条，且允许按起止日期收窄。
      const [dayFrom, setDayFrom] = useState('')
      const [dayTo, setDayTo] = useState('')
      const [page, setPage] = useState(0)
      // 成本显示货币：默认 USD，点击卡片换算 RMB（用户明确要求）。
      const [currency, setCurrency] = useState('usd')
      // 补价弹窗：{ model, input, output } 或 null
      const [priceDialog, setPriceDialog] = useState(null)
      // 余额页：站点列表、探测中标记、手动配置表单
      const [balanceState, setBalanceState] = useState({ sites: [], discovered: [] })
      const [balanceProbing, setBalanceProbing] = useState('')
      const [balanceForm, setBalanceForm] = useState(null)
      // 别名管理：{ raw, display } 或 null（null 表示面板关闭）
      const [aliasForm, setAliasForm] = useState(null)
      // 顶层视图：统计 / 供应商。供应商是完整页面，不是明细里的标签。
      const [topView, setTopView] = useState('stats')
      // 供应商编辑表单：null 表示关闭
      const [supplierForm, setSupplierForm] = useState(null)
      /**
       * 预算编辑表单。
       *
       * null 表示还没打开过；打开时从 `data.config.budget` 初始化一份副本，
       * 用户改的是副本，点「保存预算」才写回 Host —— 中途取消不会影响已存配置。
       */
      const [budgetForm, setBudgetForm] = useState(null)
      const [budgetBusy, setBudgetBusy] = useState(false)
      const [budgetNotice, setBudgetNotice] = useState('')
      // 查看某个供应商的模型清单：{ siteId, label, models } 或 null
      const [modelsDialog, setModelsDialog] = useState(null)
      const [supplierBusy, setSupplierBusy] = useState('')
      const [supplierNotice, setSupplierNotice] = useState({ kind: '', text: '' })
      const PAGE_SIZE = 20
      const toggleModel = (name) => {
        setSelectedModels((current) => (current.includes(name)
          ? current.filter((item) => item !== name)
          : [...current, name]))
      }

      /** 选了「全部模型」等价于清空筛选，并收起下拉。 */
      const pickAllModels = () => {
        setSelectedModels([])
        setModelMenuOpen(false)
      }

      // 筛选下拉的选项：按模型名（跨 provider 合并），与占比图口径一致。
      const modelOptions = useMemo(() => {
        if (data?.byModelName === undefined) return []
        return Object.keys(data.byModelName)
      }, [data])

      const chartModes = [
        { id: 'total', labelKey: 'chart.mode.total' },
        { id: 'cache', labelKey: 'chart.mode.cache' },
        { id: 'compose', labelKey: 'chart.mode.compose' },
        { id: 'model', labelKey: 'chart.mode.model' },
        { id: 'cost', labelKey: 'chart.mode.cost' },
      ]

      // 版本与更新状态。这些动作会改变运行中的代码，因此每一步都在
      // 按钮上反映进度，失败时把原因原样展示，不做乐观假设。
      const [pluginVersion, setPluginVersion] = useState('')
      const [updateState, setUpdateState] = useState({
        busy: '', available: false, latest: '', checked: false, error: '',
        // 磁盘版本与运行版本不一致 = 需要重载才能生效。
        versionMismatch: false,
        // 更新进度阶段：'' | 'download' | 'install' | 'activate' | 'done'
        phase: '',
      })

      useEffect(() => {
        let disposed = false
        fetch(VERSION_ROUTE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((body) => {
            if (disposed || body === undefined) return
            setPluginVersion(String(body.version ?? ''))
            const updater = body.updater
            if (updater !== undefined && updater !== null) {
              setUpdateState((previous) => ({
                ...previous,
                latest: String(updater.latest ?? ''),
                available: updater.available === true,
                checked: (updater.checkedAt ?? 0) > 0,
                error: String(updater.error ?? ''),
                versionMismatch: updater.versionMismatch === true,
              }))
            }
          })
          .catch(() => { /* 版本路由不可用时静默：不影响统计功能 */ })
        return () => { disposed = true }
      }, [])

      /** 保存模型别名（display 为空表示清除）。 */
      const saveAlias = useCallback(async (raw, display) => {
        try {
          const response = await fetch(PRICING_ALIAS_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ model: raw, alias: display === '' ? null : display }),
          })
          if (!response.ok) return
          setAliasForm(null)
          void refresh()
        } catch { /* 忽略：用户可重试 */ }
      }, [refresh])

      /** 读取余额站点列表与自动发现的端点。 */
      const loadBalance = useCallback(async () => {
        try {
          const response = await fetch(BALANCE_ROUTE, {
            headers: { accept: 'application/json' }, credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!response.ok) return
          const body = await response.json()
          setBalanceState({
            sites: Array.isArray(body.sites) ? body.sites : [],
            discovered: Array.isArray(body.discovered) ? body.discovered : [],
          })
        } catch { /* 余额是辅助信息，加载失败不该影响主页面 */ }
      }, [])

      /** 查询某个站点的余额。 */
      const probeSite = useCallback(async (id) => {
        setBalanceProbing(id)
        try {
          const response = await fetch(BALANCE_PROBE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ id }),
          })
          const body = await response.json().catch(() => ({}))
          if (Array.isArray(body.sites)) {
            setBalanceState((previous) => ({ ...previous, sites: body.sites }))
          }
        } catch { /* 结果已记录在站点上，下次刷新可见 */ }
        finally { setBalanceProbing('') }
      }, [])

      /** 保存站点配置。 */
      const saveSite = useCallback(async (input) => {
        try {
          const response = await fetch(BALANCE_SITE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(input),
          })
          const body = await response.json().catch(() => ({}))
          if (Array.isArray(body.sites)) {
            setBalanceState((previous) => ({ ...previous, sites: body.sites }))
          }
          setBalanceForm(null)
        } catch { /* 静默：用户可重试 */ }
      }, [])

      /** 移除站点。 */
      const removeSite = useCallback(async (id) => {
        try {
          const response = await fetch(BALANCE_REMOVE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ id }),
          })
          const body = await response.json().catch(() => ({}))
          if (Array.isArray(body.sites)) {
            setBalanceState((previous) => ({ ...previous, sites: body.sites }))
          }
        } catch { /* 同上 */ }
      }, [])

      /** 保存手工补价（价格为 null 时删除，恢复自动匹配）。 */
      const savePriceOverride = useCallback(async (model, input, output) => {
        try {
          const price = (input === '' && output === '') ? null : {
            input: Number(input) / 1e6,
            output: Number(output) / 1e6,
          }
          const response = await fetch(PRICING_OVERRIDE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ model, price }),
          })
          if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            throw new Error(body.error ?? `HTTP ${response.status}`)
          }
          setPriceDialog(null)
          void refresh()
        } catch (error) {
          setUpdateState((previous) => ({ ...previous, error: error?.message ?? String(error) }))
        }
      }, [refresh])

      /** 触发价目表刷新（Host 是异步的，稍后自动重取快照）。 */
      const refreshPricing = useCallback(async () => {
        try {
          await fetch(PRICING_REFRESH_ROUTE, {
            method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
          })
          // 拉取要几秒，稍等再刷新快照
          setTimeout(() => { void refresh() }, 4000)
        } catch { /* 忽略：轮询会补上 */ }
      }, [refresh])

      // 进入余额视图时才加载（避免每次打开面板都多一个请求）。
      useEffect(() => {
        if (tableView === 'balance') void loadBalance()
      }, [tableView, loadBalance])

      const checkUpdate = useCallback(async () => {
        setUpdateState((previous) => ({ ...previous, busy: 'check', error: '' }))
        try {
          const response = await fetch(UPDATE_CHECK_ROUTE, {
            headers: { accept: 'application/json' }, credentials: 'same-origin',
            cache: 'no-store',
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
          const latest = String(body.latest ?? '')
          const available = body.available === true
          setUpdateState({
            busy: '', available, latest, checked: true,
            error: String(body.error ?? ''),
            versionMismatch: body.versionMismatch === true,
            // 保持与初始状态一致的字段形状。此前漏了 phase，导致它是
            // undefined，而渲染条件 `phase !== ''` 对 undefined 为真，
            // 于是「检查更新」的弹窗里会冒出「正在热重载」。
            phase: '',
          })
          // 用弹窗告知结果，而不是把结果默默写到某个角落。
          setVersionDialog({
            kind: available ? 'new' : 'same',
            latest,
            notes: String(body.notes ?? ''),
            message: String(body.error ?? ''),
          })
        } catch (error) {
          setUpdateState((previous) => ({ ...previous, busy: '', error: error?.message ?? String(error) }))
          setVersionDialog({ kind: 'error', latest: '', message: error?.message ?? String(error) })
        }
      }, [])

      const applyUpdate = useCallback(async () => {
        setUpdateState((previous) => ({ ...previous, busy: 'update', error: '' }))
        try {
          // Host 先回 202 再执行「下载 → 替换 → 热重载」。
          // 热重载会注销当前 fiber，所以这里不能等它完成，只能等受理确认。
          const response = await fetch(UPDATE_APPLY_ROUTE, {
            method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
          })
          if (!response.ok && response.status !== 202) {
            const body = await response.json().catch(() => ({}))
            throw new Error(body.error ?? `HTTP ${response.status}`)
          }
          // 轮询新版本落地：重载完成后 buildId 与版本号都会变，
          // 用它们确认升级真的生效，而不是凭「已受理」就当成功。
          const before = pluginVersion
          const startedAt = Date.now()
          setUpdateState((previous) => ({ ...previous, phase: 'download' }))
          for (let attempt = 0; attempt < 20; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500))
            // 进度是估算的：后端没有细粒度事件，按轮询次数推进阶段，
            // 让用户看到「在动」而不是一个静止的按钮。
            setUpdateState((previous) => ({
              ...previous,
              phase: attempt < 4 ? 'download' : attempt < 10 ? 'install' : 'activate',
            }))
            try {
              const probe = await fetch(VERSION_ROUTE, {
                headers: { accept: 'application/json' }, credentials: 'same-origin',
                cache: 'no-store',
              })
              if (probe.ok) {
                const info = await probe.json()
                // 失败信息只在 status 里：路由先回 202，失败不会体现在响应上。
                // 一旦看到失败就停止轮询并如实展示，尤其「需重装」要给出指引。
                const failure = info?.updater?.lastFailure
                if (failure !== undefined && failure !== null && (failure.at ?? 0) > startedAt) {
                  setUpdateState((previous) => ({
                    ...previous, busy: '', phase: '',
                    error: failure.message ?? '更新失败',
                  }))
                  setVersionDialog({
                    kind: failure.reinstall === true ? 'reinstall' : 'error',
                    latest: '',
                    message: failure.message ?? '',
                  })
                  return
                }
                if (String(info.version ?? '') !== before) {
                  const nextVersion = String(info.version)
                  setPluginVersion(nextVersion)
                  setUpdateState((previous) => ({
                    ...previous, busy: '', available: false, latest: '', phase: '',
                  }))
                  // 成功必须有明确反馈，而不是按钮变回原样就当成功。
                  setVersionDialog({ kind: 'success', latest: nextVersion, message: '' })
                  return
                }
              }
            } catch { /* 重载瞬间请求会失败，继续重试 */ }
          }
          setUpdateState((previous) => ({ ...previous, phase: '' }))
          setUpdateState((previous) => ({
            ...previous, busy: '',
            error: '更新已提交，但未检测到新版本生效；请手动重载或查看日志',
          }))
        } catch (error) {
          setUpdateState((previous) => ({
            ...previous, busy: '', error: error?.message ?? String(error),
          }))
        }
      }, [pluginVersion])

      const reloadPlugin = useCallback(async () => {
        setUpdateState((previous) => ({ ...previous, busy: 'reload', error: '' }))
        try {
          const response = await fetch(RELOAD_ROUTE, {
            method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
          setUpdateState((previous) => ({ ...previous, busy: '' }))
        } catch (error) {
          setUpdateState((previous) => ({
            ...previous, busy: '', error: error?.message ?? String(error),
          }))
        }
      }, [])

      // 文案与语言来自宿主的 locale 服务。语言在面板内订阅，因此用户切换
      // 语言时本页立刻跟随，不需要重开页面。
      const t = props?.t ?? ((key) => zh[key] ?? key)
      const locale = useLocaleId(props?.locale)

      /**
       * 指标区数据。
       *
       * 未筛选时直接用 Host 算好的总量；选中单一模型时，用该模型的按天序列
       * 在**当前时间窗**内重新汇总，这样指标卡能跟着时间段与模型一起变。
       */
      const totals = useMemo(() => {
        if (data === undefined) return undefined
        if (selectedModels.length === 0) return data.totals?.[range]
        // 选中的模型：把它们的每日**完整计数器**逐项相加。
        // Host 的 byModelDay 带全部字段，因此输入/输出/缓存/推理都能算出来
        // （早先只存 totalTokens，筛选后指标会全变 0）。
        const days = Object.keys(data.byDay ?? {}).sort()
        const from = range === 'today'
          ? [data.today]
          : range === 'week'
            ? days.slice(-7)
            : days
        const sum = {
          calls: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
        }
        for (const name of selectedModels) {
          const series = data.byModelDay?.[name] ?? {}
          for (const day of from) {
            const counters = series[day]
            if (counters === undefined) continue
            for (const key of Object.keys(sum)) {
              sum[key] += counters[key] ?? 0
            }
          }
        }
        return { ...sum, cacheHitRate: hitRateOf(sum) }
      }, [data, range, selectedModels])

      const rangeTabs = [
        { id: 'today', label: t('range.today') },
        { id: 'week', label: t('range.week') },
        { id: 'all', label: t('range.all') },
      ]

      // 按模型：把 provider/model 拆成两列，按总量降序。
      /**
       * 按当前模型筛选取出某个维度的聚合。
       *
       * 未筛选时直接用 Host 算好的全局桶；选了模型则把各模型的 facets 相加。
       * 这样占比图、项目表、来源表、账号表、日期表都会跟着筛选一起变，
       * 而不是只有指标卡刷新（用户实际反馈的问题）。
       */
      /**
       * 把原始模型名换成显示名。
       *
       * 明细表、占比图、趋势图都要用同一套映射，否则同一个模型在不同
       * 视图里叫不同名字，看起来像两条独立记录。
       */
      /** 从站点拉取模型列表（用于添加供应商时的勾选）。 */
      const fetchSupplierModels = useCallback(async (baseUrl, apiKey, id) => {
        setSupplierBusy('models')
        try {
          const response = await fetch(SUPPLIER_MODELS_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ baseUrl, apiKey, id }),
          })
          const body = await response.json().catch(() => ({}))
          if (body.ok === true && Array.isArray(body.models)) {
            setSupplierForm((current) => (current === null
              ? null
              : { ...current, available: body.models }))
          } else {
            setSupplierNotice({ kind: 'error', text: `${t('supplier.fetchFail')}：${body.error ?? ''}` })
          }
        } catch (error) {
          setSupplierNotice({ kind: 'error', text: `${t('supplier.fetchFail')}：${error?.message ?? error}` })
        } finally { setSupplierBusy('') }
      }, [t])

      /** 保存供应商并（可选）同步到 DSH 模型配置。 */
      const saveSupplier = useCallback(async (site, apiKey, doSync) => {
        setSupplierBusy('sync')
        try {
          const response = await fetch(SUPPLIER_SYNC_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ site, apiKey, sync: doSync !== false }),
          })
          const body = await response.json().catch(() => ({}))
          if (Array.isArray(body.sites)) {
            setBalanceState((previous) => ({ ...previous, sites: body.sites }))
          }
          if (body.ok === true) {
            setSupplierNotice({ kind: 'ok', text: t('supplier.syncOk') })
            setSupplierForm(null)
          } else {
            setSupplierNotice({ kind: 'error', text: `${t('supplier.syncFail')}：${body.error ?? ''}` })
          }
        } catch (error) {
          setSupplierNotice({ kind: 'error', text: `${t('supplier.syncFail')}：${error?.message ?? error}` })
        } finally { setSupplierBusy('') }
      }, [t])

      const displayModel = useCallback((rawName) => {
        if (typeof rawName !== 'string') return rawName
        const aliases = data?.modelAliases ?? {}
        return aliases[rawName] ?? rawName
      }, [data])

      /**
       * 当前时间段覆盖的日期。
       *
       * 空数组表示「不按时间过滤」（全部）。`today` 用 Host 给出的今天，
       * 避免客户端时区与 Host 不一致。
       */
      const rangeDays = useMemo(() => {
        if (data === undefined) return []
        if (range === 'all') return []
        const days = Object.keys(data.byDay ?? {}).sort()
        if (range === 'today') return data.today === undefined ? days.slice(-1) : [data.today]
        return days.slice(-7)
      }, [data, range])

      /** 空计数器工厂（与 Host 的 emptyCounters 字段一致）。 */
      const zeroCounters = () => ({
        calls: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
      })

      /** 把一组 counters 相加（就地累加进 target）。 */
      const accCounters = (target, counters) => {
        for (const field of Object.keys(target)) target[field] += counters?.[field] ?? 0
      }

      const facetOf = useCallback((facetKey) => {
        if (data === undefined) return {}
        const merged = {}
        if (selectedModels.length === 0) {
          // 全局视图：不需要时间过滤时直接用 Host 的桶，避免重复求和。
          if (facetKey !== 'day' && rangeDays.length === 0) {
            const map = {
              provider: data.byProvider,
              project: data.byProject,
              origin: data.byOrigin,
              account: data.accounts,
              day: data.byDay,
            }
            return map[facetKey] ?? {}
          }
          // day 维度特殊：`byDayFacets[day]` 里没有 day 这一层（它装的是
          // 该天内部的其他维度），日期本身就该直接读 byDay。
          // 早先这里统一走 byDayFacets，导致「按日期」视图恒为空。
          if (facetKey === 'day') {
            const source = data.byDay ?? {}
            const days = rangeDays.length === 0 ? Object.keys(source) : rangeDays
            for (const day of days) {
              const counters = source[day]
              if (counters === undefined) continue
              accCounters(merged[day] ?? (merged[day] = zeroCounters()), counters)
            }
            return merged
          }
          // 其他维度：把范围内每一天该维度的桶相加。
          for (const day of rangeDays.length === 0 ? Object.keys(data.byDay ?? {}) : rangeDays) {
            const byFacet = data.byDayFacets?.[day]?.[facetKey]
            if (byFacet === undefined) continue
            for (const [key, counters] of Object.entries(byFacet)) {
              accCounters(merged[key] ?? (merged[key] = zeroCounters()), counters)
            }
          }
          return merged
        }
        // 筛选视图：把选中模型该维度的桶相加，并按时间段过滤。
        const useDays = rangeDays.length > 0 || facetKey === 'day'
        for (const name of selectedModels) {
          const facets = data.byModelFacets?.[name]?.[facetKey]
          if (facets === undefined) continue
          for (const [key, counters] of Object.entries(facets)) {
            // day 维度的键就是日期，直接判断是否在范围内
            if (facetKey === 'day' && rangeDays.length > 0 && !rangeDays.includes(key)) continue
            accCounters(merged[key] ?? (merged[key] = zeroCounters()), counters)
          }
        }
        return merged
      }, [data, selectedModels, rangeDays])

      // 成本金额：按当前货币格式化。金额通常很小（几美元），
      // 用两位小数会显示成 0.00，所以小于 1 元时多给几位。
      const fx = data?.cost?.fx ?? {}
      const usdCny = Number(fx.usdCny) > 0 ? Number(fx.usdCny) : 7.2
      // 金额卡片跟随「今日/近 7 天/全部」：按范围内每天的成本相加。
      // Host 的 cost.byDay 已按峰谷分桶算好每天的成本（谷时价是峰时的一半），
      // 直接在客户端求和即可，不需要重算。
      const costUsd = (() => {
        const total = data?.cost?.totalUsd ?? 0
        if (rangeDays.length === 0) return total
        const byDay = data?.cost?.byDay ?? {}
        let sum = 0
        let hit = false
        for (const day of rangeDays) {
          const value = byDay[day]
          if (value === undefined) continue
          sum += value
          hit = true
        }
        return hit ? sum : total
      })()
      const costValue = currency === 'cny' ? costUsd * usdCny : costUsd

      /**
       * 预算进度。
       *
       * 与「余额」不同：余额看账户还剩多少，预算看这段时间花得快不快。
       * 只有当前范围是「今日」或「全部」时才显示月预算——「近 7 天」
       * 对不上任何一个预算窗口，硬套会误导。
       */
      const budgetInfo = (() => {
        const budget = data?.config?.budget ?? {}
        const daily = Number(budget.dailyUsd) > 0 ? Number(budget.dailyUsd) : 0
        const monthly = Number(budget.monthlyUsd) > 0 ? Number(budget.monthlyUsd) : 0
        if (daily === 0 && monthly === 0) return undefined
        const warnPercent = Number(budget.warnPercent) > 0 ? Number(budget.warnPercent) : 80

        // 选窗口：今日看日预算，全部看月预算；近 7 天不显示
        let limit = 0
        let used = 0
        let scope = ''
        if (range === 'today' && daily > 0) {
          limit = daily
          used = costUsd
          scope = 'daily'
        } else if (range === 'all' && monthly > 0) {
          limit = monthly
          // 本月累计：按 byDay 里本月日期累加
          const monthKey = typeof data?.today === 'string' ? data.today.slice(0, 7) : ''
          const byDay = data?.cost?.byDay ?? {}
          for (const [day, usd] of Object.entries(byDay)) {
            if (monthKey !== '' && day.startsWith(monthKey)) used += Number(usd) || 0
          }
          if (currency === 'cny') used *= usdCny
          if (currency === 'cny') limit *= usdCny
          scope = 'monthly'
        } else if (monthly > 0) {
          // 其他范围（如近 7 天）显示月预算，用本月累计
          const monthKey = typeof data?.today === 'string' ? data.today.slice(0, 7) : ''
          const byDay = data?.cost?.byDay ?? {}
          for (const [day, usd] of Object.entries(byDay)) {
            if (monthKey !== '' && day.startsWith(monthKey)) used += Number(usd) || 0
          }
          if (currency === 'cny') { used *= usdCny; limit = monthly * usdCny } else limit = monthly
          scope = 'monthly'
        }
        if (limit <= 0) return undefined
        if (scope === 'daily' && currency === 'cny') limit *= usdCny
        const ratio = limit > 0 ? used / limit : 0
        const percent = Math.round(ratio * 100)
        return {
          scope,
          label: t(scope === 'daily' ? 'budget.daily' : 'budget.monthly'),
          used,
          limit,
          ratio,
          percent,
          over: ratio >= 1,
          warn: ratio >= warnPercent / 100,
        }
      })()
      const costSymbol = currency === 'cny' ? '¥' : '$'
      const formatMoney = (value) => {
        const n = Number(value) || 0
        if (n === 0) return `${costSymbol}0`
        if (n < 0.01) return `${costSymbol}${n.toFixed(4)}`
        if (n < 1) return `${costSymbol}${n.toFixed(3)}`
        return `${costSymbol}${n.toFixed(2)}`
      }


      /** 毫秒 -> 可读时长：<1s 用 ms，否则用 s。 */
      const formatDuration = (ms) => {
        if (!Number.isFinite(ms) || ms <= 0) return '—'
        return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
      }

      const modelRows = useMemo(() => {
        if (data === undefined) return []
        // 时间段内按 provider/model 重新汇总。范围是「全部」时直接用 Host 的
        // 全量桶；否则遍历范围内的每一天累加（byDayModel 的形状是
        // day -> `${provider}/${model}` -> counters）。
        const scopedByModel = (() => {
          if (rangeDays.length === 0) return data.byModel ?? {}
          const summed = {}
          for (const day of rangeDays) {
            const byDay = data.byDayModel?.[day]
            if (byDay === undefined) continue
            for (const [key, counters] of Object.entries(byDay)) {
              accCounters(summed[key] ?? (summed[key] = zeroCounters()), counters)
            }
          }
          return summed
        })()
        return Object.entries(scopedByModel)
          .map(([key, counters]) => {
            const slash = key.indexOf('/')
            const rawModel = slash === -1 ? key : key.slice(slash + 1)
            // 别名：部分 provider 上报内部代号（Qoder 的 qfmodel 是队列
            // modelKey），不是真实模型名。映射后显示真实名，原始代号
            // 保留在 tooltip 里，避免信息丢失。
            const aliasedName = displayModel(rawModel)
            const aliased = aliasedName === rawModel ? undefined : aliasedName
            return {
              key,
              model: aliased ?? rawModel,
              modelHint: aliased === undefined ? undefined : `${rawModel} → ${aliased}`,
              provider: slash === -1 ? '—' : key.slice(0, slash),
              calls: formatNumber(counters.calls),
              input: formatNumber(counters.inputTokens),
              output: formatNumber(counters.outputTokens),
              cacheRead: formatNumber(counters.cacheReadTokens),
              reasoning: formatNumber(counters.reasoningTokens),
              // 命中率由 Host 统一算好；没有就用本地兜底，保证列不空。
              hitRate: `${Math.round((counters.cacheHitRate ?? hitRateOf(counters)) * 100)}%`,
              total: formatNumber(counters.totalTokens),
              // 成本：按当前货币显示；未定价的显示「—」并可点开补价。
              ...(() => {
                const costEntry = data?.cost?.byModel?.[key]
                const allCounters = data?.byModel?.[key]
                let usd = costEntry?.usd ?? 0
                // 按范围看时，成本按该范围的 token 占全量的比例折算。
                // 峰谷价差无法在客户端还原，所以这是估算值。
                if (rangeDays.length > 0 && allCounters !== undefined) {
                  const all = allCounters.totalTokens ?? 0
                  const part = counters.totalTokens ?? 0
                  usd = all > 0 ? usd * (part / all) : 0
                }
                const value = currency === 'cny' ? usd * usdCny : usd
                return {
                  cost: costEntry?.priced === false || costEntry === undefined
                    ? '—'
                    : `${costSymbol}${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`,
                  costRaw: value,
                  priced: costEntry?.priced === true,
                  modelName: slash === -1 ? key : key.slice(slash + 1),
                }
              })(),
              // 该模型的平均首字延迟与输出速度（按模型分桶）
              ...(() => {
                const perf = data?.performance?.byModel?.[key]
                return {
                  ttft: perf === undefined || perf.ttftMs === null
                    ? '—'
                    : formatDuration(perf.ttftMs),
                  tps: perf === undefined || perf.tps === null
                    ? '—'
                    : `${Math.round(perf.tps)}`,
                }
              })(),
              sortKey: counters.totalTokens ?? 0,
            }
          })
          .sort((a, b) => b.sortKey - a.sortKey)
      }, [data, currency, usdCny, costSymbol, displayModel, rangeDays])

      const providerRows = useMemo(() => {
        if (data === undefined) return []
        // 供应商列按**认证类别**归并，但只归并能判定的类别。
        //
        // 早先的实现把判定不出的也合并成一行「其他」，结果把 trae / qoder /
        // workbuddy 这些**已知的路由名**全吞掉了——表格里明明有名字却只剩
        // 「其他」，信息净损失。现在的规则：
        //   - 判定为 apikey / balance 的路由 -> 合并成对应类别一行
        //   - 判定不出的路由 -> **各自保留原路由名**，不做合并
        const kinds = data?.providerKinds ?? {}
        const rows = []
        const knownKinds = new Map()
        for (const [name, counters] of Object.entries(facetOf('provider'))) {
          const kind = kinds[name]
          if (kind === 'apikey' || kind === 'balance') {
            const existing = knownKinds.get(kind) ?? {
              key: kind,
              routes: [],
              calls: 0,
              input: 0,
              output: 0,
              total: 0,
            }
            existing.routes.push(name)
            existing.calls += counters.calls ?? 0
            existing.input += counters.inputTokens ?? 0
            existing.output += counters.outputTokens ?? 0
            existing.total += counters.totalTokens ?? 0
            knownKinds.set(kind, existing)
            continue
          }
          // 判定不出：保留原路由名，不合并
          rows.push({
            key: `route:${name}`,
            provider: name,
            routeHint: '',
            calls: counters.calls ?? 0,
            input: counters.inputTokens ?? 0,
            output: counters.outputTokens ?? 0,
            total: counters.totalTokens ?? 0,
          })
        }
        // 已判定的类别各自一行
        for (const [kind, row] of knownKinds) {
          rows.push({
            key: kind,
            provider: t(`providerKind.${kind}`),
            routeHint: row.routes.join(', '),
            calls: row.calls,
            input: row.input,
            output: row.output,
            total: row.total,
          })
        }
        return rows
          .map((row) => ({
            ...row,
            calls: formatNumber(row.calls),
            input: formatNumber(row.input),
            output: formatNumber(row.output),
            total: formatNumber(row.total),
            sortKey: row.total,
          }))
          .sort((a, b) => b.sortKey - a.sortKey)
      }, [data, facetOf, t])

      const dayRowsAll = useMemo(() => {
        if (data === undefined) return []
        return Object.entries(facetOf('day'))
          .map(([day, counters]) => ({
            key: day,
            date: day,
            calls: formatNumber(counters.calls),
            input: formatNumber(counters.inputTokens),
            output: formatNumber(counters.outputTokens),
            total: formatNumber(counters.totalTokens),
            sortKey: day,
          }))
          .sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1))
      }, [data, facetOf])

      // 日期范围过滤（含边界）。
      const dayRowsFiltered = useMemo(() => {
        if (dayFrom === '' && dayTo === '') return dayRowsAll
        return dayRowsAll.filter((row) => {
          if (dayFrom !== '' && row.key < dayFrom) return false
          if (dayTo !== '' && row.key > dayTo) return false
          return true
        })
      }, [dayRowsAll, dayFrom, dayTo])

      // 只在「按日期」视图分页，其它视图数据量小、直接全渲染。
      const pageCount = Math.max(1, Math.ceil(dayRowsFiltered.length / PAGE_SIZE))
      const safePage = Math.min(page, pageCount - 1)
      const dayRows = useMemo(() => {
        if (tableView !== 'day') return dayRowsFiltered
        const start = safePage * PAGE_SIZE
        return dayRowsFiltered.slice(start, start + PAGE_SIZE)
      }, [dayRowsFiltered, safePage, tableView])

      const sessionRows = useMemo(() => {
        if (data === undefined) return []
        // 会话成本：Host 的 bySession 只带 token，成本按「该会话用量占
        // 该 provider/model 全量的比例」折算 —— 峰谷差异无法在客户端还原，
        // 所以是估算值，列头会标注。
        const byModel = data.byModel ?? {}
        const costByModel = data.cost?.byModel ?? {}
        return Object.values(data.bySession ?? {})
          .map((entry) => {
            const counters = entry.counters ?? {}
            const key = `${entry.provider ?? 'unknown'}/${entry.model ?? 'unknown'}`
            const modelTotal = byModel[key]?.totalTokens ?? 0
            const modelCost = costByModel[key]?.usd ?? 0
            const priced = costByModel[key]?.priced === true
            const share = modelTotal > 0 ? (counters.totalTokens ?? 0) / modelTotal : 0
            const usd = priced ? modelCost * share : 0
            const value = currency === 'cny' ? usd * usdCny : usd
            return {
              key: entry.id,
              session: entry.title || t('noTitle'),
              provider: entry.provider ?? '—',
              model: entry.model ?? '—',
              lastUsed: formatTime(entry.lastAt, locale),
              total: formatNumber(counters.totalTokens ?? 0),
              cost: priced ? `${costSymbol}${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}` : '—',
              costRaw: value,
              sortKey: entry.lastAt ?? 0,
            }
          })
          .sort((a, b) => b.sortKey - a.sortKey)
          .slice(0, 200)
      }, [data, locale, t, currency, usdCny, costSymbol])


      // 按项目（工作目录）——路径太长，只显示末两段。
      const projectRows = useMemo(() => {
        if (data === undefined) return []
        return Object.entries(facetOf('project'))
          .map(([cwd, counters]) => ({
            key: cwd,
            project: shortPath(cwd),
            calls: formatNumber(counters.calls),
            input: formatNumber(counters.inputTokens),
            output: formatNumber(counters.outputTokens),
            hitRate: `${Math.round((counters.cacheHitRate ?? hitRateOf(counters)) * 100)}%`,
            total: formatNumber(counters.totalTokens),
            sortKey: counters.totalTokens ?? 0,
            fullPath: cwd,
          }))
          .sort((a, b) => b.sortKey - a.sortKey)
      }, [data, facetOf])

      // 按会话来源：主会话 / 子代理 / workflow。
      const originRows = useMemo(() => {
        if (data === undefined) return []
        return Object.entries(facetOf('origin'))
          .map(([origin, counters]) => ({
            key: origin,
            origin: t(`origin.${origin}`),
            calls: formatNumber(counters.calls),
            input: formatNumber(counters.inputTokens),
            output: formatNumber(counters.outputTokens),
            total: formatNumber(counters.totalTokens),
            sortKey: counters.totalTokens ?? 0,
          }))
          .sort((a, b) => b.sortKey - a.sortKey)
      }, [data, t, facetOf])

      // 账号分段。
      const accountRows = useMemo(() => {
        if (data === undefined) return []
        // 账号 id 是平台返回的 UUID，直接展示没有意义。当前登录账号有昵称时
        // 用它，否则退到一个可读的短标识；历史数据没有归属就标注清楚。
        const currentId = data?.currentAccount?.id
        const currentName = data?.currentAccount?.name
        return Object.entries(facetOf('account'))
          .map(([id, entry]) => {
            let account
            if (id === 'unknown') {
              account = t('account.unknown')
            } else if (currentId !== undefined && id === currentId && currentName) {
              // 就是当前登录账号 -> 显示昵称
              account = currentName
            } else if (currentId !== undefined && id === currentId) {
              // 是当前账号但没有昵称 -> 明确标注
              account = t('account.currentNoName')
            } else {
              // 别的账号（历史登录）-> 用短 id 便于区分，而不是整串 UUID
              account = t('account.otherAccount').replace('{id}', id.slice(0, 8))
            }
            return {
              key: id,
              account,
              calls: formatNumber(entry.calls ?? 0),
              input: formatNumber(entry.inputTokens ?? 0),
              output: formatNumber(entry.outputTokens ?? 0),
              total: formatNumber(entry.totalTokens ?? 0),
              firstSeen: formatTime(entry.firstAt, locale),
              sortKey: entry.totalTokens ?? 0,
            }
          })
          .sort((a, b) => b.sortKey - a.sortKey)
      }, [data, locale, t, facetOf])

      // 环形图数据：按模型总量降序，取前 6 个，其余合并为「其他」，
      // 避免图例出现几十行、色板循环撞色。
      const modelPieItems = useMemo(() => {
        if (data === undefined) return []
        // 选中若干模型时，占比图只显示这些模型（其余隐藏），
        // 这样它与明细表、图表的口径保持一致。
        if (selectedModels.length > 0) {
          const source = data.byModelName ?? {}
          return selectedModels
            .filter((name) => (source[name]?.totalTokens ?? 0) > 0)
            .map((name) => ({ key: name, label: name, value: source[name].totalTokens }))
            .sort((a, b) => b.value - a.value)
        }
        // 用**模型名合并视图**：同一模型挂在多个供应商下时合并成一个扇区，
        // 否则环上会出现多个同名扇区、占比也被拆散。按供应商拆分看明细表。
        // 选了时间段就按范围内的每天重新汇总，让环图跟着变。
        const source = (() => {
          if (rangeDays.length === 0) return data.byModelName ?? {}
          const summed = {}
          for (const day of rangeDays) {
            const byName = data.byDayModelName?.[day]
            if (byName === undefined) continue
            for (const [name, counters] of Object.entries(byName)) {
              accCounters(summed[name] ?? (summed[name] = zeroCounters()), counters)
            }
          }
          return summed
        })()
        // 按显示名合并：两个代号映射到同一真实模型时应合成一个扇区。
        const mergedByName = {}
        for (const [rawName, counters] of Object.entries(source)) {
          const display = displayModel(rawName)
          const target = mergedByName[display] ?? { key: display, value: 0 }
          target.value += counters.totalTokens ?? 0
          mergedByName[display] = target
        }
        const entries = Object.values(mergedByName)
          .filter((item) => item.value > 0)
          .sort((a, b) => b.value - a.value)
        const top = entries.slice(0, 6).map((item) => ({
          key: item.key,
          label: item.key,
          value: item.value,
        }))
        const rest = entries.slice(6)
        if (rest.length > 0) {
          top.push({
            key: '__rest__',
            label: `${t('chart.pie.rest')} (${rest.length})`,
            value: rest.reduce((sum, item) => sum + item.value, 0),
          })
        }
        return top
      }, [data, t, selectedModels, displayModel, rangeDays])

      // 图表数据：按天升序。trend 由 Host 预先算好命中率，这里只做投影。
      const trendSeries = useMemo(() => {
        // 趋势图只画当前时间段内的点。选「今日」时只有一天，
        // TrendChart 会退化为单点显示（见该组件对 length===1 的处理）。
        const days = (rangeDays.length > 0 ? rangeDays : Object.keys(data?.byDay ?? {}))
          .slice()
          .sort()
        // 选中模型时，趋势图换成所选模型的合并曲线。
        if (selectedModels.length > 0) {
          return days
            .map((day) => {
              const merged = {
                label: day.slice(5), total: 0, calls: 0,
                input: 0, cacheRead: 0, output: 0,
              }
              for (const name of selectedModels) {
                const counters = data?.byModelDay?.[name]?.[day]
                if (counters === undefined) continue
                merged.total += counters.totalTokens ?? 0
                merged.calls += counters.calls ?? 0
                merged.input += counters.inputTokens ?? 0
                merged.cacheRead += counters.cacheReadTokens ?? 0
                merged.output += counters.outputTokens ?? 0
              }
              merged.rate = merged.cacheRead + merged.input > 0
                ? merged.cacheRead / (merged.cacheRead + merged.input)
                : 0
              return merged
            })
        }
        if (data?.trend === undefined) return []
        const trendEntries = Object.entries(data.trend).sort((a, b) => (a[0] < b[0] ? -1 : 1))
        return (rangeDays.length > 0
          ? trendEntries.filter(([day]) => rangeDays.includes(day))
          : trendEntries)
          .map(([day, counters]) => ({
            label: day.slice(5),
            day,
            total: counters.totalTokens ?? 0,
            // 悬停提示要显示当天调用次数，缺了它会恒显示 0。
            calls: counters.calls ?? 0,
            input: counters.inputTokens ?? 0,
            cacheRead: counters.cacheReadTokens ?? 0,
            output: counters.outputTokens ?? 0,
            rate: counters.cacheHitRate ?? 0,
            // 当天成本（美元）。成本趋势与 token 趋势不是一回事——
            // 峰谷价和模型混用会让两条线分叉。
            costUsd: (data?.cost?.byDay ?? {})[day] ?? 0,
          }))
      }, [data, selectedModels, rangeDays])

      // 右上角工具区：Star / 检查更新 / 重载，与刷新按钮并排。
      const starsUrl = props?.repositoryUrl ?? data?.repositoryUrl
      const headTools = h('div', { className: 'tu-actions' },
        starsUrl !== undefined && starsUrl !== null
          ? h('a', {
            className: 'tu-button tu-button-primary tu-star',
            href: starsUrl,
            target: '_blank',
            rel: 'noreferrer noopener',
          }, h('span', { className: 'tu-star-icon', 'aria-hidden': true }, '★'), t('version.star'))
          : null,
        // 版本指示本身就是按钮：点击即检查更新，结果用弹窗告知。
        // 不再单独放一个「检查更新」按钮——按钮和它要表达的状态挤在一起，
        // 既占地方又要用户先点按钮再看状态，多一跳。
        h('button', {
          type: 'button',
          className: 'tu-verbtn',
          disabled: updateState.busy !== '',
          onClick: () => { void checkUpdate() },
          title: t('version.check'),
        },
        h('span', {
          className: 'tu-verdot',
          // 颜色语义：绿 = 已是最新，蓝 = 有新版本，灰 = 未检查。
          // 三者都不是错误状态，所以不用红色。
          'data-state': updateState.available === true
            ? 'new'
            : updateState.checked === true ? 'ok' : 'unknown',
        }),
        h('code', { className: 'tu-vercode' }, pluginVersion || '—'),
        updateState.busy === 'check'
          ? h('span', { className: 'tu-verbusy' }, t('version.checking'))
          : null,
        updateState.available === true && updateState.latest !== ''
          ? h('span', { className: 'tu-verlatest' }, `→ ${updateState.latest}`)
          : null,
        ),
        // 「重载插件」只在真正需要时出现：磁盘上的版本已经变了、但运行中的
        // 还是旧代码（versionMismatch）。平时它是多余的一个按钮——更新流程
        // 本身就包含热重载，不需要用户再点一次。
        updateState.versionMismatch === true
          ? h('button', {
            type: 'button', className: 'tu-button', disabled: updateState.busy !== '',
            onClick: () => { void reloadPlugin() },
            title: t('version.reloadWhy'),
          }, updateState.busy === 'reload' ? t('version.reloading') : t('version.reload'))
          : null,
      )

      const head = h('div', { className: 'tu-head' },
        h('div', null,
          h('h1', { className: 'tu-title' }, t('panel.title')),
          h('p', { className: 'tu-subtitle' }, t('panel.subtitle')),
        ),
        h('div', { className: 'tu-headtools' },
          h('label', { className: 'tu-refresh' },
            h('span', { className: 'tu-refresh-label' }, t('refresh.label')),
            h('select', {
              className: 'tu-select',
              value: String(refreshMs),
              onChange: (event) => changeRefresh(Number(event.target.value)),
              'aria-label': t('refresh.label'),
            },
            REFRESH_OPTIONS.map((option) => h('option', {
              key: option.id,
              value: String(option.id),
            }, t(option.labelKey))),
            ),
          ),
          h('button', {
            type: 'button',
            className: 'tu-button',
            onClick: refresh,
            disabled: refreshing,
          }, refreshing ? t('refreshing') : t('refresh')),
          headTools,
        ),
      )


      const scanBar = h(ScanProgress, { scan: data?.scan, t })

      if (status === 'loading') {
        return h('div', { className: 'tu-root' }, head,
          // 首次读取时也可能正处在回扫阶段，一并显示进度。
          h(ScanProgress, { scan: data?.scan, t }),
          h('div', { className: 'tu-empty' },
            h('span', { className: 'tu-spinner', 'aria-hidden': true }),
            t('loading')))
      }

      if (status === 'error') {
        return h('div', { className: 'tu-root' }, head,
          h('div', { className: 'tu-error' },
            h('span', null, `${t('error')}：${error ?? ''}`),
            h('button', { type: 'button', className: 'tu-button', onClick: refresh }, t('retry')),
          ))
      }

      const empty = isEmpty(data?.totals?.all)


      // 顶层视图切换：统计 / 模型接入。
      const viewTabs = h('div', { className: 'tu-viewtabs' },
        h('button', {
          type: 'button', className: 'tu-viewtab',
          'data-active': topView === 'stats' ? 'true' : 'false',
          onClick: () => setTopView('stats'),
        }, t('view.stats')),
        h('button', {
          type: 'button', className: 'tu-viewtab',
          'data-active': topView === 'suppliers' ? 'true' : 'false',
          onClick: () => {
            setTopView('suppliers')
            void loadBalance()
          },
        }, t('view.suppliers')),
        h('button', {
          type: 'button', className: 'tu-viewtab',
          'data-active': topView === 'budget' ? 'true' : 'false',
          onClick: () => setTopView('budget'),
        }, t('view.budget')),
      )

      const tabs = h('div', { className: 'tu-filterbar' },
        h('div', { className: 'tu-tabs' },
          rangeTabs.map((tab) =>
            h('button', {
              key: tab.id,
              type: 'button',
              className: 'tu-tab',
              'data-active': range === tab.id ? 'true' : 'false',
              onClick: () => setRange(tab.id),
            }, tab.label)),
        ),
        // 模型筛选：下拉面板 + 复选行。芯片平铺会占满整行（模型多时尤其
        // 拥挤），收进下拉里更整齐，同时也支持多选与逐个取消。
        modelOptions.length > 0
          ? h('div', { className: 'tu-dropdown', ref: dropdownRef },
            h('span', { className: 'tu-refresh-label' }, t('filter.model')),
            h('button', {
              type: 'button',
              className: 'tu-dropbtn',
              'data-open': modelMenuOpen ? 'true' : 'false',
              onClick: () => setModelMenuOpen((open) => !open),
              'aria-expanded': modelMenuOpen ? 'true' : 'false',
            },
            h('span', { className: 'tu-dropbtn-text' },
              selectedModels.length === 0
                ? t('filter.allModels')
                : selectedModels.length === 1
                  ? selectedModels[0]
                  : `${t('filter.selectedCount')} ${selectedModels.length}`),
            h('span', { className: 'tu-caret', 'aria-hidden': true }, '▾'),
            ),
            modelMenuOpen
              ? h('div', { className: 'tu-dropmenu' },
                h('button', {
                  type: 'button',
                  className: 'tu-dropitem',
                  'data-checked': selectedModels.length === 0 ? 'true' : 'false',
                  onClick: pickAllModels,
                }, h('span', { className: 'tu-check' }, selectedModels.length === 0 ? '✓' : ''), t('filter.allModels')),
                modelOptions.map((name) => h('button', {
                  key: name,
                  type: 'button',
                  className: 'tu-dropitem',
                  'data-checked': selectedModels.includes(name) ? 'true' : 'false',
                  title: name,
                  onClick: () => toggleModel(name),
                }, h('span', { className: 'tu-check' }, selectedModels.includes(name) ? '✓' : ''), name)),
              )
              : null,
          )
          : null,
      )

      /**
       * 平均首字延迟。没有采样时返回 undefined，卡片显示「—」。
       *
       * 只从实时事件累计，历史数据补不出来——所以值很可能比调用次数少，
       * 这是预期行为，不是 bug。
       */
      const ttftAverage = (() => {
        const perf = data?.performance?.total
        if (perf === undefined || perf === null || perf.ttftMs === null) return undefined
        const ms = perf.ttftMs
        if (!Number.isFinite(ms) || ms <= 0) return undefined
        return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
      })()

      const cards = h('div', { className: 'tu-cards' },
        h(MetricCard, { label: t('field.total'), value: totals?.totalTokens ?? 0, accent: true }),
        // 成本卡片：整张卡可点，点击在 USD / RMB 之间切换。
        h('div', {
          className: 'tu-card tu-card-cost',
          title: t('currency.toggleTitle'),
          role: 'button',
          tabIndex: 0,
          onClick: () => setCurrency((current) => (current === 'usd' ? 'cny' : 'usd')),
          onKeyDown: (event) => {
            if (event?.key === 'Enter' || event?.key === ' ') {
              event.preventDefault?.()
              setCurrency((current) => (current === 'usd' ? 'cny' : 'usd'))
            }
          },
        },
        h('div', { className: 'tu-card-label' },
          `${t('field.cost')} · ${currency === 'cny' ? t('currency.cny') : t('currency.usd')}`),
        h('div', { className: 'tu-card-value' },
          formatMoney(costValue)),
        // 预算进度：给花费一个参照系。没有配置预算时完全不显示。
        ),
        h(MetricCard, {
          label: t('field.cacheHitRate'),
          value: Math.round((totals?.cacheHitRate ?? 0) * 100),
          rate: true,
          suffix: '%',
        }),
        h(MetricCard, { label: t('field.input'), value: totals?.inputTokens ?? 0 }),
        h(MetricCard, { label: t('field.output'), value: totals?.outputTokens ?? 0 }),
        h(MetricCard, { label: t('field.cacheRead'), value: totals?.cacheReadTokens ?? 0 }),
        // 「缓存写」换成「平均首字」：
        // DeepSeek 的计费只有「缓存命中 / 未命中」两档，没有独立的缓存写，
        // 各 provider 也都不上报 cacheWriteTokens —— 那个卡片恒为 0，
        // 占着位置没有信息量。首字延迟才是真正关心调用质量的指标。
        h(MetricCard, {
          label: t('field.avgTtft'),
          value: ttftAverage ?? '—',
          raw: true,
        }),
        h(MetricCard, { label: t('field.reasoning'), value: totals?.reasoningTokens ?? 0 }),
        h(MetricCard, { label: t('field.calls'), value: totals?.calls ?? 0 }),
      )

      /**
       * 分组预算进度条。
       *
       * 每个分组是「这些模型的合计额度」。模型名匹配同时接受原始名与
       * 别名后的显示名 —— 用户填 `deepseek-flash` 或 `deepseek-v4.1-flash`
       * 都能命中（别名在 displayModel 里统一）。
       */
      const budgetGroupBars = (() => {
        const groups = data?.config?.budget?.groups ?? []
        if (groups.length === 0) return null
        const byModel = data?.byModel ?? {}
        const rows = []
        // 该分组在当前时间段内的花销。
        //
        // 必须按范围算，不能拿全量历史去比日预算 —— 那会算出几千个百分点，
        // 数字本身没错，但语义完全错了。做法是逐天累加：当天成本 ×
        // 该组 token 占当天总量的比例。
        const dayCost = data?.cost?.byDay ?? {}
        const dayModel = data?.byDayModel ?? {}
        const costByModel = data?.cost?.byModel ?? {}
        const coveredDays = rangeDays.length === 0
          ? Object.keys(data?.byDay ?? {})
          : rangeDays

        for (const group of groups) {
          // 该分组覆盖哪些 provider/model 键
          const members = Object.keys(byModel).filter((key) => {
            const slash = key.indexOf('/')
            const rawName = slash === -1 ? key : key.slice(slash + 1)
            const shown = displayModel(rawName)
            return (group.models ?? []).some((name) => name === rawName || name === shown || name === key)
          })
          if (members.length === 0) continue
          // 组内全是未定价模型时没有可比的成本，跳过而不是显示 0
          if (!members.some((key) => costByModel[key]?.priced === true)) continue

          let used = 0
          for (const day of coveredDays) {
            const counters = dayModel[day]
            if (counters === undefined) continue
            const dayTotal = dayCost[day] ?? 0
            if (dayTotal <= 0) continue
            const allTokens = Object.values(counters).reduce((sum, c) => sum + (c.totalTokens ?? 0), 0)
            if (allTokens <= 0) continue
            let groupTokens = 0
            for (const key of members) groupTokens += counters[key]?.totalTokens ?? 0
            used += dayTotal * (groupTokens / allTokens)
          }

          // 窗口：今日看日预算（没设就跳过），其余看月预算
          const daily = Number(group.dailyUsd) > 0 ? Number(group.dailyUsd) : 0
          const monthly = Number(group.monthlyUsd) > 0 ? Number(group.monthlyUsd) : 0
          let limit = 0
          let label = ''
          if (range === 'today') {
            if (daily <= 0) continue
            limit = daily
            label = t('budget.daily')
          } else {
            if (monthly <= 0) continue
            limit = monthly
            label = t('budget.monthly')
          }
          let shownUsed = used
          if (currency === 'cny') { shownUsed *= usdCny; limit *= usdCny }
          const ratio = limit > 0 ? shownUsed / limit : 0
          const percent = Math.round(ratio * 100)
          const over = ratio >= 1
          const warn = ratio >= 0.8
          rows.push(h('div', { key: group.id, className: 'tu-budget-group' },
            h('span', { className: 'tu-budget-group-name', title: (group.models ?? []).join(', ') }, group.label),
            h('div', { className: 'tu-budget', 'data-level': over ? 'over' : warn ? 'warn' : 'ok' },
              h('div', { className: 'tu-budget-bar' },
                h('div', {
                  className: 'tu-budget-fill',
                  style: { width: `${Math.min(100, percent)}%` },
                }),
              ),
              h('div', { className: 'tu-budget-text' },
                // 超支后百分比的参考价值就没了（真实值可能上千），
                // 改成直接说超出多少钱，比一个吓人的百分比有用。
                over
                  ? `${label} · ${t('budget.over')} ${formatMoney(shownUsed - limit)}`
                  : `${label} ${percent}% · ${t('budget.left')} ${formatMoney(limit - shownUsed)}`),
            ),
          ))
        }
        return rows.length === 0 ? null : h('div', { className: 'tu-budget-groups' }, ...rows)
      })()

      const modelColumns = [
        { key: 'model', label: t('column.model'), main: true },
        { key: 'provider', label: t('column.provider') },
        { key: 'calls', label: t('field.calls') },
        { key: 'input', label: t('field.input') },
        { key: 'output', label: t('field.output') },
        { key: 'cacheRead', label: t('field.cacheRead') },
        { key: 'reasoning', label: t('field.reasoning') },
        { key: 'hitRate', label: t('field.cacheHitRate') },
        { key: 'total', label: t('field.total') },
        // 性能两列：来自实时事件时间戳，历史数据补不出来，缺值显示「—」
        { key: 'ttft', label: t('column.ttft') },
        { key: 'tps', label: t('column.tps') },
        { key: 'cost', label: t('column.cost') },
      ]

      const providerColumns = [
        { key: 'provider', label: t('column.providerKind'), main: true },
        { key: 'calls', label: t('field.calls') },
        { key: 'input', label: t('field.input') },
        { key: 'output', label: t('field.output') },
        { key: 'total', label: t('field.total') },
      ]

      const dayColumns = [
        { key: 'date', label: t('column.date'), main: true },
        { key: 'calls', label: t('field.calls') },
        { key: 'input', label: t('field.input') },
        { key: 'output', label: t('field.output') },
        { key: 'total', label: t('field.total') },
      ]

      const projectColumns = [
        { key: 'project', label: t('column.project'), main: true },
        { key: 'calls', label: t('field.calls') },
        { key: 'input', label: t('field.input') },
        { key: 'output', label: t('field.output') },
        { key: 'hitRate', label: t('field.cacheHitRate') },
        { key: 'total', label: t('field.total') },
        { key: 'cost', label: t('column.cost') },
      ]

      const originColumns = [
        { key: 'origin', label: t('column.origin'), main: true },
        { key: 'calls', label: t('field.calls') },
        { key: 'input', label: t('field.input') },
        { key: 'output', label: t('field.output') },
        { key: 'total', label: t('field.total') },
      ]

      const accountColumns = [
        { key: 'account', label: t('column.account'), main: true },
        { key: 'calls', label: t('field.calls') },
        { key: 'input', label: t('field.input') },
        { key: 'output', label: t('field.output') },
        { key: 'firstSeen', label: t('column.firstSeen') },
        { key: 'total', label: t('field.total') },
      ]

      const sessionColumns = [
        { key: 'session', label: t('column.session'), main: true },
        { key: 'model', label: t('column.model') },
        { key: 'lastUsed', label: t('column.lastUsed') },
        { key: 'total', label: t('field.total') },
        // 成本按模型单价折算，峰谷差异还原不了，所以是估算
        { key: 'cost', label: `${t('column.cost')}≈` },
      ]

      // 版本条：当前版本、检查更新、更新并重载、直接重载。
      // 这三个动作都走插件自己的同源路由，不需要任何 Remote 类型定义。
      // 版本条只留版本号（更新状态改在右上角提示），避免占掉一整行。

      // 账号条：当前登录身份、余额、官方用量入口。
      const account = data?.currentAccount
      const accountBar = account === undefined || account === null
        ? null
        : h('div', { className: 'tu-account' },
          h('span', { className: 'tu-account-label' }, t('account.current')),
          h('strong', { className: 'tu-account-name' }, account.name || account.id || '—'),
          (account.balance ?? []).map((wallet) =>
            h('span', { key: wallet.currency, className: 'tu-account-balance' },
              // 平台返回的是高精度小数字符串，格式化后再显示，
              // 否则会出现 10.00000000000000000 这种长尾
              `${t('account.balance')} ${formatMoneyText(wallet.balance)} ${wallet.currency}`)),
          account.usageUrl !== null && account.usageUrl !== undefined
            ? h('a', {
              className: 'tu-link',
              href: account.usageUrl,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, t('account.usagePage'))
            : null,
          account.topUpUrl !== null && account.topUpUrl !== undefined
            ? h('a', {
              className: 'tu-link',
              href: account.topUpUrl,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, t('account.topUp'))
            : null,
        )

      // 失败请求：次数（以及上游真计费时的 token）。
      // 失败请求：Host 默认不返回（适配器在失败路径上报全 0 usage，
      // 这个维度只能给次数、给不出消耗）。开启 trackFailedAttempts 后才渲染。
      const failed = data?.failedAttempts
      const failedBar = failed === null || failed === undefined || (failed.count ?? 0) === 0
        ? null
        : h('div', { className: 'tu-failed' },
          h('span', null, `${t('failed.count')}：${formatNumber(failed.count)}`),
          (failed.billable ?? 0) > 0
            ? h('span', null, `${t('failed.billable')}：${formatNumber(failed.billable)}（${t('failed.tokens')} ${formatCompact(failed.totalTokens ?? 0)}）`)
            : null,
          h('span', { className: 'tu-failed-note' }, t('failed.note')),
        )

      // 图表区块：两张折线 + 一张堆积图。数据点太少时不画（没有信息量）。
      // 「按模型」模式依赖 modelTrend，其它模式依赖 trendSeries。
      const hasModelTrend = (data?.modelTrend?.series?.length ?? 0) > 0
        && (data?.modelTrend?.days?.length ?? 0) >= 2
      const showCharts = !empty && (trendSeries.length >= 2 || hasModelTrend)
      // 图表区：一张可切换模式的主趋势图 + 一张模型占比环形图。
      // 原先三张独立图表占用大量纵向空间，合并后腾出的位置用于更多指标。
      /**
       * 活动热力图。
       *
       * 点击某天会切到「按日期」明细并定位到那天——比只看颜色更有用。
       */
      /**
       * 热力图右侧的关键数字。
       *
       * 热力图回答「什么时候在用」，但看颜色答不了「到底多少」。
       * 这组数字把当期（按 rangeDays 过滤）的量补上，顺便填满横向空间。
       */
      const heatSummary = (() => {
        if (data === undefined) return undefined
        const byDay = data.byDay ?? {}
        const days = (rangeDays.length > 0 ? rangeDays : Object.keys(byDay))
          .filter((day) => byDay[day] !== undefined)
        if (days.length === 0) return undefined
        let tokenSum = 0
        let activeDays = 0
        let peakDay = ''
        let peakValue = 0
        for (const day of days) {
          const value = byDay[day]?.totalTokens ?? 0
          tokenSum += value
          if (value > 0) activeDays += 1
          if (value > peakValue) { peakValue = value; peakDay = day }
        }
        const average = activeDays > 0 ? tokenSum / activeDays : 0
        const items = [
          { label: t('heat.days'), value: `${activeDays} / ${days.length}` },
          { label: t('heat.average'), value: formatCompact(average) },
          {
            label: t('heat.peak'),
            value: formatCompact(peakValue),
            hint: peakDay === '' ? undefined : peakDay.slice(5),
          },
        ]
        // 预算放在这里而不是成本卡片里：卡片高度一致，且这排本来就是
        // 「当期关键数字」——预算正是当期最该看的那个。
        // 性能指标：来自实时事件时间戳。历史数据没有分片时间戳，
        // 回扫补不出来，所以可能为 null —— 显示「—」而不是假 0。
        // 只放输出速度：平均首字已经提到上面的指标卡区了，
        // 两处都显示同一个数字是冗余。
        const perf = data?.performance?.total
        if (perf !== undefined && perf !== null) {
          items.push({
            label: t('heat.tps'),
            value: Number.isFinite(perf.tps) && perf.tps > 0
              ? `${Math.round(perf.tps)} tok/s`
              : '—',
          })
        }
        if (budgetInfo !== undefined) {
          items.push({
            label: budgetInfo.label,
            value: `${budgetInfo.percent}%`,
            hint: budgetInfo.over
              ? `${t('budget.over')} ${formatMoney(budgetInfo.used - budgetInfo.limit)}`
              : `${t('budget.left')} ${formatMoney(Math.max(0, budgetInfo.limit - budgetInfo.used))}`,
            level: budgetInfo.over ? 'over' : budgetInfo.warn ? 'warn' : 'ok',
          })
        }
        return items
      })()

      const heatmap = empty
        ? null
        : h(ActivityHeatmap, {
          byDay: data?.byDay,
          t,
          summary: heatSummary,
          activeDay: dayFrom,
          onPickDay: (day) => {
            setTableView('day')
            setDayFrom(day)
            setDayTo(day)
            setPage(0)
          },
        })

      const charts = showCharts
        ? h('div', { className: 'tu-grid-2' },
          h('section', { className: 'tu-section' },
            h('div', { className: 'tu-section-head' },
              h('h2', { className: 'tu-section-title' }, t('chart.title')),
              h('div', { className: 'tu-tabs tu-tabs-sm' },
                chartModes.map((option) => h('button', {
                  key: option.id,
                  type: 'button',
                  className: 'tu-tab',
                  'data-active': chartMode === option.id ? 'true' : 'false',
                  onClick: () => setChartMode(option.id),
                }, t(option.labelKey))),
              ),
            ),
            h(TrendChart, {
              points: trendSeries,
              mode: chartMode,
              t,
              modelTrend: data?.modelTrend,
            }),
          ),
          /**
           * 右列：环形图 + 热力图竖排。
           *
           * 热力图天然是「小方块」——10~26 周也就 150~420px 宽，
           * 放进整行卡片会让左右失衡。放右侧栏（约 500px）正合适。
           */
          modelPieItems.length > 0
            ? h('section', { className: 'tu-section' },
              // 与左侧用同一个标题容器：左侧标题行含模式切换按钮、更高，
              // 若右侧直接放裸 h2，两列卡片顶部就会错位。
              h('div', { className: 'tu-section-head' },
                h('h2', { className: 'tu-section-title' }, t('chart.pie.title')),
              ),
              h(DonutChart, { items: modelPieItems, t, centerLabel: t('chart.pie.total') }),
            )
            : null,
        )
        : null

      // 明细区：一次只显示一张表，用标签切换。
      // 原先六张表纵向堆叠，页面要滚很久才能看到后面的维度。
      const tableViews = [
        { id: 'model', labelKey: 'table.model', columns: modelColumns, rows: modelRows },
        { id: 'origin', labelKey: 'table.origin', columns: originColumns, rows: originRows },
        { id: 'project', labelKey: 'table.project', columns: projectColumns, rows: projectRows },
        { id: 'provider', labelKey: 'table.provider', columns: providerColumns, rows: providerRows },
        { id: 'account', labelKey: 'table.account', columns: accountColumns, rows: accountRows },
        { id: 'day', labelKey: 'table.day', columns: dayColumns, rows: dayRows },
        // 余额不在这里：它是「配置 + 状态」，与用量表性质不同，
        // 统一放在顶部的「供应商」页面，避免同一个东西两处入口。
      ]
      if (data?.config?.showSessions === true) {
        tableViews.push({ id: 'session', labelKey: 'column.session', columns: sessionColumns, rows: sessionRows })
      }
      const activeView = tableViews.find((view) => view.id === tableView) ?? tableViews[0]

      const emptyView = h('div', { className: 'tu-empty' }, t('empty'))
      const sections = empty
        ? emptyView
        : h('section', { className: 'tu-section' },
          h('div', { className: 'tu-section-head' },
            h('h2', { className: 'tu-section-title' }, t('table.tabs')),
            h('div', { className: 'tu-tabs tu-tabs-sm tu-tabs-wrap' },
              tableViews.map((view) => h('button', {
                key: view.id,
                type: 'button',
                className: 'tu-tab',
                'data-active': activeView.id === view.id ? 'true' : 'false',
                onClick: () => setTableView(view.id),
              }, t(view.labelKey)),
              ),
            ),
          ),
          // 「按日期」视图：日期范围选择 + 分页，避免一次渲染几百行。
          activeView.id === 'day'
            ? h('div', { className: 'tu-daterange' },
              h('label', { className: 'tu-datefield' },
                h('span', null, t('day.from')),
                h('input', {
                  type: 'date',
                  className: 'tu-dateinput',
                  value: dayFrom,
                  max: dayTo !== '' ? dayTo : undefined,
                  onChange: (event) => { setDayFrom(event.target.value); setPage(0) },
                }),
              ),
              h('label', { className: 'tu-datefield' },
                h('span', null, t('day.to')),
                h('input', {
                  type: 'date',
                  className: 'tu-dateinput',
                  value: dayTo,
                  min: dayFrom !== '' ? dayFrom : undefined,
                  onChange: (event) => { setDayTo(event.target.value); setPage(0) },
                }),
              ),
              dayFrom !== '' || dayTo !== ''
                ? h('button', {
                  type: 'button', className: 'tu-button',
                  onClick: () => { setDayFrom(''); setDayTo(''); setPage(0) },
                }, t('day.clear'))
                : null,
              h('span', { className: 'tu-daterange-meta' },
                `${formatNumber(dayRowsFiltered.length)} ${t('pager.rows')}`),
            )
            : null,
          h(UsageTable, {
            columns: activeView.columns,
            rows: activeView.rows,
            emptyText: t('empty'),
          }),
          // 只有日期视图需要分页。
          activeView.id === 'day' && pageCount > 1
            ? h('div', { className: 'tu-pager' },
              h('button', {
                type: 'button', className: 'tu-button',
                disabled: safePage <= 0,
                onClick: () => setPage((current) => Math.max(0, current - 1)),
              }, t('pager.prev')),
              h('span', { className: 'tu-pager-info' },
                `${t('pager.info')} ${safePage + 1} ${t('pager.of')} ${pageCount} ${t('pager.pages')}`),
              h('button', {
                type: 'button', className: 'tu-button',
                disabled: safePage >= pageCount - 1,
                onClick: () => setPage((current) => Math.min(pageCount - 1, current + 1)),
              }, t('pager.next')),
            )
            : null,
          activeView.id === 'account' ? h('p', { className: 'tu-hint' }, t('account.note')) : null,
        )

      const integrityOk = data?.integrity?.consistent !== false
      const warn = integrityOk
        ? null
        : h('div', { className: 'tu-warn' }, t('integrityWarn'))

      // 是否正处于更新流程中（决定弹窗是否显示三段式进度）。
      const isUpdating = ['download', 'install', 'activate'].includes(updateState.phase)

      // 补价弹窗：为匹配不到价格的模型手工填单价（每百万 token，美元）。
      // 中转站常用自定义模型名（qfmodel 之类），自动匹配注定覆盖不到，
      // 没有这个入口这些模型的成本永远是 0。
      const priceModal = priceDialog === null ? null : h('div', {
        className: 'tu-modal-backdrop',
        onClick: (event) => { if (event?.target === event?.currentTarget) setPriceDialog(null) },
      },
      h('div', { className: 'tu-modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'tu-modal-title' }, `${t('cost.overrideTitle')} · ${priceDialog.model}`),
        h('p', { className: 'tu-hint' }, t('cost.overrideHint')),
        h('div', { className: 'tu-priceform' },
          h('label', { className: 'tu-pricefield' },
            h('span', null, t('cost.inputPerM')),
            h('input', {
              type: 'number', step: '0.001', min: '0',
              className: 'tu-priceinput',
              value: priceDialog.input,
              onChange: (event) => setPriceDialog((current) => (
                current === null ? null : { ...current, input: event.target.value })),
            }),
          ),
          h('label', { className: 'tu-pricefield' },
            h('span', null, t('cost.outputPerM')),
            h('input', {
              type: 'number', step: '0.001', min: '0',
              className: 'tu-priceinput',
              value: priceDialog.output,
              onChange: (event) => setPriceDialog((current) => (
                current === null ? null : { ...current, output: event.target.value })),
            }),
          ),
        ),
        h('div', { className: 'tu-modal-actions' },
          h('button', {
            type: 'button', className: 'tu-button',
            onClick: () => setPriceDialog(null),
          }, t('version.dialogOk')),
          h('button', {
            type: 'button', className: 'tu-button',
            onClick: () => { void savePriceOverride(priceDialog.model, '', '') },
          }, t('cost.remove')),
          h('button', {
            type: 'button', className: 'tu-button tu-button-primary',
            onClick: () => { void savePriceOverride(priceDialog.model, priceDialog.input, priceDialog.output) },
          }, t('cost.save')),
        ),
      ))

      // 添加/编辑供应商弹窗：名称、地址、密钥、接口格式，
      // 以及「该服务的模型」勾选与「模型设置」（别名 / 上下文 / 输出上限）。
      // 模型清单弹窗：点供应商卡片上的「N 个模型」打开。
      // 目的是快速确认「这个站点到底能用哪些模型」，而不是先点编辑再翻。
      const modelsModal = modelsDialog === null ? null : h('div', {
        className: 'tu-modal-backdrop',
        onClick: (event) => { if (event?.target === event?.currentTarget) setModelsDialog(null) },
      },
      h('div', { className: 'tu-sheet tu-sheet-narrow', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'tu-sheet-head' },
          h('div', { className: 'tu-sheet-headings' },
            h('h2', { className: 'tu-sheet-title' },
              `${modelsDialog.label} · ${modelsDialog.models.length} ${t('supplier.models')}`),
            h('p', { className: 'tu-sheet-sub' }, t('models.inDsh')),
          ),
        ),
        h('div', { className: 'tu-sheet-body' },
          modelsDialog.models.length === 0
            ? h('p', { className: 'tu-hint' }, t('models.empty'))
            : h('div', { className: 'tu-models-list' },
              ...modelsDialog.models.map((model) => h('div', {
                key: model.id, className: 'tu-model-item',
              },
              h('div', { className: 'tu-model-item-head' },
                h('span', { className: 'tu-model-item-id', title: model.id }, model.id),
                h('button', {
                  type: 'button', className: 'tu-btn tu-btn-ghost tu-btn-xs',
                  onClick: () => {
                    // 复制模型 ID：配置别处时常用
                    try { navigator.clipboard.writeText(model.id) } catch { /* 忽略 */ }
                  },
                }, t('models.copy')),
              ),
              model.name === undefined || model.name === ''
                ? null
                : h('div', { className: 'tu-model-item-alias' }, model.name),
              h('div', { className: 'tu-model-item-meta' },
                model.contextWindow === undefined
                  ? null
                  : h('span', null, `${t('models.context')} ${model.contextWindow}`),
                model.maxOutput === undefined
                  ? null
                  : h('span', null, `${t('models.maxOutput')} ${model.maxOutput}`),
                Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0
                  // 档位条目可能是 `{level, wire}` 对象，直接 join 会得到
                  // [object Object]，这里取档位名；自定义拼写单独标注。
                  ? h('span', null, `${t('models.thinking')} ${model.thinkingLevels
                    .map((item) => {
                      const level = typeof item === 'string' ? item : item?.level
                      const wire = typeof item === 'string' ? undefined : item?.wire
                      return wire !== undefined && wire !== level ? `${level}→${wire}` : level
                    })
                    .filter((x) => x !== undefined)
                    .join(' / ')}`)
                  : null,
              ),
              )),
            ),
        ),
        h('div', { className: 'tu-sheet-foot' },
          h('span', { className: 'tu-sheet-foot-note' }, ''),
          h('div', { className: 'tu-sheet-foot-actions' },
            h('button', {
              type: 'button', className: 'tu-btn',
              onClick: () => setModelsDialog(null),
            }, t('version.dialogOk')),
          ),
        ),
      ))

      const supplierModal = supplierForm === null ? null : (() => {
        const form = supplierForm
        const available = form.available ?? []
        const selected = form.models ?? []
        const selectedIds = new Set(selected.map((model) => model.id))
        const keyword = String(form.keyword ?? '').trim().toLowerCase()
        const visible = keyword === ''
          ? available
          : available.filter((model) => model.id.toLowerCase().includes(keyword))

        // 上下文窗口的常用档位：比自由输入更快，也避免手滑填错量级。
        const CONTEXT_PRESETS = [128_000, 200_000, 256_000, 1_000_000]
        // DSH 底层 pi-ai 实际装载的协议适配器。选错会导致请求格式不符。
        const API_OPTIONS = [
          { id: 'openai-completions', labelKey: 'api.openai-completions' },
          { id: 'openai-responses', labelKey: 'api.openai-responses' },
          { id: 'anthropic-messages', labelKey: 'api.anthropic-messages' },
        ]
        // DSH 的思考等级全集（取自 pi-ai 的 EXTENDED_THINKING_LEVELS）。
        // 注意 xhigh / max 必须在 reasoningEfforts 里显式出现才算支持。
        const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

        const setField = (key, value) => setSupplierForm((current) => (
          current === null ? null : { ...current, [key]: value }))
        const toggleModel = (model) => setSupplierForm((current) => {
          if (current === null) return null
          const models = current.models ?? []
          const exists = models.some((entry) => entry.id === model.id)
          return {
            ...current,
            models: exists
              ? models.filter((entry) => entry.id !== model.id)
              : [...models, (() => {
                // 优先级：端点返回 > 模型目录 > 留空让用户填。
                // 目录是权威数据，能省掉「这个模型到底支持哪几档」的猜测。
                const cap = catalogEntry(model.id)
                return {
                  id: model.id,
                  name: model.name ?? '',
                  contextWindow: model.contextWindow ?? cap?.contextWindow,
                  maxOutput: model.maxOutput ?? cap?.maxTokens,
                  // 目录给了档位就直接填好；不是推理模型则明确留空
                  thinkingLevels: cap?.thinkingLevels ?? [],
                  image: cap?.input === undefined ? true : cap.input.includes('image'),
                }
              })()],
          }
        })
        const patchModel = (id, patch) => setSupplierForm((current) => (current === null ? null : {
          ...current,
          models: (current.models ?? []).map((entry) => (
            entry.id === id ? { ...entry, ...patch } : entry)),
        }))

        /** 字段标题；required 为 true 时带红色星号。 */
        /**
         * 查模型目录里该模型的能力。
         *
         * 目录由 Host 从 pi-ai 的 providers/data 读取，含推理能力、支持的
         * 思考档位、上下文与输出上限、输入类型。拿不到返回 undefined。
         */
        /**
         * 取档位条目里的档位名。
         *
         * 历史数据是字符串（'high'），新数据是 `{ level, wire }` 对象。
         * 两种都要能读，否则旧配置会失效。
         */
        const levelOf = (item) => (typeof item === 'string' ? item : item?.level)

        /**
         * 取档位条目的协议拼写值。没有自定义时与档位名相同。
         */
        const wireOf = (item) => {
          if (typeof item === 'string') return item
          const wire = item?.wire
          return typeof wire === 'string' && wire !== '' ? wire : item?.level
        }

        const catalogEntry = (id) => {
          const catalog = data?.modelCatalog
          if (catalog === null || catalog === undefined) return undefined
          return catalog[id]
        }

        const fieldLabel = (text, required = false) => h('span', { className: 'tu-flabel' },
          text,
          required ? h('span', { className: 'tu-req', title: t('supplier.required') }, '*') : null,
        )
        const input = (value, placeholder, onInput, extra = {}) => h('input', {
          type: 'text',
          className: 'tu-input',
          value: value ?? '',
          placeholder,
          onChange: (event) => onInput(event.target.value),
          ...extra,
        })

        return h('div', {
          className: 'tu-modal-backdrop',
          onClick: (event) => { if (event?.target === event?.currentTarget) setSupplierForm(null) },
        },
        h('div', { className: 'tu-sheet', role: 'dialog', 'aria-modal': 'true' },

          // 头部
          h('div', { className: 'tu-sheet-head' },
            h('div', { className: 'tu-sheet-headings' },
              h('h2', { className: 'tu-sheet-title' },
                form.editing === true ? t('supplier.formEdit') : t('supplier.formTitle')),
              h('p', { className: 'tu-sheet-sub' }, t('supplier.syncExplain')),
            ),
            h('span', {
              className: 'tu-chip',
              'data-tone': form.editing === true ? 'neutral' : 'brand',
            }, form.editing === true ? t('supplier.editing') : t('supplier.addNew')),
          ),

          h('div', { className: 'tu-sheet-body' },

            // ① 先选服务：选完自动填地址与协议，比手抄 baseURL 可靠
            h('div', { className: 'tu-row' },
              h('div', { className: 'tu-col tu-col-grow' },
                fieldLabel(t('supplier.service'), true),
                h('select', {
                  className: 'tu-input tu-select',
                  value: form.service ?? 'custom',
                  onChange: (event) => {
                    const preset = SERVICE_PRESETS.find((entry) => entry.id === event.target.value)
                    if (preset === undefined) return
                    setSupplierForm((current) => {
                      if (current === null) return null
                      // 关键：切换服务必须**整组替换**地址与协议。
                      // 之前只在非 custom 时覆盖，导致「先选 DeepSeek 再切自定义」
                      // 会残留 deepseek 的地址，用户以为清空了其实没有。
                      // 「自定义」类的预设地址由用户填，其余用预设地址
                      const needsUrl = preset.baseUrl === ''
                      return {
                        ...current,
                        service: preset.id,
                        baseUrl: needsUrl ? '' : preset.baseUrl,
                        api: preset.api,
                        // 余额接口类型从预设直接带过来，不再让用户二次选
                        balanceKind: preset.balanceKind ?? 'auto',
                        // 名称跟随服务走；自定义时清空让用户自己填
                        label: needsUrl ? '' : preset.label,
                        // 换服务等于换站点，旧模型列表不再适用
                        models: [],
                        available: [],
                        keyword: '',
                        activeModel: undefined,
                      }
                    })
                  },
                },
                h('option', { value: 'custom' }, t('supplier.customEndpoint')),
                ...SERVICE_PRESETS.filter((entry) => entry.id !== 'custom')
                  .map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
                ),
              ),
              h('div', { className: 'tu-col tu-col-wide' },
                fieldLabel(t('supplier.name'), true),
                input(form.label, t('supplier.namePlaceholder'), (value) => setField('label', value)),
              ),
            ),

            // 选完服务后展示它的能力提示：余额能不能查、要什么凭据
            (() => {
              const preset = SERVICE_PRESETS.find((entry) => entry.id === (form.service ?? 'custom'))
              if (preset === undefined || preset.id === 'custom') return null
              const balanceText = preset.balance === 'yes' ? t('supplier.balanceYes')
                : preset.balance === 'admin' ? t('supplier.balanceAdmin')
                  : preset.balance === 'oauth' ? t('supplier.balanceOauth')
                    : t('supplier.balanceNo')
              // 订阅制查的是「用量与限额」，不是账户余额——措辞要分开，
              // 否则用户会以为 Coding Plan 也有余额概念。
              const capLabel = preset.plan === true ? t('supplier.quotaCap') : t('supplier.balanceCap')
              return h('p', { className: 'tu-serviceinfo' },
                h('span', { className: `tu-captag ${preset.balance === 'yes' ? 'tu-captag-ok' : 'tu-captag-no'}` },
                  `${capLabel}：${balanceText}`),
                preset.keyHint === undefined
                  ? null
                  : h('span', { className: 'tu-servicehint' }, `${t('supplier.keyHintLabel')}：${preset.keyHint}`),
              )
            })(),

            h('div', { className: 'tu-row' },
              h('div', { className: 'tu-col tu-col-grow' },
                fieldLabel(t('supplier.baseUrl'), true),
                input(form.baseUrl, t('supplier.urlPlaceholder'), (value) => setField('baseUrl', value), { type: 'url' }),
              ),
            ),
            h('div', { className: 'tu-row' },
              h('div', { className: 'tu-col tu-col-grow' },
                fieldLabel(t('supplier.apiKey'), form.editing !== true),
                h('input', {
                  type: 'password',
                  className: 'tu-input',
                  value: form.apiKey,
                  placeholder: t('supplier.keyPlaceholder'),
                  onChange: (event) => setField('apiKey', event.target.value),
                }),
              ),
              h('div', { className: 'tu-col' },
                fieldLabel(t('supplier.apiFormat')),
                h('select', {
                  className: 'tu-input tu-select',
                  value: form.api ?? 'openai-completions',
                  onChange: (event) => setField('api', event.target.value),
                },
                ...API_OPTIONS.map((option) => h('option', {
                  key: option.id, value: option.id,
                }, t(option.labelKey))),
                ),
              ),
            ),
            h('p', { className: 'tu-note' },
              h('span', { className: 'tu-note-icon' }, '🔒'),
              t('supplier.secretNote'),
            ),

            // 手动余额：站点没有标准余额接口时的兜底
            form.editing === true
              ? h('div', { className: 'tu-row' },
                h('div', { className: 'tu-col' },
                  fieldLabel(t('supplier.balanceUsd')),
                  h('input', {
                    type: 'number', step: '0.01', min: '0',
                    className: 'tu-input',
                    value: form.manualBalance ?? '',
                    placeholder: '0.00',
                    onChange: (event) => setField('manualBalance', event.target.value),
                  }),
                ),
                h('div', { className: 'tu-col tu-col-grow' },
                  h('p', { className: 'tu-hint' }, t('supplier.probeUnsupported')),
                ),
              )
              : null,

            // ② 模型：左侧列表勾选，右侧配置选中模型的参数。
            //    这种「列表 + 详情」比一行塞七列更容易看清：
            //    容量、思考等级、附件都属于「单模型属性」，不该挤在表格里。
            h('div', { className: 'tu-sec' },
              h('div', { className: 'tu-sec-head' },
                h('div', { className: 'tu-sec-title' },
                  t('supplier.modelList'),
                  selected.length > 0
                    ? h('span', { className: 'tu-count' }, `${selected.length}`)
                    : null,
                ),
                h('div', { className: 'tu-sec-actions' },
                  h('input', {
                    type: 'search',
                    className: 'tu-input tu-search',
                    placeholder: t('supplier.searchModel'),
                    value: form.keyword ?? '',
                    onChange: (event) => setField('keyword', event.target.value),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'tu-btn tu-btn-ghost',
                    disabled: supplierBusy === 'models' || form.baseUrl === '',
                    onClick: () => { void fetchSupplierModels(form.baseUrl, form.apiKey, form.id) },
                  }, supplierBusy === 'models' ? t('supplier.fetching') : t('supplier.fetchModels')),
                ),
              ),

              h('div', { className: 'tu-split' },
                // ── 左：模型勾选列表 ──
                h('div', { className: 'tu-list-pane' },
                  available.length === 0 && selected.length === 0
                    ? h('div', { className: 'tu-empty-block tu-empty-inline' },
                      h('div', { className: 'tu-empty-title' }, t('supplier.needUrl')),
                      h('div', { className: 'tu-empty-hint' }, t('supplier.fetchHint')),
                    )
                    : h('div', { className: 'tu-mlist' },
                      ...visible.map((model) => {
                        const on = selectedIds.has(model.id)
                        const active = form.activeModel === model.id
                        return h('div', {
                          key: model.id,
                          className: 'tu-mlist-row',
                          'data-picked': on ? 'true' : 'false',
                          'data-active': active ? 'true' : 'false',
                          onClick: () => setField('activeModel', model.id),
                        },
                        h('input', {
                          type: 'checkbox',
                          className: 'tu-checkbox',
                          checked: on,
                          onClick: (event) => event.stopPropagation?.(),
                          onChange: () => toggleModel(model),
                        }),
                        h('span', { className: 'tu-mlist-id', title: model.id }, model.id),
                        // 状态灯：勾选并配过参数的显示绿点，只勾选的显示空心点，
                        // 未勾选的不显示——一眼看出哪些已经配好了。
                        //
                        // 注意：这里必须用本行的 selected.find 取当前模型。
                        // 早先误用了下方详情区的 `picked`，它在另一个作用域且尚未
                        // 初始化，触发 ReferenceError 导致整个弹窗渲染失败（黑屏）。
                        (() => {
                          if (!on) return null
                          const entry = selected.find((item) => item.id === model.id)
                          const configured = entry !== undefined
                            && (entry.contextWindow !== undefined || entry.maxOutput !== undefined
                              || (entry.name ?? '') !== '' || (entry.thinkingLevels ?? []).length > 0)
                          return h('span', {
                            className: 'tu-mlist-dot',
                            'data-state': configured ? 'ready' : 'picked',
                            title: configured ? t('supplier.ready') : t('supplier.picked'),
                          })
                        })(),
                        )
                      },
                      ),
                      // 手填的模型也要出现在列表里
                      ...selected.filter((entry) => !available.some((m) => m.id === entry.id))
                        .map((entry) => h('div', {
                          key: `custom-${entry.id}`,
                          className: 'tu-mlist-row',
                          'data-picked': 'true',
                          'data-active': form.activeModel === entry.id ? 'true' : 'false',
                          onClick: () => setField('activeModel', entry.id),
                        },
                        h('input', {
                          type: 'checkbox', className: 'tu-checkbox', checked: true,
                          onClick: (event) => event.stopPropagation?.(),
                          onChange: () => toggleModel({ id: entry.id }),
                        }),
                        h('span', { className: 'tu-mlist-id' }, entry.id),
                        h('span', { className: 'tu-mlist-tag' }, t('supplier.custom')),
                        )),
                    ),

                  // 手填入口常驻在列表底部
                  h('div', { className: 'tu-mlist-foot' },
                    input(form.customModel ?? '', t('supplier.customModelPlaceholder'), (value) => setField('customModel', value)),
                    h('button', {
                      type: 'button', className: 'tu-btn tu-btn-ghost',
                      onClick: () => {
                        const id = String(form.customModel ?? '').trim()
                        if (id === '') return
                        setSupplierForm((current) => (current === null ? null : {
                          ...current,
                          customModel: '',
                          activeModel: id,
                          models: [...(current.models ?? []), { id, name: '', thinkingLevels: [], image: true }],
                        }))
                      },
                    }, '+'),
                  ),
                ),

                // ── 右：选中模型的详情 ──
                h('div', { className: 'tu-detail-pane' },
                  (() => {
                    // 先按 activeModel 找；找不到再退回第一个已选。
                    // 注意：点了未勾选的行时，activeModel 指向的是一个「还没加入
                    // selected」的模型——这时要能显示它的详情，否则用户会觉得
                    // 点了没反应。
                    const active = selected.find((entry) => entry.id === form.activeModel)
                      ?? (form.activeModel !== undefined
                        ? available.find((entry) => entry.id === form.activeModel)
                        : undefined)
                      ?? selected[0]
                    if (active === undefined) {
                      return h('div', { className: 'tu-empty-block tu-empty-inline' },
                        h('div', { className: 'tu-empty-hint' }, t('supplier.pickOne')),
                      )
                    }
                    const patch = (value) => patchModel(active.id, value)
                    // 这个模型可能还没勾选：右侧照样显示它的参数（只读预览），
                    // 但给出提示并提供一个「加入已选」的按钮。
                    const picked = selected.some((entry) => entry.id === active.id)
                    const ensurePicked = () => {
                      if (picked) return
                      setSupplierForm((current) => {
                        if (current === null) return null
                        if ((current.models ?? []).some((entry) => entry.id === active.id)) return current
                        return {
                          ...current,
                          models: [...(current.models ?? []), {
                            id: active.id,
                            name: active.name ?? '',
                            contextWindow: active.contextWindow,
                            maxOutput: active.maxOutput,
                            thinkingLevels: [],
                            image: true,
                          }],
                        }
                      })
                    }
                    return h('div', { className: 'tu-detail' },
                      h('div', { className: 'tu-detail-head' },
                        h('span', { className: 'tu-detail-id' }, active.id),
                        picked
                          ? h('button', {
                            type: 'button', className: 'tu-icon-btn',
                            title: t('supplier.remove'),
                            onClick: () => toggleModel({ id: active.id }),
                          }, '×')
                          : h('button', {
                            type: 'button', className: 'tu-btn tu-btn-primary tu-btn-xs',
                            onClick: ensurePicked,
                          }, '+ ' + t('supplier.selected')),
                      ),
                      picked
                        ? null
                        : h('p', { className: 'tu-detail-warn' }, t('supplier.pickHint')),

                      // 别名
                      h('div', { className: 'tu-dfield' },
                        h('div', { className: 'tu-dfield-label' }, t('supplier.alias')),
                        input(active.name, active.id, (value) => patch({ name: value })),
                      ),

                      // 上下文窗口：预设按钮 + 自定义
                      h('div', { className: 'tu-dfield' },
                        h('div', { className: 'tu-dfield-label' },
                          t('supplier.context'),
                          h('span', { className: 'tu-dfield-hint' }, t('supplier.contextHint')),
                        ),
                        // 端点报过容量但用户还没设时，给出「采用探测值」的提示
                        (() => {
                          const detected = available.find((m) => m.id === active.id)?.contextWindow
                          if (detected === undefined || active.contextWindow === detected) return null
                          return h('button', {
                            type: 'button', className: 'tu-autofill',
                            onClick: () => patch({ contextWindow: detected }),
                          }, `${t('supplier.autoDetected')} ${detected} · ${t('supplier.adopt')}`)
                        })(),
                        h('div', { className: 'tu-segmented' },
                          ...CONTEXT_PRESETS.map((preset) => h('button', {
                            key: preset,
                            type: 'button',
                            className: 'tu-seg',
                            'data-active': active.contextWindow === preset ? 'true' : 'false',
                            onClick: () => patch({ contextWindow: preset }),
                          }, preset >= 1_000_000 ? '1M' : `${preset / 1000}K`)),
                        ),
                        h('input', {
                          type: 'number',
                          className: 'tu-input tu-input-sm',
                          placeholder: '262144',
                          value: active.contextWindow ?? '',
                          onChange: (event) => patch({ contextWindow: Number(event.target.value) || undefined }),
                        }),
                      ),

                      // 最大输出
                      h('div', { className: 'tu-dfield' },
                        h('div', { className: 'tu-dfield-label' },
                          t('supplier.maxOutput'),
                          h('span', { className: 'tu-dfield-hint' }, t('supplier.outputHint')),
                        ),
                        (() => {
                          const detected = available.find((m) => m.id === active.id)?.maxOutput
                          if (detected === undefined || active.maxOutput === detected) return null
                          return h('button', {
                            type: 'button', className: 'tu-autofill',
                            onClick: () => patch({ maxOutput: detected }),
                          }, `${t('supplier.autoDetected')} ${detected} · ${t('supplier.adopt')}`)
                        })(),
                        h('div', { className: 'tu-segmented' },
                          ...[4_096, 8_192, 16_384, 32_768, 65_536].map((preset) => h('button', {
                            key: preset,
                            type: 'button',
                            className: 'tu-seg',
                            'data-active': active.maxOutput === preset ? 'true' : 'false',
                            onClick: () => patch({ maxOutput: preset }),
                          }, preset >= 1024 ? `${preset / 1024}K` : String(preset))),
                        ),
                        h('input', {
                          type: 'number',
                          className: 'tu-input tu-input-sm',
                          placeholder: '32768',
                          value: active.maxOutput ?? '',
                          onChange: (event) => patch({ maxOutput: Number(event.target.value) || undefined }),
                        }),
                      ),

                      // 思考等级。
                      //
                      // 目录（pi-ai 的 thinkingLevelMap）给出「推荐档位」，勾选时
                      // 自动填好；但目录未必覆盖自定义模型或中转站别名，所以
                      // **全部 7 档都保留可手动勾选**——推荐只是默认值，不是限制。
                      h('div', { className: 'tu-dfield' },
                        (() => {
                          const cap = catalogEntry(active.id)
                          if (cap === undefined) {
                            return h('div', { className: 'tu-dfield-label' },
                              t('supplier.thinking'),
                              h('span', { className: 'tu-dfield-hint' }, t('supplier.noCatalogEntry')),
                            )
                          }
                          if (cap.reasoning !== true) {
                            return h('div', { className: 'tu-dfield-label' },
                              t('supplier.thinking'),
                              h('span', { className: 'tu-dfield-hint' }, t('supplier.notReasoning')),
                            )
                          }
                          return h('div', { className: 'tu-dfield-label' },
                            t('supplier.thinking'),
                            h('span', { className: 'tu-dfield-hint' },
                              (cap.thinkingLevels ?? []).length > 0
                                ? t('supplier.levelsFromCatalog')
                                : t('supplier.levelsManual')),
                          )
                        })(),
                        (() => {
                          // 推荐档位（目录给出的）；没有则视为「全部可填」
                          const recommended = catalogEntry(active.id)?.thinkingLevels ?? []
                          const hasRecommended = recommended.length > 0
                          // 用户展开「全部档位」时列出 7 档，否则只列推荐档位。
                          // 手动加过一个非推荐档位时也自动展开，免得刚加的档位看不见。
                          const chosen = active.thinkingLevels ?? []
                          const showAll = form.showAllLevels === true
                            || chosen.some((item) => !recommended.includes(levelOf(item)))
                          const list = showAll || !hasRecommended ? THINKING_LEVELS : recommended
                          return h('div', { className: 'tu-levels' },
                            ...list.map((level) => {
                              const checked = chosen.some((item) => levelOf(item) === level)
                              const isRecommended = recommended.includes(level)
                              return h('label', {
                                key: level,
                                className: 'tu-level',
                                'data-on': checked ? 'true' : 'false',
                                // 推荐的档位加个标记，让用户知道目录建议值
                                'data-rec': isRecommended ? 'true' : 'false',
                              },
                              h('input', {
                                type: 'checkbox',
                                className: 'tu-checkbox',
                                checked,
                                onChange: () => {
                                  // 用 { level, wire } 形式记录，便于后续在界面上
                                  // 单独改「协议值」；wire 默认与档位名相同。
                                  const next = checked
                                    ? chosen.filter((item) => levelOf(item) !== level)
                                    : [...chosen, { level, wire: level }]
                                  const order = THINKING_LEVELS
                                  patch({
                                    thinkingLevels: order
                                      .map((item) => next.find((x) => levelOf(x) === item))
                                      .filter((x) => x !== undefined),
                                  })
                                },
                              }),
                              h('span', null, t(`level.${level}`)),
                              )
                            }),
                            // 展开/收起：目录有推荐值时给个开关，看全 7 档
                            hasRecommended
                              ? h('button', {
                                type: 'button',
                                className: 'tu-level-toggle',
                                onClick: () => setField('showAllLevels', !showAll),
                              }, showAll ? t('supplier.levelsHideAll') : t('supplier.levelsShowAll'))
                              : null,
                          )
                        })(),
                        (active.thinkingLevels ?? []).length === 0
                          ? h('span', { className: 'tu-dfield-hint' }, t('supplier.thinkingNone'))
                          : null,

                        // 协议值编辑：只有当某个档位的「拼写」与档位名不同
                        // 才有意义，所以默认折叠，需要时展开。
                        (active.thinkingLevels ?? []).length === 0 ? null : h('div', { className: 'tu-wire' },
                          h('button', {
                            type: 'button',
                            className: 'tu-level-toggle',
                            onClick: () => setField('showWire', form.showWire !== true),
                          }, form.showWire === true ? t('supplier.levelsHideAll') : t('supplier.wire')),
                          form.showWire !== true
                            ? null
                            : h('div', null,
                              h('span', { className: 'tu-dfield-hint' }, t('supplier.wireHint')),
                              h('div', { className: 'tu-wire-rows' },
                                ...(active.thinkingLevels ?? []).map((item) => {
                                  const level = levelOf(item)
                                  if (level === undefined) return null
                                  return h('div', { key: level, className: 'tu-wire-row' },
                                    h('span', { className: 'tu-wire-level' }, t(`level.${level}`)),
                                    h('span', { className: 'tu-wire-arrow' }, '→'),
                                    h('input', {
                                      type: 'text',
                                      className: 'tu-input tu-input-xs',
                                      // 占位符显示档位名，表示「不填就与档位名相同」
                                      placeholder: level,
                                      value: typeof item === 'object' && typeof item.wire === 'string'
                                        && item.wire !== level ? item.wire : '',
                                      onChange: (event) => {
                                        const next = (active.thinkingLevels ?? []).map((entry) => {
                                          if (levelOf(entry) !== level) return entry
                                          const wire = event.target.value
                                          return { level, wire: wire === '' ? level : wire }
                                        })
                                        patch({ thinkingLevels: next })
                                      },
                                    }),
                                  )
                                }),
                              ),
                            ),
                        ),
                      ),

                      // 附件
                      h('div', { className: 'tu-dfield' },
                        h('div', { className: 'tu-dfield-label' },
                          t('supplier.attach'),
                          h('span', { className: 'tu-dfield-hint' }, t('supplier.attachHint')),
                        ),
                        h('div', { className: 'tu-checks' },
                          h('label', { className: 'tu-checkrow' },
                            h('input', {
                              type: 'checkbox', className: 'tu-checkbox',
                              checked: active.image !== false,
                              onChange: () => patch({ image: active.image === false }),
                            }),
                            t('supplier.attachImage'),
                          ),
                        ),
                      ),
                    )
                  })(),
                ),
              ),
              h('p', { className: 'tu-hint tu-sec-hint' }, t('supplier.modelCountHint')),
            ),
          ),

          // 底部
          h('div', { className: 'tu-sheet-foot' },
            h('span', { className: 'tu-sheet-foot-note' },
              selected.length === 0
                ? t('supplier.noModels')
                : `${selected.length} ${t('supplier.selected')}`),
            h('div', { className: 'tu-sheet-foot-actions' },
              h('button', {
                type: 'button', className: 'tu-btn',
                onClick: () => setSupplierForm(null),
              }, t('supplier.cancel')),
              h('button', {
                type: 'button', className: 'tu-btn',
                disabled: supplierBusy === 'sync',
                onClick: () => {
                  const problem = validate()
                  if (problem !== '') { setSupplierNotice({ kind: 'error', text: problem }); return }
                  setSupplierNotice({ kind: '', text: '' })
                  void saveSupplier(collect(), form.apiKey, false)
                },
              }, t('supplier.save')),
              h('button', {
                type: 'button', className: 'tu-btn tu-btn-primary',
                disabled: supplierBusy === 'sync',
                onClick: () => {
                  const problem = validate()
                  if (problem !== '') { setSupplierNotice({ kind: 'error', text: problem }); return }
                  setSupplierNotice({ kind: '', text: '' })
                  void saveSupplier(collect(), form.apiKey, true)
                },
              }, supplierBusy === 'sync' ? t('supplier.syncing') : t('supplier.saveAndSync')),
            ),
          ),
        ))

        /**
         * 校验表单，返回第一条错误信息；全部通过返回空串。
         *
         * 防呆的重点是「在提交前拦住」而不是让后端报错——用户填错时
         * 应该当场看到哪一项不对，而不是点完保存才看到一个笼统的失败。
         */
        function validate() {
          if (String(form.label ?? '').trim() === '') return t('err.nameRequired')
          const url = String(form.baseUrl ?? '').trim()
          if (url === '') return t('err.urlRequired')
          if (!/^https?:\/\//i.test(url)) return t('err.urlInvalid')
          // 新增时必须填密钥；编辑时留空表示沿用已保存的，不算错
          if (form.editing !== true && String(form.apiKey ?? '').trim() === '') {
            return t('err.keyRequired')
          }
          // DSH 的 provider 配置必须声明模型，否则写入会被拒绝
          if ((form.models ?? []).length === 0) return t('err.modelsRequired')
          // 同名站点会互相覆盖，提前拦住
          const id = (form.id || (form.label || form.baseUrl).trim().replace(/\s+/g, '-').toLowerCase())
          if (form.editing !== true
            && (balanceState.sites ?? []).some((site) => site.id === id)) {
            return t('err.dupId')
          }
          return ''
        }

        /** 把表单状态收敛成要提交的站点描述。 */
        function collect() {
          return {
            id: form.id || (form.label || form.baseUrl).trim().replace(/\s+/g, '-').toLowerCase(),
            label: form.label,
            baseUrl: form.baseUrl,
            keyEnv: form.keyEnv,
            api: form.api ?? 'openai-completions',
            service: form.service ?? 'custom',
            balanceKind: form.balanceKind ?? 'auto',
            // 手填余额：保存成 lastBalance，页面就按它显示
            ...(form.manualBalance !== undefined && form.manualBalance !== ''
              ? { lastBalance: { usd: Number(form.manualBalance) }, lastCheckedAt: Date.now() }
              : {}),
            models: (form.models ?? []).map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxOutput: model.maxOutput,
              // 只写用户勾选的档位。pi-ai 对空对象会直接拒绝整条配置，
              // 所以没有勾选时完全不写这个字段（= 非推理模型）。
              ...(Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0
                ? { thinkingLevels: model.thinkingLevels }
                : {}),
              ...(model.image === false ? { input: ['text'] } : {}),
            })),
          }
        }
      })()

      // 供应商管理页面（顶层视图，占满整页）。
      /**
       * 预算页：可视化配置全局预算与按模型分组预算。
       *
       * 保存走 POST /budget，Host 写到 `$DSH_HOME/token-metrics/budget.json`，
       * 不改用户的 cordis.patch.yml。
       */
      const budgetPage = (() => {
        // 未初始化时用当前配置填一份
        const saved = data?.config?.budget ?? {}
        const form = budgetForm ?? {
          dailyUsd: saved.dailyUsd ?? 0,
          monthlyUsd: saved.monthlyUsd ?? 0,
          warnPercent: saved.warnPercent ?? 80,
          groups: (saved.groups ?? []).map((g) => ({ ...g, models: [...(g.models ?? [])] })),
        }
        // 模型清单来自 modelOptions（由 byModelName 生成），不是 data 上的字段。
        // 早先误写成 data?.modelOptions，永远为空，导致分组里选不到模型。
        const models = (modelOptions ?? []).slice().sort()

        /** 字段标签（与弹窗里的同名函数一致，但作用域独立）。 */
        const fieldLabel = (text, required = false) => h('span', { className: 'tu-flabel' },
          text, required ? h('span', { className: 'tu-req' }, '*') : null)

        const setFormField = (key, value) => {
          setBudgetForm({ ...form, groups: form.groups ?? [], [key]: value })
        }
        const setGroupField = (index, key, value) => {
          const groups = (form.groups ?? []).map((g, i) => (i === index ? { ...g, [key]: value } : g))
          setBudgetForm({ ...form, groups })
        }
        const addGroup = () => {
          const groups = [...(form.groups ?? []), {
            id: `group-${Date.now()}`,
            label: '',
            models: [],
            dailyUsd: 0,
            monthlyUsd: 0,
          }]
          setBudgetForm({ ...form, groups })
        }
        const removeGroup = (index) => {
          setBudgetForm({ ...form, groups: (form.groups ?? []).filter((_, i) => i !== index) })
        }
        const toggleModel = (index, model) => {
          const group = (form.groups ?? [])[index]
          if (group === undefined) return
          const has = (group.models ?? []).includes(model)
          setGroupField(index, 'models', has
            ? (group.models ?? []).filter((m) => m !== model)
            : [...(group.models ?? []), model])
        }

        const save = async () => {
          setBudgetBusy(true)
          setBudgetNotice('')
          try {
            const response = await fetch(BUDGET_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(form),
              credentials: 'same-origin',
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok || payload?.ok !== true) {
              throw new Error(payload?.error ?? `HTTP ${response.status}`)
            }
            setBudgetForm(payload.budget)
            setBudgetNotice(t('budget.saved'))
            void refresh()
          } catch (error) {
            setBudgetNotice(`${t('error')}：${error?.message ?? error}`)
          } finally {
            setBudgetBusy(false)
          }
        }

        return h('div', { className: 'tu-supplier-page' },
          h('div', { className: 'tu-supplier-head' },
            h('div', null,
              h('h2', { className: 'tu-supplier-title' }, t('budget.title')),
              h('p', { className: 'tu-supplier-sub' }, t('budget.subtitle')),
            ),
            h('button', {
              type: 'button', className: 'tu-button tu-button-primary',
              onClick: save, disabled: budgetBusy,
            }, budgetBusy ? t('saving') : t('budget.save')),
          ),

          budgetNotice === ''
            ? null
            : h('p', { className: 'tu-hint', style: { color: 'var(--dsw-alias-state-success-primary)' } }, budgetNotice),

          // —— 全局预算 ——
          h('section', { className: 'tu-budget-section' },
            h('h3', { className: 'tu-budget-h3' }, t('budget.global')),
            h('div', { className: 'tu-budget-fields' },
              fieldLabel(t('budget.dailyLabel')),
              h('input', {
                type: 'number', min: 0, step: 0.5, className: 'tu-input',
                value: form.dailyUsd ?? 0,
                onChange: (e) => setFormField('dailyUsd', Number(e.target.value) || 0),
              }),
              h('span', { className: 'tu-dfield-hint' }, t('budget.dailyHint')),
              fieldLabel(t('budget.monthlyLabel')),
              h('input', {
                type: 'number', min: 0, step: 1, className: 'tu-input',
                value: form.monthlyUsd ?? 0,
                onChange: (e) => setFormField('monthlyUsd', Number(e.target.value) || 0),
              }),
              h('span', { className: 'tu-dfield-hint' }, t('budget.monthlyHint')),
              fieldLabel(t('budget.warnLabel')),
              h('input', {
                type: 'number', min: 1, max: 100, step: 5, className: 'tu-input',
                value: form.warnPercent ?? 80,
                onChange: (e) => setFormField('warnPercent', Number(e.target.value) || 80),
              }),
              h('span', { className: 'tu-dfield-hint' }, t('budget.warnHint')),
            ),
          ),

          // —— 按模型分组 ——
          h('section', { className: 'tu-budget-section' },
            h('div', { className: 'tu-budget-section-head' },
              h('div', null,
                h('h3', { className: 'tu-budget-h3' }, t('budget.groupsTitle')),
                h('p', { className: 'tu-dfield-hint' }, t('budget.groupsHint')),
              ),
              h('button', {
                type: 'button', className: 'tu-button', onClick: addGroup,
              }, `+ ${t('budget.addGroup')}`),
            ),
            (form.groups ?? []).length === 0
              ? h('p', { className: 'tu-hint' }, t('budget.noGroups'))
              : h('div', { className: 'tu-budget-group-list' },
                ...(form.groups ?? []).map((group, index) => h('div', {
                  key: group.id ?? index, className: 'tu-budget-group-card',
                },
                h('div', { className: 'tu-budget-group-top' },
                  h('input', {
                    type: 'text', className: 'tu-input tu-budget-name',
                    placeholder: t('budget.groupName'),
                    value: group.label ?? '',
                    onChange: (e) => setGroupField(index, 'label', e.target.value),
                  }),
                  h('button', {
                    type: 'button', className: 'tu-icon-btn',
                    title: t('budget.removeGroup'),
                    onClick: () => removeGroup(index),
                  }, '×'),
                ),
                h('div', { className: 'tu-budget-group-row' },
                  fieldLabel(t('budget.groupDaily')),
                  h('input', {
                    type: 'number', min: 0, step: 0.5, className: 'tu-input tu-input-xs',
                    value: group.dailyUsd ?? 0,
                    onChange: (e) => setGroupField(index, 'dailyUsd', Number(e.target.value) || 0),
                  }),
                  fieldLabel(t('budget.groupMonthly')),
                  h('input', {
                    type: 'number', min: 0, step: 1, className: 'tu-input tu-input-xs',
                    value: group.monthlyUsd ?? 0,
                    onChange: (e) => setGroupField(index, 'monthlyUsd', Number(e.target.value) || 0),
                  }),
                ),
                h('div', { className: 'tu-dfield-hint' }, t('budget.groupModelsHint')),
                models.length === 0
                  ? h('p', { className: 'tu-hint' }, t('budget.emptyModels'))
                  : h('div', { className: 'tu-budget-models' },
                    ...models.map((model) => {
                      const picked = (group.models ?? []).includes(model)
                      return h('label', {
                        key: model, className: 'tu-budget-model',
                        'data-on': picked ? 'true' : 'false',
                      },
                      h('input', {
                        type: 'checkbox', className: 'tu-checkbox',
                        checked: picked,
                        onChange: () => toggleModel(index, model),
                      }),
                      h('span', null, model),
                      )
                    }),
                  ),
                )),
              ),
          ),
        )
      })()

      const supplierPage = (() => {
        const sites = balanceState.sites ?? []
        const discovered = (balanceState.discovered ?? [])
          .filter((entry) => !sites.some((site) => site.id === entry.id))

        /** 一张供应商卡片。 */
        /** 一张供应商卡片：左侧信息，右侧余额/配额，最右操作按钮。 */
        const card = (site) => {
          const balance = site.lastBalance
          const quotas = Array.isArray(balance?.quotas) ? balance.quotas : []
          // 注意命名：这里不能叫 currency，否则会遮蔽外层的货币切换状态，
          // 导致标签永远显示 USD、点击也不换算。
          const nativeCurrency = balance?.currency
          const symbol = nativeCurrency === 'CNY' ? '¥' : '$'
          const money = (value) => (typeof value === 'number'
            ? `${symbol}${value < 1 ? value.toFixed(3) : value.toFixed(2)}` : '—')
          const modelCount = Array.isArray(site.models) ? site.models.length : 0
          const hasQuota = quotas.length > 0
          const QUOTA_PLATFORMS = new Set(['kimi', 'glm', 'minimax', 'codex'])
          // 订阅型判定：有配额数据、或平台本身是订阅制、或明确回报「无订阅」。
          // 最后一条很关键：GLM 没订阅时也属于订阅平台，按钮该说「刷新用量」
          // 而不是「查询余额」。
          const looksLikeQuota = hasQuota
            || site.noPlan === true
            || (balance?.provider !== undefined && QUOTA_PLATFORMS.has(balance.provider))
            || (balance === undefined && QUOTA_PLATFORMS.has(site.provider))
            || QUOTA_PLATFORMS.has(site.provider)

          return h('div', { key: site.id, className: 'tu-supcard' },
            // ── 左：名称 / 地址 / 模型数 ──
            h('div', { className: 'tu-supcard-main' },
              h('div', { className: 'tu-supcard-name' },
                site.label || site.id,
                looksLikeQuota
                  ? h('span', { className: 'tu-kindtag', 'data-kind': 'quota' }, t('kind.quota'))
                  : (typeof balance?.usd === 'number'
                    ? h('span', { className: 'tu-kindtag', 'data-kind': 'balance' }, t('kind.balance'))
                    : null),
                modelCount > 0
                  // 徽标可点：直接看这批模型到底是什么，不用先进编辑弹窗
                  ? h('button', {
                    type: 'button',
                    className: 'tu-supcard-badge tu-supcard-badge-btn',
                    title: t('models.viewTitle'),
                    onClick: () => setModelsDialog({
                      siteId: site.id,
                      label: site.label || site.id,
                      models: Array.isArray(site.models) ? site.models : [],
                    }),
                  }, `${modelCount} ${t('supplier.models')}`)
                  : null,
              ),
              h('div', { className: 'tu-supcard-url' }, site.baseUrl),
            ),

            // ── 中：余额或配额窗口 ──
            h('div', { className: 'tu-supcard-value' },
              hasQuota
                // 配额型：每个窗口一条进度条，5 小时与周限都要看到
                ? h('div', { className: 'tu-supcard-quotas' },
                  ...quotas.map((entry) => h(QuotaBar, {
                    key: entry.label, entry, t, locale,
                  })),
                )
                : (typeof balance?.usd === 'number'
                  ? h('div', {
                    className: 'tu-supcard-money tu-supcard-money-click',
                    role: 'button',
                    tabIndex: 0,
                    title: t('currency.toggleTitle'),
                    onClick: () => setCurrency((current) => (current === 'usd' ? 'cny' : 'usd')),
                    onKeyDown: (event) => {
                      if (event?.key === 'Enter' || event?.key === ' ') {
                        event.preventDefault?.()
                        setCurrency((current) => (current === 'usd' ? 'cny' : 'usd'))
                      }
                    },
                  },
                  // 先算清「实际显示哪种货币、多少钱」，标签再跟着它走。
                  // 之前标签固定写切换模式，而 CNY 站点在 USD 模式下仍显示 ¥，
                  // 于是出现「余额 · USD  ¥128.50」这种自相矛盾的组合。
                  (() => {
                    const shown = (() => {
                      // 余额本身是 CNY：换算成美元才符合「USD 模式」，
                      // 而不是把人民币数字贴上美元标签。
                      if (nativeCurrency === 'CNY') {
                        return currency === 'usd'
                          ? { text: `$${(balance.usd / usdCny).toFixed(2)}`, unit: 'usd' }
                          : { text: `¥${balance.usd.toFixed(2)}`, unit: 'cny' }
                      }
                      // 余额本身是 USD
                      return currency === 'cny'
                        ? { text: `¥${(balance.usd * usdCny).toFixed(2)}`, unit: 'cny' }
                        : { text: `$${balance.usd < 1 ? balance.usd.toFixed(3) : balance.usd.toFixed(2)}`, unit: 'usd' }
                    })()
                    return [
                      h('span', { key: 'label', className: 'tu-supcard-money-label' },
                        `${t('supplier.balance')} · ${shown.unit === 'cny' ? t('currency.cny') : t('currency.usd')}`),
                      h('span', { key: 'value', className: 'tu-supcard-money-value' }, shown.text),
                    ]
                  })(),
                  )
                  : (site.noPlan === true
                    ? h('span', { className: 'tu-balnoplan' }, t('quota.noPlan'))
                    : h('button', {
                      type: 'button', className: 'tu-balance-set',
                      onClick: () => setSupplierForm({
                        id: site.id, label: site.label ?? '', baseUrl: site.baseUrl ?? '',
                        apiKey: '', keyEnv: site.keyEnv ?? '',
                        models: Array.isArray(site.models) ? site.models : [],
                        available: Array.isArray(site.models) ? site.models : [],
                        manualBalance: '', editing: true,
                      }),
                    }, t('supplier.setBalance')))),
            ),

            // ── 右：操作 ──
            h('div', { className: 'tu-supcard-actions' },
              h('button', {
                type: 'button', className: 'tu-btn tu-btn-ghost',
                disabled: supplierBusy === site.id,
                title: looksLikeQuota ? t('balance.probeQuotaHint') : undefined,
                onClick: () => { void probeSite(site.id) },
              }, supplierBusy === site.id
                ? t('balance.probing')
                // 订阅制没有「余额」概念，说「刷新用量」才准确
                : (looksLikeQuota ? t('balance.probeQuota') : t('balance.probe'))),
              h('button', {
                type: 'button', className: 'tu-btn tu-btn-ghost',
                onClick: () => setSupplierForm({
                  id: site.id, label: site.label ?? '', baseUrl: site.baseUrl ?? '',
                  apiKey: '', keyEnv: site.keyEnv ?? '',
                  models: Array.isArray(site.models) ? site.models : [],
                  available: Array.isArray(site.models) ? site.models : [],
                  editing: true,
                }),
              }, t('supplier.edit')),
              h('button', {
                type: 'button', className: 'tu-btn tu-btn-ghost',
                onClick: () => { void removeSite(site.id) },
              }, t('supplier.remove')),
            ),

            // 状态说明横跨整行，避免挤在按钮之间
            site.error === ''
              ? null
              : site.noPlan === true
                ? h('div', { className: 'tu-supcard-note' }, site.error)
                : h('div', { className: 'tu-supcard-note tu-supcard-note-error' },
                  `${t('balance.error')}：${site.error}`),
          )
        }

        return h('section', { className: 'tu-page' },
          h('div', { className: 'tu-page-head' },
            h('div', null,
              h('h2', { className: 'tu-page-title' }, t('supplier.title')),
              h('p', { className: 'tu-page-sub' }, t('supplier.subtitle')),
            ),
            h('div', { className: 'tu-page-actions' },
              h('button', {
                type: 'button', className: 'tu-btn',
                onClick: () => { void loadBalance() },
              }, t('supplier.probeAll')),
              h('button', {
                type: 'button', className: 'tu-btn tu-btn-primary',
                onClick: () => setSupplierForm({
                  id: '', label: '', baseUrl: '', apiKey: '', keyEnv: '',
                  service: 'custom', api: 'openai-completions',
                  models: [], available: [], editing: false,
                }),
              }, t('supplier.add')),
            ),
          ),

          supplierNotice.text === ''
            ? null
            : h('div', {
              className: 'tu-notice',
              'data-kind': supplierNotice.kind,
            }, supplierNotice.text),

          // 已添加
          h('div', { className: 'tu-page-group' },
            h('div', { className: 'tu-page-grouphead' },
              `${t('supplier.added')} · ${sites.length}`),
            sites.length === 0
              ? h('p', { className: 'tu-hint' }, t('supplier.empty'))
              : h('div', { className: 'tu-suplist' }, ...sites.map(card)),
          ),

          // 可添加（从 DSH 配置自动发现）
          discovered.length === 0
            ? null
            : h('div', { className: 'tu-page-group' },
              h('div', { className: 'tu-page-grouphead' },
                `${t('supplier.discovered')} · ${discovered.length}`),
              h('div', { className: 'tu-suplist' },
                ...discovered.map((entry) => h('div', {
                  key: entry.id, className: 'tu-supcard tu-supcard-discovered',
                },
                h('div', { className: 'tu-supcard-main' },
                  h('div', { className: 'tu-supcard-name' }, entry.label || entry.id),
                  h('div', { className: 'tu-supcard-url' }, entry.baseUrl),
                ),
                h('div', { className: 'tu-supcard-actions' },
                  h('button', {
                    type: 'button', className: 'tu-btn tu-btn-ghost',
                    onClick: () => setSupplierForm({
                      id: entry.id,
                      label: entry.label ?? entry.id,
                      baseUrl: entry.baseUrl ?? '',
                      apiKey: '', keyEnv: '',
                      service: 'custom', api: 'openai-completions',
                      models: [], available: [], editing: false,
                    }),
                  }, t('supplier.add')),
                ),
                )),
              ),
            ),
        )
      })()

      // 顶部工具栏：左侧是视图切换，右侧是价目表相关操作。
      //
      // 把「未定价模型」与「刷新价目表」收进这一行、与页签同排：
      // 它们都属于「当前视图的辅助操作」，单独占一行既零散又浪费高度。
      // 工具栏**常驻**（不再只在有未定价模型时出现），否则页签会跟着消失，
      // 用户就没法从统计页切到模型接入页了。
      const unpriced = data?.cost?.unpriced ?? []
      const toolbar = h('div', { className: 'tu-toolbar' },
        viewTabs,
        // 中间留给未定价模型（有才显示）
        unpriced.length === 0
          ? h('span', { className: 'tu-toolbar-spacer' })
          : h('div', { className: 'tu-unpriced' },
            h('span', { className: 'tu-unpriced-label' }, `${t('cost.unpriced')} ${unpriced.length}`),
            ...unpriced.slice(0, 6).map((entry) => h('button', {
              key: entry.model,
              type: 'button',
              className: 'tu-unpriced-item',
              onClick: () => setPriceDialog({ model: entry.model, input: '', output: '' }),
            }, entry.model)),
          ),
        h('div', { className: 'tu-toolbar-actions' },
          h('button', {
            type: 'button', className: 'tu-button',
            onClick: () => setAliasForm({}),
          }, t('alias.manage')),
          h('button', {
            type: 'button', className: 'tu-button',
            title: t('cost.refreshHint'),
            onClick: () => { void refreshPricing() },
          }, t('cost.refresh')),
        ),
      )

      // 别名管理弹窗：列出「看起来像内部代号」的模型，供用户确认真实名称。
      const aliasCandidates = (() => {
        if (data === undefined) return []
        const aliases = data?.modelAliases ?? {}
        const names = Object.keys(data?.byModelName ?? {})
        // 判断哪些可能是代号：没有斜杠、不含常见模型关键词、长度短。
        // 这只是给用户一个「可能需要处理」的提示，不自动改任何东西。
        const looksLikeCode = (name) => {
          if (aliases[name] !== undefined) return true   // 已配置的优先列出
          if (name.includes('/')) return false
          if (/deepseek|claude|gpt|glm|qwen|kimi|gemini|llama|grok|mistral/i.test(name)) return false
          return /^[a-z]{2,8}\d{0,3}$/i.test(name)
        }
        return names.filter(looksLikeCode).sort()
      })()

      const aliasModal = aliasForm === null ? null : h('div', {
        className: 'tu-modal-backdrop',
        onClick: (event) => { if (event?.target === event?.currentTarget) setAliasForm(null) },
      },
      h('div', { className: 'tu-modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'tu-modal-title' }, t('alias.title')),
        h('p', { className: 'tu-hint' }, t('alias.hint')),

        aliasCandidates.length === 0
          ? h('p', { className: 'tu-hint' }, t('alias.none'))
          : h('div', { className: 'tu-aliaslist' },
            ...aliasCandidates.map((raw) => h('div', { key: raw, className: 'tu-aliasrow' },
              h('span', { className: 'tu-aliasraw', title: raw }, raw),
              h('span', { className: 'tu-aliasarrow' }, '→'),
              h('input', {
                type: 'text',
                className: 'tu-priceinput',
                placeholder: t('alias.display'),
                value: aliasForm[raw] ?? (data?.modelAliases?.[raw] ?? ''),
                onChange: (event) => setAliasForm((current) => (
                  current === null ? null : { ...current, [raw]: event.target.value })),
              }),
              h('button', {
                type: 'button', className: 'tu-button',
                onClick: () => { void saveAlias(raw, aliasForm[raw] ?? '') },
              }, t('alias.save')),
            )),
          ),

        h('div', { className: 'tu-modal-actions' },
          h('button', {
            type: 'button', className: 'tu-button',
            onClick: () => setAliasForm(null),
          }, t('version.dialogOk')),
        ),
      ))

      // 版本检查结果弹窗：有新版给「更新并重载」，无新版给「知道了」。
      const versionModal = versionDialog === null ? null : h('div', {
        className: 'tu-modal-backdrop',
        onClick: () => setVersionDialog(null),
      },
      h('div', {
        className: 'tu-modal',
        role: 'dialog',
        'aria-modal': 'true',
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { className: 'tu-modal-title' },
        versionDialog.kind === 'reinstall' ? t('version.reinstallTitle') : t('version.checkTitle')),
      h('div', { className: 'tu-modal-body' },
        versionDialog.kind === 'new'
          ? `${t('version.newBody')}（${pluginVersion} → ${versionDialog.latest}）`
          : versionDialog.kind === 'success'
            ? `${t('version.success')}：${t('version.successBody')} ${versionDialog.latest}`
            : versionDialog.kind === 'reinstall'
              // 跨版本差异过大时，自动升级会被拒绝；这里给出可执行的操作路径，
              // 而不是让用户反复重试或去翻日志。
              ? `${versionDialog.message}`
              : versionDialog.kind === 'same'
                ? `${t('version.sameBody')}（${pluginVersion}）`
                : `${t('version.checkFailed')}：${versionDialog.message}`),
      versionDialog.kind === 'reinstall'
        ? h('p', { className: 'tu-hint tu-reinstall-hint' }, t('version.reinstallHint'))
        : null,
      // 更新说明：有就滚动展示，没有就明确写「无」，不留空白让人猜。
      versionDialog.kind === 'new'
        ? h('div', { className: 'tu-modal-notes' },
          h('div', { className: 'tu-modal-notes-title' }, t('version.notes')),
          h('pre', { className: 'tu-modal-notes-body' },
            (versionDialog.notes ?? '') === ''
              ? t('version.noNotes')
              : versionDialog.notes),
        )
        : null,
      // 更新中的阶段提示：下载 / 替换 / 重载，三段式。
      // 条件要严：phase 必须是已知阶段之一。只检查 `phase !== ''` 会把
      // undefined 也放进来（历史 bug：检查更新的弹窗里冒出「正在热重载」）。
      isUpdating
        ? h('div', { className: 'tu-modal-progress' },
          h('div', { className: 'tu-scan-bar' },
            h('div', { className: 'tu-scan-fill', 'data-indeterminate': 'true' }),
          ),
          h('div', { className: 'tu-scan-meta' },
            updateState.phase === 'download'
              ? t('version.progressDownload')
              : updateState.phase === 'install'
                ? t('version.progressInstall')
                : t('version.progressActivate')),
        )
        : null,
      h('div', { className: 'tu-modal-actions' },
        versionDialog.kind === 'new'
          ? h('button', {
            type: 'button',
            className: 'tu-button tu-button-primary',
            // 不关弹窗：更新过程要在弹窗里显示三段式进度，
            // 关掉就没有任何地方能看到「正在做什么」了。
            onClick: () => { void applyUpdate() },
          }, t('version.dialogUpdate'))
          : null,
        h('button', {
          type: 'button',
          className: 'tu-button',
          onClick: () => setVersionDialog(null),
        }, versionDialog.kind === 'new'
          ? t('version.dialogLater')
          : versionDialog.kind === 'reinstall' ? t('version.reinstallOk') : t('version.dialogOk')),
        ),
      ))

      // 页脚只保留更新时间，并靠右下角。回扫会话数与数据文件路径是排障信息，
      // 放在主界面上属于噪音（而且「已回扫 26 / 21」这种比值本身会让人困惑）。
      const note = h('div', { className: 'tu-note' },
        h('span', null, `${t('updatedAt')} ${formatTime(data?.generatedAt, locale)}`),
      )

      /**
       * 非统计页：模型接入与预算都是完整页面，不叠在统计内容下面。
       *
       * 注意这里必须把**两个页面都纳入判断**。早先只在 topView === 'suppliers'
       * 时进入这个分支，导致点「预算」仍落到统计页——页签高亮了但内容没换。
       */
      if (topView === 'suppliers' || topView === 'budget') {
        return h('div', { className: 'tu-root' },
          head, toolbar,
          topView === 'budget' ? budgetPage : supplierPage,
          supplierModal, modelsModal, versionModal)
      }

      return h('div', { className: 'tu-root' },
        head, scanBar, toolbar, tabs, accountBar, cards, budgetGroupBars, charts, heatmap, sections,
        warn, note, versionModal, priceModal, aliasModal)
    }

    //#endregion

    //#region 侧边栏图标

    /** 侧边栏入口图标：一个简化的“用量柱状”图形，用品牌色。 */
    function TokenUsageIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('rect', { x: 3, y: 12, width: 4, height: 9, rx: 1.2, fill: 'currentColor', opacity: 0.55 }),
      h('rect', { x: 10, y: 7, width: 4, height: 14, rx: 1.2, fill: 'currentColor' }),
      h('rect', { x: 17, y: 3, width: 4, height: 18, rx: 1.2, fill: 'currentColor', opacity: 0.8 }),
      )
    }

    //#endregion

    /**
     * 插入本插件的样式表。
     *
     * 用 `document.createElement('style')` 而不是任何宿主样式服务：样式表
     * 随 effect 卸载一并移除，且不依赖宿主内部 API 的稳定性。
     */
    function insertStyles() {
      if (typeof document === 'undefined') return () => {}
      // 关键：不能「已存在就跳过」。浏览器 HMR 换掉 client 模块时不会走卸载
      // 流程，旧的 <style> 会留在 DOM 里；若此时直接返回，新样式永远不生效
      // （改了半天看不到变化，就是这个原因）。因此每次都以最新内容覆盖。
      const previous = document.querySelector('style[data-plugin="dsh-token-metrics"]')
      if (previous !== null) previous.remove()
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-token-metrics')
      tag.textContent = STYLE_TEXT
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /**
     * 右下角通知。
     *
     * 与 our-free-model 插件同一位置与观感：那里是 DSH 里已有的通知落点，
     * 用户的注意力已经习惯在右下角。用纯 DOM 而不是 React 渲染，
     * 因为通知要能在「用户正停在会话页、面板根本没挂载」时也出现。
     */
    const toastHostRef = { current: null }
    const toastTimers = new Set()

    /** 确保右下角容器存在。 */
    function ensureToastHost() {
      if (toastHostRef.current !== null && document.body.contains(toastHostRef.current)) {
        return toastHostRef.current
      }
      const host = document.createElement('div')
      host.className = 'tu-toasts'
      document.body.appendChild(host)
      toastHostRef.current = host
      return host
    }

    /**
     * 弹一条通知。
     *
     * @param {{title:string, body:string, level?:string}} alert
     * @param {object} [options] `ttl` 毫秒后自动消失，0 表示不自动关
     */
    function showToast(alert, options = {}) {
      const host = ensureToastHost()
      const ttl = options.ttl ?? 8000
      const card = document.createElement('div')
      card.className = 'tu-toast'
      card.dataset.level = alert.level ?? 'warn'

      const title = document.createElement('div')
      title.className = 'tu-toast-title'
      title.textContent = alert.title ?? ''
      card.appendChild(title)

      if (typeof alert.body === 'string' && alert.body !== '') {
        const body = document.createElement('div')
        body.className = 'tu-toast-body'
        body.textContent = alert.body
        card.appendChild(body)
      }

      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'tu-toast-close'
      close.textContent = '×'
      close.addEventListener('click', () => dismiss())
      card.appendChild(close)

      let timer
      const dismiss = () => {
        if (timer !== undefined) { clearTimeout(timer); toastTimers.delete(timer) }
        card.remove()
        // 容器空了就一并移除，避免留下一个空的 fixed 层挡住点击
        if (host.childElementCount === 0) host.remove()
      }
      host.appendChild(card)
      if (ttl > 0) {
        timer = setTimeout(dismiss, ttl)
        toastTimers.add(timer)
      }
      return dismiss
    }

    /** 关掉所有通知（插件卸载时调用）。 */
    function clearToasts() {
      for (const timer of toastTimers) clearTimeout(timer)
      toastTimers.clear()
      toastHostRef.current?.remove()
      toastHostRef.current = null
    }

    function apply(ctx) {
      // 每个注册都独立兜底：一处失败不应该让整块 UI 消失。
      ctx.effect(() => insertStyles(), 'token-metrics: 样式')

      // —— 通知：订阅服务端推送 ——
      // 用 EventSource 长连接；它自带重连，热重载时服务端会关掉流，
      // 一秒后自动重连并收到新的 hello。
      ctx.effect(() => {
        if (typeof EventSource !== 'function') return () => {}
        let source
        try {
          source = new EventSource(EVENTS_ROUTE, { withCredentials: true })
        } catch {
          return () => {}
        }
        const onAlert = (event) => {
          try {
            const payload = JSON.parse(event.data)
            const list = Array.isArray(payload?.alerts) ? payload.alerts : []
            // 服务端有冷却，但页面可能刚刷新过（hello 已弹过同一批），
            // 所以这里同样要去重。
            presentAlerts(list, {})
          } catch { /* 脏数据忽略 */ }
        }
        // 本次页面会话里已经弹过的告警 id。放 localStorage 而不是内存：
        // 页面刷新也算同一个「会话」，不该因为刷新就把同一批通知再弹一遍。
        const SHOWN_KEY = 'dsh-token-metrics:shown-alerts'
        const shownAlerts = (() => {
          try {
            const raw = localStorage.getItem(SHOWN_KEY)
            const parsed = raw === null ? {} : JSON.parse(raw)
            return parsed !== null && typeof parsed === 'object' ? parsed : {}
          } catch { return {} }
        })()
        const SHOWN_TTL_MS = 6 * 60 * 60_000   // 6 小时内不重复弹同一条
        const persistShown = () => {
          try { localStorage.setItem(SHOWN_KEY, JSON.stringify(shownAlerts)) } catch { /* 隐私模式 */ }
        }
        /** 这条告警最近是否已经弹过（未过 TTL）。 */
        const recentlyShown = (alert) => {
          const at = shownAlerts[alert?.id]
          if (at === undefined) return false
          return Date.now() - Number(at) < SHOWN_TTL_MS
        }
        const markShown = (alert) => {
          if (alert?.id === undefined) return
          shownAlerts[alert.id] = Date.now()
        }

        /** 统一出口：去重后再弹。 */
        const presentAlerts = (list, options) => {
          const fresh = list.filter((alert) => !recentlyShown(alert))
          for (const alert of fresh.slice(0, 3)) {
            showToast(alert, options)
            markShown(alert)
          }
          if (fresh.length > 0) persistShown()
        }

        // hello 带的是「当前已有告警」。它不经过服务端冷却，所以客户端
        // 必须自己判断是否已经弹过——否则每次刷新页面都会重弹一遍。
        const onHello = (event) => {
          try {
            const payload = JSON.parse(event.data)
            const list = Array.isArray(payload?.alerts) ? payload.alerts : []
            presentAlerts(list, { ttl: 6000 })
          } catch { /* 忽略 */ }
        }
        source.addEventListener('alert', onAlert)
        source.addEventListener('hello', onHello)
        return () => {
          source.removeEventListener('alert', onAlert)
          source.removeEventListener('hello', onHello)
          try { source.close() } catch { /* 已关闭 */ }
          clearToasts()
        }
      }, 'token-metrics: 通知订阅')

      let t = (key) => key
      let currentLocale = () => 'zh'
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-metrics: 文案')
        t = ctx.locale.bind(NS)
        // LocaleSnapshot 的当前语言字段是 `active`（不是 locale/id）。
        // 早先读错字段名，导致语言永远退回默认值、不跟随宿主设置。
        currentLocale = () => {
          try {
            const snapshot = ctx.locale.getSnapshot?.() ?? ctx.locale.getLocale?.()
            const id = snapshot?.active
            return typeof id === 'string' && id.startsWith('zh') ? 'zh' : 'en'
          } catch {
            return 'zh'
          }
        }
        // 暴露给面板：读当前语言 + 订阅变化。
        localeReaderRef.current = currentLocale
        if (typeof ctx.locale.subscribe === 'function') {
          // 订阅本身也是资源，必须随插件卸载释放。
          ctx.effect(() => ctx.locale.subscribe(() => {
            const next = currentLocale()
            // 通知已挂载的面板；具体重渲染由 React 的 state 更新完成。
            localeNotifierRef.current?.(next)
          }), 'token-metrics: 语言订阅')
          localeSubscribeRef.current = (fn) => {
            localeNotifierRef.current = fn
            return () => {
              if (localeNotifierRef.current === fn) localeNotifierRef.current = undefined
            }
          }
        }
      } catch (error) {
        console.error('[dsh-token-metrics] 文案注册失败，使用内置文案：', error)
      }

      // 统计页：注册到 main 面板，key 即侧边栏条目的 id。
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ t, locale: currentLocale() }),
        }, TokenUsagePanel))
      } catch (error) {
        console.error('[dsh-token-metrics] 统计页注册失败：', error)
      }

      // 侧边栏入口：注册到全局面板图标列表。
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => t('panel.title'),
        }, TokenUsageIcon))
      } catch (error) {
        console.error('[dsh-token-metrics] 侧边栏入口注册失败：', error)
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
