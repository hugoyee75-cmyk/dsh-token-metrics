/**
 * Client 侧冒烟测试。
 *
 * 浏览器里 `window.__ModuleLoader__.load({ id, factory })` 由宿主的模块加载器
 * 执行。这里提供最小的 `window` / `require` / `document` 桩，驱动 factory
 * 走完 `apply(ctx)`，断言：
 *   - apply 不抛错
 *   - 注册了 `main`（统计页）与 `sidebar.panellist`（入口）两个 slot
 *   - 面板组件的渲染函数不抛错
 *   - 样式表被插入且只引用主题 token
 *
 * 运行：node test/client-test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// —— 最小 DOM 桩 ——
const insertedStyles = []
const documentStub = {
  hidden: false,
  head: {
    appendChild(tag) {
      insertedStyles.push(tag)
    },
  },
  querySelector() {
    return null
  },
  createElement(tagName) {
    return {
      tagName,
      attributes: {},
      textContent: '',
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      remove() {
        const index = insertedStyles.indexOf(this)
        if (index !== -1) insertedStyles.splice(index, 1)
      },
    }
  },
  addEventListener() {},
  removeEventListener() {},
}

// —— 最小 React 桩 ——
// 只需要能构造元素树并识别组件函数，不需要真实渲染。
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

// 极简 hooks 运行时：让组件能真正跑完一次「加载数据 → 渲染」的流程。
// 不模拟重渲染循环，只在 effect 里同步完成一次数据填充。
const hookState = []
let hookIndex = 0
/**
 * 每次渲染重置索引，但保留状态值——模拟 React 的跨渲染持久化。
 *
 * 注意：这依赖「每次渲染的 hook 调用顺序完全一致」。组件里出现条件化的
 * hook 调用（或渲染中途提前 return）时索引会错位，所以测试里的渲染必须
 * 走同一条代码路径。渲染不同分支时先调用 resetHooks 再重渲染。
 */
function resetHooks() {
  hookIndex = 0
}
// 待执行的状态更新：模拟点击按钮后 React 安排的重渲染。
let pendingUpdates = []
function flushUpdates() {
  for (const update of pendingUpdates) update()
  pendingUpdates = []
}
const React = {
  createElement,
  useState(initial) {
    const index = hookIndex++
    if (!(index in hookState)) {
      hookState[index] = typeof initial === 'function' ? initial() : initial
    }
    const set = (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
    }
    return [hookState[index], set]
  },
  useEffect(effect) {
    // 立即执行，忽略清理函数（测试只关心首帧结果）。
    const cleanup = effect()
    if (typeof cleanup === 'function') pendingCleanups.push(cleanup)
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = { current: value }
    return hookState[index]
  },
  Fragment: Symbol('Fragment'),
}
const pendingCleanups = []

// —— 加载 client.js ——
let loaded
globalThis.window = {
  navigator: { language: 'zh-CN' },
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, factory }
    },
  },
}
globalThis.document = documentStub
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return {
      generatedAt: Date.now(),
      today: '2026-10-19',
      totals: {
        all: { calls: 12, inputTokens: 3400, outputTokens: 900, cacheReadTokens: 1200, cacheWriteTokens: 0, reasoningTokens: 300, totalTokens: 5500, cacheHitRate: 0.26 },
        today: { calls: 3, inputTokens: 800, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 60, totalTokens: 1100 },
        week: { calls: 10, inputTokens: 3000, outputTokens: 700, cacheReadTokens: 900, cacheWriteTokens: 0, reasoningTokens: 250, totalTokens: 4600 },
      },
      byDay: { '2026-10-19': { calls: 3, inputTokens: 800, outputTokens: 200, totalTokens: 1100 } },
      byProvider: { workbuddy: { calls: 12, inputTokens: 3400, outputTokens: 900, totalTokens: 5500 } },
      byModel: { 'workbuddy/deepseek-v4.1-flash': { calls: 12, inputTokens: 3400, outputTokens: 900, totalTokens: 5500 } },
      byModelName: {
        'deepseek-v4.1-flash': { calls: 9, inputTokens: 2400, outputTokens: 600, totalTokens: 4000, cacheHitRate: 0.3 },
        qfmodel: { calls: 3, inputTokens: 1000, outputTokens: 300, totalTokens: 1500, cacheHitRate: 0.2 },
      },
      byModelDay: {
        'deepseek-v4.1-flash': { '2026-10-17': 1200, '2026-10-18': 1300, '2026-10-19': 1500 },
        qfmodel: { '2026-10-17': 400, '2026-10-18': 500, '2026-10-19': 600 },
      },
      repositoryUrl: 'https://github.com/example/dsh-token-usage',
      bySession: {
        'session-a': { id: 'session-a', title: '测试会话', provider: 'workbuddy', model: 'deepseek-v4.1-flash', lastAt: Date.now(), counters: { calls: 12, totalTokens: 5500 } },
      },
      trend: {
        '2026-10-17': { calls: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 400, totalTokens: 520, cacheHitRate: 0.8 },
        '2026-10-18': { calls: 3, inputTokens: 200, outputTokens: 30, cacheReadTokens: 500, totalTokens: 730, cacheHitRate: 0.71 },
        '2026-10-19': { calls: 3, inputTokens: 300, outputTokens: 40, cacheReadTokens: 600, totalTokens: 940, cacheHitRate: 0.67 },
      },
      modelTrend: {
        days: ['2026-10-17', '2026-10-18', '2026-10-19'],
        series: [
          { key: 'workbuddy/deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', values: { '2026-10-17': 300, '2026-10-18': 400, '2026-10-19': 500 } },
          { key: 'qoder/qfmodel', label: 'qfmodel', values: { '2026-10-17': 100, '2026-10-18': 200, '2026-10-19': 150 } },
        ],
      },
      config: { showSessions: true, snapshotCacheMs: 3000, retentionDays: 400, trackAccount: true, maxTrendSeries: 6 },
      byProject: {
        '/home/dev/projects/dsh-token-usage': { calls: 8, inputTokens: 2000, outputTokens: 500, cacheReadTokens: 800, totalTokens: 3300, cacheHitRate: 0.28 },
        '/home/dev/projects/multi-agent': { calls: 4, inputTokens: 1400, outputTokens: 400, cacheReadTokens: 400, totalTokens: 2200, cacheHitRate: 0.22 },
      },
      byOrigin: {
        main: { calls: 9, inputTokens: 2800, outputTokens: 700, totalTokens: 4000 },
        subagent: { calls: 3, inputTokens: 600, outputTokens: 200, totalTokens: 1500 },
      },
      accounts: {
        unknown: { calls: 12, inputTokens: 3400, outputTokens: 900, totalTokens: 5500, firstAt: Date.now() - 86400000, lastAt: Date.now() },
      },
      failedAttempts: null,
      currentAccount: {
        id: 'u-123', name: '测试账号',
        balance: [{ currency: 'CNY', balance: '12.34' }],
        bonus: [], usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup',
        refreshedAt: Date.now(),
      },
      integrity: { consistent: true },
      sessionCount: 1,
      scannedCount: 1,
      storePath: '/tmp/usage.json',
    }
  },
})

const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')
// 在 vm 里执行，避免污染本进程。
const { runInNewContext } = await import('node:vm')
runInNewContext(clientSource, {
  window: globalThis.window,
  document: documentStub,
  fetch: globalThis.fetch,
  console,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  Number,
  String,
  Object,
  Array,
  Error,
  URL,
  Symbol,
})

if (loaded === undefined) {
  console.error('✗ client.js 没有调用 __ModuleLoader__.load')
  process.exit(1)
}

// —— 驱动 factory ——
const moduleStub = { exports: {} }
const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error(`意外的模块依赖：${name}`)
}
const exportsValue = loaded.factory(requireStub)

const failures = []
function check(label, condition, detail) {
  if (!condition) failures.push(`${label}${detail ? `：${detail}` : ''}`)
}

check('模块 id', loaded.id === 'dsh-token-usage', loaded.id)
check('导出了 apply', typeof exportsValue.apply === 'function')
check('导出了 name', typeof exportsValue.name === 'string')
check('声明了 slots 依赖', Array.isArray(exportsValue.inject) && exportsValue.inject.includes('slots'),
  JSON.stringify(exportsValue.inject))

// —— 假 ctx：记录注册 ——
const registrations = []
const effects = []
const localeRegistrations = []
// 模拟宿主当前语言与订阅者
let currentLocaleId = 'zh'
let localeSubscribeFired = false
const localeSubscribers = []
const ctx = {
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return () => {}
  },
  slots: {
    inject(ownerKey, callback) {
      const disposer = callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push({ ns, dicts })
      return () => {}
    },
    // 真实宿主的 bind 在**调用时**读当前语言，因此绑定一次即可跟随切换。
    // 桩必须照此实现，否则「切语言后文案不变」这类 bug 测不出来。
    bind() {
      return (key) => {
        const dicts = localeRegistrations[0]?.dicts ?? {}
        return dicts[currentLocaleId]?.[key] ?? dicts.zh?.[key] ?? key
      }
    },
    // 真实快照的当前语言字段是 `active`——桩必须照实模拟，
    // 否则读错字段名的 bug 测不出来。
    getSnapshot() {
      return { active: currentLocaleId, locales: [], revision: 0 }
    },
    subscribe(fn) {
      localeSubscribers.push(fn)
      localeSubscribeFired = true
      return () => {
        const index = localeSubscribers.indexOf(fn)
        if (index !== -1) localeSubscribers.splice(index, 1)
      }
    },
  },
}

exportsValue.apply(ctx)

check('注册了 2 个 slot', registrations.length === 2, `实际 ${registrations.length}`)

const panel = registrations.find((r) => r.options.name === 'main')
const sidebar = registrations.find((r) => r.options.name === 'sidebar.panellist')
check('统计页注册到 main', panel !== undefined)
check('统计页 key 正确', panel?.options.key === 'token-usage', panel?.options.key)
check('侧边栏入口注册', sidebar !== undefined)
check('侧边栏 id 与面板 key 一致', sidebar?.options.id === panel?.options.key,
  `${sidebar?.options.id} vs ${panel?.options.key}`)
check('侧边栏有 order', typeof sidebar?.options.order === 'number')
check('侧边栏 label 是函数', typeof sidebar?.options.label === 'function')

check('注册了 locale 文案', localeRegistrations.length === 1)
check('文案含中英双语', localeRegistrations[0]?.dicts?.zh !== undefined && localeRegistrations[0]?.dicts?.en !== undefined)
check('中英文案键一致',
  JSON.stringify(Object.keys(localeRegistrations[0].dicts.zh).sort())
  === JSON.stringify(Object.keys(localeRegistrations[0].dicts.en).sort()))

check('插入了样式表', insertedStyles.length === 1, `实际 ${insertedStyles.length}`)
const css = insertedStyles[0]?.textContent ?? ''

// 界面颜色必须走主题 token；唯一的例外是**图表分类色**——语义 token
// （brand/success/warn）表达的是状态而不是分类，深色主题里 brand-primary
// 甚至渲染成近白色，做主色板会出现白弧。所以分类色用自定义变量声明，
// 且必须同时给出亮/暗两套值。
const allowedLiterals = new Set([
  '#3b7dd8', '#18a45f', '#e08a2a', '#d94a5a', '#8358c9', '#2aa5b0', '#8a7f64',
  '#66aaf0', '#47cf8c', '#f2b053', '#f0778a', '#ab8bef', '#52d0d9', '#b6ab8e',
])
const colorLiterals = [...css.matchAll(/(?:^|[^-\w])(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/g)]
  .map((m) => m[1])
  .filter((value) => !value.startsWith('rgb(0 0 0 /'))
  .filter((value) => !allowedLiterals.has(value.toLowerCase()))
check('除分类色外只用主题 token', colorLiterals.length === 0, colorLiterals.join(', '))

// 分类色必须同时声明亮色与暗色两套，否则深色模式下会看不清
check('分类色有亮暗两套', css.includes("[data-theme='dark'] .tu-root"), true)
const lightCount = (css.match(/--tu-c\d: #[0-9a-f]{6}/g) ?? []).length
check('亮暗各声明 7 个分类色', lightCount, 14)
check('样式使用了主题变量', css.includes('--dsw-alias-'))
check('样式无 !important', !css.includes('!important'))
check('样式类名有前缀', /\.tu-/.test(css))

// —— 渲染：统计页组件至少能构造元素树，不抛错 ——
const panelInject = panel.options.inject?.()
check('统计页注入 t', typeof panelInject?.t, 'function')
check('统计页注入 locale', typeof panelInject?.locale, 'string')
// 注入的 t 应产出真实文案，而不是 key 本身
check('文案已本地化', panelInject?.t('panel.title'), 'Token 用量')
check('未知 key 回退为自身', panelInject?.t('nope.nope'), 'nope.nope')

let renderError
try {
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  check('统计页返回元素', tree !== null && typeof tree === 'object')
} catch (error) {
  renderError = error
}
check('统计页渲染不抛错', renderError === undefined, renderError?.message)

// —— 渲染：侧边栏图标 ——
let iconError
try {
  const icon = sidebar.component({ size: 18, active: false })
  check('图标返回 svg', icon?.type === 'svg', String(icon?.type))
} catch (error) {
  iconError = error
}
check('图标渲染不抛错', iconError === undefined, iconError?.message)

// —— 图表：递归查找元素树里的 svg 与图表容器 ——
const componentErrors = []
function walkTree(node, visit) {
  if (node === null || node === undefined) return
  // children 可能嵌套任意层数组（createElement 的 rest 参数、map 的结果）。
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit)
    return
  }
  if (typeof node !== 'object') {
    // 文本节点也要能被收集，否则断言渲染内容时看不到任何文字。
    visit(node)
    return
  }
  visit(node)
  // 自定义组件（函数类型）要真正调用才能看到它渲染出的 svg；
  // React 在渲染阶段也是这么做的。
  if (typeof node.type === 'function') {
    try {
      walkTree(node.type(node.props ?? {}), visit)
    } catch (error) {
      // 组件抛错不能静默吞掉：调用方需要知道是哪个组件、为什么。
      componentErrors.push(`${node.type?.name || 'anonymous'}: ${error?.message ?? error}`)
    }
    return
  }
  walkTree(node.children, visit)
}

// 首帧：status 仍是 loading（数据还没回来）。
resetHooks()
let tree
try {
  tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
} catch (error) {
  tree = undefined
}
check('首帧不抛错', tree !== undefined, true)

// 等 fetch 完成，再重渲染一次（模拟 React 的 setState 触发重渲染）。
await new Promise((resolve) => setTimeout(resolve, 200))
resetHooks()
try {
  tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
} catch (error) {
  tree = undefined
}
const found = { svg: 0, chart: 0, line: 0, rect: 0, select: 0 }
if (tree !== undefined) {
  walkTree(tree, (node) => {
    if (node.type === 'svg') found.svg += 1
    if (node.type === 'path') found.line += 1
    if (node.type === 'rect') found.rect += 1
    if (node.type === 'select') found.select += 1
    if (typeof node.props?.className === 'string' && node.props.className.includes('tu-chart')) found.chart += 1
  })
}
// 三张图已合并为：一张主趋势图（折线）+ 一张环形图（圆弧），
// 再加账号/失败/版本等区块里的少量 svg。
check('渲染出图表 svg', found.svg >= 2, `实际 ${found.svg}`)
check('渲染出折线路径', found.line >= 1, `实际 ${found.line}`)
check('渲染出环形圆弧', found.rect >= 0, `实际 ${found.rect}`)
check('渲染出刷新间隔选择器', found.select, 1)

// —— 新维度：项目 / 来源 / 账号 / 失败请求 ——
// 这些维度现在收在「明细视图」标签后面，需要切换标签才能看到。
// 这里按标签逐个渲染，既验证数据也在，也验证切换真的生效。
function textsOf(node) {
  const out = []
  walkTree(node, (item) => {
    if (typeof item === 'string') out.push(item)
    if (typeof item.props?.className === 'string') out.push(item.props.className)
    if (typeof item.props?.href === 'string') out.push(item.props.href)
  })
  return out.join(' ')
}

function renderWithTab(tabLabel) {
  resetHooks()
  let rendered = panel.component({ t: panelInject.t, locale: panelInject.locale })
  // 找到该标签的按钮并触发它的 onClick
  let clicked = false
  walkTree(rendered, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((child) => child === tabLabel)) {
      node.props?.onClick?.()
      clicked = true
    }
  })
  if (clicked) {
    resetHooks()
    rendered = panel.component({ t: panelInject.t, locale: panelInject.locale })
  }
  return { rendered, clicked, flat: textsOf(rendered) }
}

const modelView = renderWithTab('模型')
check('默认渲染模型表', modelView.flat.includes('qoder/deepseek-v4.1-flash') || modelView.flat.includes('deepseek-v4.1-flash'), true)
check('模型表有命中率列', modelView.flat.includes('缓存命中率'), true)

const originView = renderWithTab('来源')
check('能切到来源标签', originView.clicked, true)
const originFlat = originView.flat
check('来源已本地化', originFlat.includes('主会话'), true)

const projectView = renderWithTab('项目')
check('能切到项目标签', projectView.clicked, true)
check('项目路径被缩短', projectView.flat.includes('…/'), true)

const accountView = renderWithTab('账号')
check('能切到账号标签', accountView.clicked, true)
check('账号列显示未知', accountView.flat.includes('未知'), true)

// 账号条、版本条、失败提示都是常驻的，不随标签切换隐藏。
// 注意：renderWithTab 会改写共享的 hook 状态，因此这里必须重新渲染一次，
// 否则断言的是切换标签前的旧树。
resetHooks()
const residentTree = panel.component({ t: panelInject.t, locale: panelInject.locale })
const baseFlat = textsOf(residentTree)
check('渲染账号名', baseFlat.includes('测试账号'), true)
check('渲染余额', baseFlat.includes('12.34'), true)
check('渲染官方用量链接', baseFlat.includes('platform.example/usage'), true)
check('渲染账号区块', baseFlat.includes('tu-account'), true)
// 失败请求默认隐藏：Host 返回 null 时页面不渲染该区块。
const failedNodes = []
walkTree(residentTree, (node) => {
  if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-failed')) {
    failedNodes.push(node.props.className)
  }
})
check('失败请求默认不渲染', failedNodes.length === 0, `实际 ${failedNodes.length} 个节点`)

/** 模拟宿主切换语言：更新当前语言并通知所有订阅者。 */
function localeSink(next) {
  currentLocaleId = next
  for (const subscriber of localeSubscribers) subscriber()
}

// —— 语言自适应：必须跟随宿主 locale 服务，而不是靠 navigator 猜 ——
// 回归点：LocaleSnapshot 的当前语言字段是 `active`，早先读错了字段名，
// 导致语言永远退回默认、不跟随宿主设置。
check('注册了语言订阅', localeSubscribeFired, true)

// 面板通过 slot inject 拿到注册时那一次的语言；之后的语言变化必须由
// 订阅回调推送。这里刻意让 inject 一直返回旧值（'zh'），只靠订阅驱动，
// 才能真正验证「切换语言后页面跟随」而不是「重开页面才更新」。
resetHooks()
const injectedLocale = 'zh'
const beforeSwitch = textsOf(panel.component({ t: panelInject.t, locale: injectedLocale }))
check('初始为中文', beforeSwitch.includes('用量趋势') || beforeSwitch.includes('Token 用量'), true)

// 宿主切到英文：订阅回调应把新语言推给面板
localeSink('en')
resetHooks()
const afterSwitch = textsOf(panel.component({ t: panelInject.t, locale: injectedLocale }))
check('切到英文后渲染英文文案', afterSwitch.includes('Usage trend') || afterSwitch.includes('Token Usage'),
  `实际: ${afterSwitch.slice(0, 120)}`)

// 切回中文同理
localeSink('zh')
resetHooks()
const backToZh = textsOf(panel.component({ t: panelInject.t, locale: injectedLocale }))
check('切回中文后渲染中文文案', backToZh.includes('用量趋势') || backToZh.includes('Token 用量'), true)

// 直接测原始 bug：LocaleSnapshot 的语言字段是 `active`，不是 `locale`/`id`。
// 做法：把宿主语言设成英文，重新 apply 一次插件，检查注册到 main 槽位的
// `inject()` 返回的 locale 是 'en'。若读错字段名，它会退回硬编码的 'zh'。
currentLocaleId = 'en'
const enRegistrations = []
const enCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on() { return () => {} },
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject() { return () => {} },
  get() { return undefined },
  slots: {
    inject(key, callback) { callback(); return () => {} },
    register(options, component) {
      enRegistrations.push({ key: options.name, options, component })
      return () => {}
    },
  },
  locale: {
    register() { return () => {} },
    bind() { return (key) => key },
    // 只提供 `active`，刻意不提供 locale/id——读错字段就会暴露
    getSnapshot() { return { active: currentLocaleId } },
    subscribe() { return () => {} },
  },
}
let enLoaded
const previousLoader = globalThis.window.__ModuleLoader__
globalThis.window.__ModuleLoader__ = { load: (definition) => { enLoaded = definition } }
const { runInNewContext: runFresh } = await import('node:vm')
runFresh(readFileSync(join(here, '..', 'client.js'), 'utf8'), {
  window: globalThis.window, document: documentStub, fetch: globalThis.fetch,
  console, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Object, Array, Error, URL, Symbol,
})
globalThis.window.__ModuleLoader__ = previousLoader

const enExports = enLoaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`意外的模块依赖：${name}`)
})
enExports.apply(enCtx)
const enPanel = enRegistrations.find((entry) => entry.key === 'main')

check('英文环境下注入的 locale 为 en', enPanel?.options?.inject?.()?.locale === 'en',
  `实际 ${String(enPanel?.options?.inject?.()?.locale)}`)

// 中文环境同理，确认不是「永远是 en」
currentLocaleId = 'zh'
enRegistrations.length = 0
enExports.apply(enCtx)
const zhPanel = enRegistrations.find((entry) => entry.key === 'main')
check('中文环境下注入的 locale 为 zh', zhPanel?.options?.inject?.()?.locale === 'zh',
  `实际 ${String(zhPanel?.options?.inject?.()?.locale)}`)

// —— 模型筛选：对指标卡与趋势图同时生效 ——
{
  resetHooks()
  const first = panel.component({ t: panelInject.t, locale: panelInject.locale })
  let selectNode
  walkTree(first, (node) => {
    if (node?.type === 'select' && node.props?.['aria-label'] === '模型') selectNode = node
  })
  check('渲染模型筛选下拉', selectNode !== undefined, true)
  // 选项应来自 byModelName（跨供应商合并）
  const optionValues = []
  if (selectNode !== undefined) {
    walkTree(selectNode, (node) => {
      if (node?.type === 'option' && node.props?.value !== undefined) optionValues.push(node.props.value)
    })
  }
  check('下拉含「全部模型」', optionValues.includes(''), true)
  check('下拉列出合并后的模型名', optionValues.includes('deepseek-v4.1-flash'), `实际 ${optionValues.join(',')}`)
  check('下拉不列 provider 前缀', optionValues.includes('workbuddy/deepseek-v4.1-flash') === false,
    `实际 ${optionValues.join(',')}`)
}

// —— 右上角工具区：Star 直达开源页 ——
{
  resetHooks()
  const first = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const links = []
  walkTree(first, (node) => {
    if (node?.type === 'a' && typeof node.props?.href === 'string') links.push(node.props.href)
  })
  check('渲染 Star 链接', links.includes('https://github.com/example/dsh-token-usage'),
    `实际 ${links.join(',')}`)
}

// —— 页脚只剩更新时间 ——
{
  resetHooks()
  const first = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const footers = []
  walkTree(first, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className === 'tu-note') {
      footers.push(textsOf(node))
    }
  })
  check('页脚存在', footers.length > 0, true)
  const footer = footers.join(' ')
  check('页脚含更新时间', footer.includes('更新于') || footer.includes('Updated'), true)
  check('页脚不再显示回扫会话数', footer.includes('已回扫会话') === false, `实际 ${footer.slice(0, 120)}`)
  check('页脚不再显示数据文件路径', footer.includes('usage.json') === false, `实际 ${footer.slice(0, 120)}`)
}

// —— 版本条只留版本号，按钮移到右上角 ——
{
  resetHooks()
  const first = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const classes = []
  walkTree(first, (node) => {
    if (typeof node?.props?.className === 'string') classes.push(node.props.className)
  })
  check('有右上角工具区', classes.some((c) => c.includes('tu-headtools')), true)
  check('版本条保留版本号', classes.some((c) => c.includes('tu-version-code')), true)
}

// —— 图表合并：三张图合成一张可切换的主图 + 一张环形图 ——
check('渲染出环形图', baseFlat.includes('tu-pie'), true)
check('渲染出图表模式切换', baseFlat.includes('chart.mode.total') || baseFlat.includes('总量'), true)
check('渲染出明细视图标签', baseFlat.includes('tu-tabs-wrap'), true)

// 图表模式切换：命中率模式应改变 Y 轴刻度格式
const cacheMode = (() => {
  resetHooks()
  let rendered = panel.component({ t: panelInject.t, locale: panelInject.locale })
  walkTree(rendered, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((child) => child === '命中率')) {
      node.props?.onClick?.()
    }
  })
  resetHooks()
  return textsOf(panel.component({ t: panelInject.t, locale: panelInject.locale }))
})()
check('切到命中率模式渲染百分比', cacheMode.includes('%'), true)

// 构成模式：三层堆叠面积 + 图例
const composeMode = (() => {
  resetHooks()
  let rendered = panel.component({ t: panelInject.t, locale: panelInject.locale })
  walkTree(rendered, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((child) => child === '构成')) {
      node.props?.onClick?.()
    }
  })
  resetHooks()
  return textsOf(panel.component({ t: panelInject.t, locale: panelInject.locale }))
})()
check('切到构成模式渲染图例', composeMode.includes('新输入') && composeMode.includes('缓存命中'),
  `实际: ${composeMode.slice(0, 160)}`)

// 按模型模式：多序列曲线 + 图例，共用一条时间轴。
// 只断言渲染出的内容（图例文案），不数元素节点——数节点依赖 hook 索引
// 完全对齐，脆弱且与用户可见结果无关。
{
  resetHooks()
  const first = panel.component({ t: panelInject.t, locale: panelInject.locale })
  walkTree(first, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((child) => child === '按模型')) {
      node.props?.onClick?.()
    }
  })
  resetHooks()
  const modelTree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const modelFlat = textsOf(modelTree)
  // 图例应列出各模型名
  check('按模型模式渲染图例', modelFlat.includes('deepseek-v4.1-flash') && modelFlat.includes('qfmodel'),
    `实际: ${modelFlat.slice(-260)}`)
  // 图表容器仍在（说明切模式没有把图表整块打掉）
  check('按模型模式仍渲染图表', modelFlat.includes('tu-chart-canvas'), true)
  // 时间轴首尾日期来自 modelTrend 的 days
  check('时间轴用 modelTrend 的天数', modelFlat.includes('10-17') && modelFlat.includes('10-19'), true)
}

// 悬停提示：这是用户报的「鼠标移上去不显示数值」的直接回归测试。
// 在面板真实渲染出的树上找到趋势图 svg，触发 onMouseMove，再重渲染，
// 断言提示框出现且带着具体数值。
const hoverRendered = (() => {
  // 先切回「总量」模式：上一步刚测过「按模型」，多序列图没有单条 onMouseMove 曲线。
  resetHooks()
  {
    const reset = panel.component({ t: panelInject.t, locale: panelInject.locale })
    walkTree(reset, (node) => {
      if (node?.type === 'button' && Array.isArray(node.children)
        && node.children.some((child) => child === '总量')) {
        node.props?.onClick?.()
      }
    })
  }
  resetHooks()
  let treeAfter = panel.component({ t: panelInject.t, locale: panelInject.locale })
  let svg
  walkTree(treeAfter, (node) => {
    if (node?.type === 'svg' && typeof node.props?.onMouseMove === 'function') svg = node
  })
  const svgInfo = []
  walkTree(treeAfter, (x) => {
    if (x?.type === 'svg') svgInfo.push(`${x.props?.className ?? '?'}|move=${typeof x.props?.onMouseMove === 'function'}`)
  })
  const hasGrid = textsOf(treeAfter).includes('tu-grid-2')
  // 图表区到底渲染了什么？
  const chartSection = []
  walkTree(treeAfter, (x) => {
    if (typeof x === 'string' && (x.includes('tu-chart') || x.includes('tu-grid') || x.includes('tu-empty') || x.includes('tu-pie'))) chartSection.push(x)
  })
  check('趋势图 svg 带鼠标事件', svg !== undefined, `svgs=[${svgInfo.join(' ; ')}] grid2=${hasGrid}`)
  if (svg === undefined) return undefined
  // 模拟鼠标移到图表中部：容器宽 720，clientX 落在中间
  svg.props.onMouseMove({
    currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 720, top: 0, height: 160 }) },
    clientX: 400,
  })
  resetHooks()
  return textsOf(panel.component({ t: panelInject.t, locale: panelInject.locale }))
})()

if (hoverRendered !== undefined) {
  check('悬停后显示提示框', hoverRendered.includes('tu-chart-tip'), true)
  check('提示框带具体数值', /总量|命中率/.test(hoverRendered), true)
}

if (failures.length > 0) {
  if (componentErrors.length > 0) {
    console.error('组件抛错：')
    for (const error of componentErrors) console.error('  !', error)
  }
  console.error('失败：')
  for (const failure of failures) console.error('  ✗', failure)
  process.exit(1)
}

console.log('✓ Client 侧全部断言通过')
console.log(`  ${registrations.length} 个 slot 注册 / ${Object.keys(localeRegistrations[0].dicts.zh).length} 条文案 / 样式 ${css.length} 字符，仅用主题 token`)
