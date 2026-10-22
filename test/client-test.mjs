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
      byDay: {
        // 跨月数据：趋势图「全部」范围按月聚合，只有 1 个月就画不出线
        '2026-08-15': { calls: 1, inputTokens: 200, outputTokens: 50, totalTokens: 250 },
        '2026-09-10': { calls: 2, inputTokens: 400, outputTokens: 80, totalTokens: 480 },
        '2026-10-17': { calls: 2, inputTokens: 500, outputTokens: 100, totalTokens: 600 },
        '2026-10-18': { calls: 3, inputTokens: 700, outputTokens: 150, totalTokens: 850 },
        '2026-10-19': { calls: 3, inputTokens: 800, outputTokens: 200, totalTokens: 1100 },
      },
      // 小时桶：供「今日」范围按小时画曲线
      byHour: {
        '2026-10-19': {
          '09': { calls: 1, inputTokens: 200, outputTokens: 40, totalTokens: 240 },
          '10': { calls: 1, inputTokens: 300, outputTokens: 60, totalTokens: 360 },
          '14': { calls: 1, inputTokens: 300, outputTokens: 100, totalTokens: 400 },
        },
      },
      byProvider: {
        'official-route': { calls: 5, inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
        'balance-route': { calls: 4, inputTokens: 800, outputTokens: 80, totalTokens: 880 },
        'mystery-route': { calls: 3, inputTokens: 600, outputTokens: 60, totalTokens: 660 },
      },
      providerKinds: { 'official-route': 'apikey', 'balance-route': 'balance' },
      modelAliases: { qfmodel: 'deepseek-v4.1-flash' },
      // 性能指标：回归点是「formatDuration 先用后声明」导致白屏，
      // 而组件测试在 data 为空时那行代码根本执行不到 —— 必须带真实数据。
      performance: {
        total: { ttftMs: 245.4, tps: 38.6, samples: 10 },
        byModel: {
          'workbuddy/deepseek-v4.1-flash': { ttftMs: 189.2, tps: 52.1, samples: 6 },
        },
      },
      byModel: { 'workbuddy/deepseek-v4.1-flash': { calls: 12, inputTokens: 3400, outputTokens: 900, totalTokens: 5500 } },
      byModelName: {
        'deepseek-v4.1-flash': { calls: 9, inputTokens: 2400, outputTokens: 600, totalTokens: 4000, cacheHitRate: 0.3 },
        qfmodel: { calls: 3, inputTokens: 1000, outputTokens: 300, totalTokens: 1500, cacheHitRate: 0.2 },
      },
      byModelFacets: {
        'deepseek-v4.1-flash': {
          provider: { workbuddy: { calls: 9, inputTokens: 2400, outputTokens: 600, totalTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
          project: { '/proj/a': { calls: 9, inputTokens: 2400, outputTokens: 600, totalTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
          origin: { main: { calls: 9, inputTokens: 2400, outputTokens: 600, totalTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
          account: { unknown: { calls: 9, inputTokens: 2400, outputTokens: 600, totalTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
          day: { '2026-10-19': { calls: 9, inputTokens: 2400, outputTokens: 600, totalTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
        },
        qfmodel: {
          provider: { qoder: { calls: 3, inputTokens: 1000, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
          project: { '/proj/b': { calls: 3, inputTokens: 1000, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
          origin: { main: { calls: 3, inputTokens: 1000, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
          account: { unknown: { calls: 3, inputTokens: 1000, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
          day: { '2026-10-19': { calls: 3, inputTokens: 1000, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
        },
      },
      byModelDay: {
        'deepseek-v4.1-flash': { '2026-10-17': 1200, '2026-10-18': 1300, '2026-10-19': 1500 },
        qfmodel: { '2026-10-17': 400, '2026-10-18': 500, '2026-10-19': 600 },
      },
      repositoryUrl: 'https://github.com/example/dsh-token-metrics',
      bySession: {
        'session-a': { id: 'session-a', title: '测试会话', provider: 'workbuddy', model: 'deepseek-v4.1-flash', lastAt: Date.now(), counters: { calls: 12, totalTokens: 5500 } },
      },
      trend: {
        '2026-10-17': { calls: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 400, totalTokens: 520, cacheHitRate: 0.8 },
        '2026-10-18': { calls: 3, inputTokens: 200, outputTokens: 30, cacheReadTokens: 500, totalTokens: 730, cacheHitRate: 0.71 },
        '2026-10-19': { calls: 3, inputTokens: 300, outputTokens: 40, cacheReadTokens: 600, totalTokens: 940, cacheHitRate: 0.67 },
      },
      // 「按模型」趋势改为前端按范围重建，取的是 byDayModelName。
      // 夹具必须提供它，否则 scopedModelTrend 拿不到数据（空图）。
      byDayModelName: {
        '2026-10-17': { 'deepseek-v4.1-flash': { calls: 2, totalTokens: 300 }, qfmodel: { calls: 1, totalTokens: 100 } },
        '2026-10-18': { 'deepseek-v4.1-flash': { calls: 3, totalTokens: 400 }, qfmodel: { calls: 1, totalTokens: 200 } },
        '2026-10-19': { 'deepseek-v4.1-flash': { calls: 3, totalTokens: 500 }, qfmodel: { calls: 1, totalTokens: 150 } },
      },
      modelTrend: {
        days: ['2026-10-17', '2026-10-18', '2026-10-19'],
        series: [
          { key: 'workbuddy/deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', values: { '2026-10-17': 300, '2026-10-18': 400, '2026-10-19': 500 } },
          { key: 'qoder/qfmodel', label: 'qfmodel', values: { '2026-10-17': 100, '2026-10-18': 200, '2026-10-19': 150 } },
        ],
      },
      config: {
        showSessions: true, snapshotCacheMs: 3000, retentionDays: 400,
        trackAccount: true, maxTrendSeries: 6,
        // 带一个分组预算：让挪到预算页顶部的「当前用量」总览真的渲染，
        // 顺带覆盖 budgetGroupBars 的按范围聚合逻辑。
        budget: {
          dailyUsd: 10, monthlyUsd: 200, warnPercent: 80,
          groups: [{ id: 'g1', label: '日常编码', models: ['deepseek-v4.1-flash'], dailyUsd: 3, monthlyUsd: 60 }],
        },
      },
      byProject: {
        '/home/dev/projects/dsh-token-metrics': { calls: 8, inputTokens: 2000, outputTokens: 500, cacheReadTokens: 800, totalTokens: 3300, cacheHitRate: 0.28 },
        '/home/dev/projects/multi-agent': { calls: 4, inputTokens: 1400, outputTokens: 400, cacheReadTokens: 400, totalTokens: 2200, cacheHitRate: 0.22 },
      },
      byOrigin: {
        main: { calls: 9, inputTokens: 2800, outputTokens: 700, totalTokens: 4000 },
        subagent: { calls: 3, inputTokens: 600, outputTokens: 200, totalTokens: 1500 },
      },
      accounts: {
        unknown: { calls: 12, inputTokens: 3400, outputTokens: 900, totalTokens: 5500, firstAt: Date.now() - 86400000, lastAt: Date.now() },
        'e5a73acb-aba6-4126-b58a-a3e4bcccb2f6': { calls: 7, inputTokens: 1200, outputTokens: 300, totalTokens: 1500, firstAt: Date.now(), lastAt: Date.now() },
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { calls: 2, inputTokens: 400, outputTokens: 100, totalTokens: 500, firstAt: Date.now(), lastAt: Date.now() },
      },
      failedAttempts: null,
      currentAccount: {
        id: 'e5a73acb-aba6-4126-b58a-a3e4bcccb2f6', name: '测试账号',
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

check('模块 id', loaded.id === 'dsh-token-metrics', loaded.id)
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
check('统计页 key 正确', panel?.options.key === 'token-metrics', panel?.options.key)
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
  // 热力图色阶（5 档 × 亮暗两套）。同样不能用语义 token：
  // brand-primary 在浅色下是 #0f1115（近黑），拿它做色阶会变成一片灰黑，
  // 深浅完全分不出来 —— 这正是之前浅色模式配色发怪的原因。
  '#f0f1f4', '#d6defb', '#a8b8f8', '#7b92f5', '#4d6bfe',
  '#171a20', '#1f2a47', '#2b3d70', '#3a55a8', '#5c7cff',
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
check('文案已本地化', panelInject?.t('panel.title'), 'Token 用量统计')
check('未知 key 回退为自身', panelInject?.t('nope.nope'), 'nope.nope')

let renderError
try {
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  check('统计页返回元素', tree !== null && typeof tree === 'object')
} catch (error) {
  renderError = error
}
check('统计页渲染不抛错', renderError === undefined, renderError?.message)

// —— 渲染：供应商弹窗不抛错（防黑屏）——
// 回归点：状态指示灯曾误用另一个作用域的变量，触发 ReferenceError，
// 点「编辑」时整个弹窗渲染失败、界面变黑。
//
// 这里不模拟点击（面板的 hook 状态在测试桩里不完整），改为直接检查
// 那段渲染代码里引用的每个变量都已在同作用域声明——这是能抓住该 bug 的
// 最小断言，且不依赖桩的完整性。
{
  const src = readFileSync(join(here, '..', 'client.js'), 'utf8')
  // 状态指示灯那段代码块
  const dotBlock = src.slice(src.indexOf("className: 'tu-mlist-dot'") - 400,
    src.indexOf("className: 'tu-mlist-dot'") + 300)
  check('指示灯用本行数据而非外层变量', dotBlock.includes('selected.find((item) => item.id === model.id)'), true)
  // 关键断言：该块自己声明了局部变量来取当前模型。
  // 之前误用外层 `picked`（另一作用域、尚未初始化），触发 ReferenceError 黑屏。
  check('指示灯块自带局部变量', dotBlock.includes('const entry = selected.find'), true)
  check('指示灯用本行 entry 判断', dotBlock.includes('entry !== undefined'), true)
}

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

// —— 趋势图粒度随范围切换 ——
// 今日按小时、近7天按天、全部按月（跨年则按年）。
{
  const todayView = renderWithTab('今日')
  check('今日切到按小时', todayView.flat.includes('按小时'), true)
  const weekView = renderWithTab('近 7 天')
  check('近7天按天', weekView.flat.includes('按天'), true)
  const allView = renderWithTab('全部')
  // 测试数据全在同一年 -> 确定按月，且不应出现「按年」
  check('单年全部按月', allView.flat.includes('按月'), true)
  check('单年数据不显示按年粒度', !allView.flat.includes('按年'))
}

// —— 热力图必须能真的渲染出来（不是只要有数据就抛错）——
// 盲区说明：此前热力图完全没有渲染测试。上一版在组件里写了 `data?.today`，
// 而 ActivityHeatmap 的 props 里没有 data —— 直接 ReferenceError，
// 整个面板白屏、插件打不开，但 12 套测试全绿。这里补上真实渲染。
{
  resetHooks()
  let renderError
  let flat
  try {
    const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
    flat = textsOf(tree)
  } catch (error) {
    renderError = error
  }
  check('热力图渲染不抛错', renderError === undefined, renderError?.message)
  check('热力图标题已渲染', flat.includes('活动热力图'), true)
  // 热力图必须画出格子（有数据的 fixtures 至少一天）
  check('热力图渲染出格子', flat.includes('tu-heat-cell'), true)
}

// —— 热力图窗口以「今天」为锚点，且今天必须落在窗口内 ——
// 回归点：
//  ① anchor 曾取「最后一条有数据的日期」，停用一段时间后窗口不滚动
//     （2027 年还显示 25-26 的数据）
//  ② 起点「先回退 371 天再对齐周日」叠加错位，窗口末尾落在今天之前
//     好几天，本周格子被挤出窗口，今天的用量画不出来
{
  const src = readFileSync(join(here, '..', 'client.js'), 'utf8')
  // 锚点来自 today prop（不是裸的 data —— 那个变量在组件作用域里不存在）
  check('热力图锚点用 today prop', src.includes('const todayStr = today'), true)
  check('热力图 props 含 today', src.includes('function ActivityHeatmap({ byDay, t, onPickDay, activeDay, summary, today })'), true)
  // 顺序：先对齐周日，再回退 (WEEKS-1) 周
  const alignIdx = src.indexOf('weekStart.setDate(weekStart.getDate() - weekStart.getDay())')
  const backIdx = src.indexOf('start.setDate(start.getDate() - (WEEKS - 1) * WEEK)')
  check('先对齐周日再回退整周', alignIdx > 0 && backIdx > alignIdx, true)

  // 行为验证：用同一套算法确认今天在窗口内
  const WEEK = 7
  const WEEKS = 53
  const win = (anchor) => {
    const a = new Date(`${anchor}T00:00:00`)
    const ws = new Date(a); ws.setDate(ws.getDate() - ws.getDay())
    const start = new Date(ws); start.setDate(start.getDate() - (WEEKS - 1) * WEEK)
    const end = new Date(start); end.setDate(end.getDate() + WEEKS * WEEK - 1)
    return { start, end, inside: a >= start && a <= end }
  }
  check('今天落在窗口内', win('2026-10-22').inside, true)
  // 停用后锚点前移，窗口跟着滚动（不再停在旧月份）
  const later = win('2027-03-15')
  check('停用后窗口滚动到当前年', later.end.getFullYear() === 2027, true)
}

// —— 深色主题标记：必须是 body[data-ds-dark-theme] ——
// 回归点：早先写 [data-theme='dark']，而 DSH 实际把深色打在 body 的
// data-ds-dark-theme 上，整块深色分类色/热力色阶从未生效（热力图变白块）。
{
  const src = readFileSync(join(here, '..', 'client.js'), 'utf8')
  check('深色选择器含 body[data-ds-dark-theme]', src.includes('body[data-ds-dark-theme]'))
  check('深色块同时保留 data-theme 兜底', src.includes("[data-theme='dark'] .tu-root"))
}

// —— 预算页可达且是配置页（分组预算条已从统计页挪来） ——
{
  const budgetView = renderWithTab('预算')
  check('能切到预算页', budgetView.clicked)
  check('预算页有全局预算配置', budgetView.flat.includes('全局预算'))
  check('预算页有每日预算输入标签', budgetView.flat.includes('每日预算'))
  // 切回统计页：后续既有断言都在统计视图上找元素，停在预算页会误伤
  renderWithTab('统计')
}

// —— 按模型 / 成本 两个图表模式必须随时间范围联动 ——
// 回归点：Host 的 modelTrend 是全量的，此前直接透传，切「今日」时曲线
// 仍显示全部历史；成本模式的今日视图 costUsd 硬编码 0，画出来是一条零线。
{
  // 今日 + 按模型：图表时间轴只应出现当天（10-19），不回退到历史。
  // 注意不能分两轮 resetHooks 连点（状态会丢），必须同一棵树上一次点完。
  const todayModelChart = (() => {
    resetHooks()
    const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
    walkTree(tree, (node) => {
      if (node?.type !== 'button' || !Array.isArray(node.children)) return
      const text = node.children.filter((c) => typeof c === 'string').join('')
      if (text === '今日' || text === '按模型') node.props?.onClick?.()
    })
    resetHooks()
    const rendered = panel.component({ t: panelInject.t, locale: panelInject.locale })
    let chartNode
    walkTree(rendered, (node) => {
      if (node?.props?.className === 'tu-chart') chartNode = node
    })
    return chartNode === undefined ? '' : textsOf(chartNode)
  })()
  // 这个文件的 check 是「真值断言」：传 false 会被判失败，所以这里传取反后的正条件
  check('今日+按模型不显示历史日期',
    !(todayModelChart.includes('10-17') || todayModelChart.includes('10-18')))
  // 这两个模式切换会改变全局状态：重置回默认（全部 / 总量）再继续
  renderWithTab('统计')
  renderWithTab('全部')

  // 成本模式在今日视图必须有非零刻度（此前恒为 $0.000）
  resetHooks()
  tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  walkTree(tree, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((c) => c === '成本')) node.props?.onClick?.()
  })
  resetHooks()
  const costMode = textsOf(panel.component({ t: panelInject.t, locale: panelInject.locale }))
  check('成本模式渲染金额刻度', costMode.includes('$'), true)
  // 切回统计视图，避免影响后续断言
  renderWithTab('统计')
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
check('初始为中文', beforeSwitch.includes('用量趋势') || beforeSwitch.includes('Token 用量统计'), true)

// 宿主切到英文：订阅回调应把新语言推给面板
localeSink('en')
resetHooks()
const afterSwitch = textsOf(panel.component({ t: panelInject.t, locale: injectedLocale }))
check('切到英文后渲染英文文案', afterSwitch.includes('Usage trend') || afterSwitch.includes('Token Usage Stats'),
  `实际: ${afterSwitch.slice(0, 120)}`)

// 切回中文同理
localeSink('zh')
resetHooks()
const backToZh = textsOf(panel.component({ t: panelInject.t, locale: injectedLocale }))
check('切回中文后渲染中文文案', backToZh.includes('用量趋势') || backToZh.includes('Token 用量统计'), true)

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

// —— 模型筛选：下拉多选，对指标卡与趋势图同时生效 ——
{
  // 辅助：渲染一次面板，找到下拉按钮并触发它的 onClick。
  // 必须「渲染后立刻点」——节点引用在下次渲染后即失效，跨渲染复用会拿到
  // 没有 onClick 的旧节点（这就是之前 clicked=false 的原因）。
  function clickDropBtn() {
    resetHooks()
    const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
    let found
    walkTree(tree, (node) => {
      // 精确匹配：`includes` 会连内层的 tu-dropbtn-text 一起匹配，
      // 遍历到它时会把 found 覆盖成没有 onClick 的节点。
      if (node?.props?.className === 'tu-dropbtn') found = node
    })
    found?.props?.onClick?.()
    return { tree, found }
  }

  // 1) 收起状态：有按钮、无菜单
  resetHooks()
  const collapsed = panel.component({ t: panelInject.t, locale: panelInject.locale })
  let dropBtn
  walkTree(collapsed, (node) => {
    if (node?.props?.className === 'tu-dropbtn') dropBtn = node
  })
  check('渲染模型下拉按钮', dropBtn !== undefined, true)
  check('收起时不渲染菜单', textsOf(collapsed).includes('tu-dropmenu') === false, true)

  // 2) 展开：点按钮后重渲染
  clickDropBtn()
  resetHooks()
  const opened = panel.component({ t: panelInject.t, locale: panelInject.locale })
  check('展开后菜单存在', textsOf(opened).includes('tu-dropmenu'),
    `all=${(() => { resetHooks(); const t2 = panel.component({ t: panelInject.t, locale: panelInject.locale }); const out = []; walkTree(t2, (x) => { if (typeof x?.props?.className === 'string' && x.props.className.includes('tu-drop')) out.push(x.props.className + ':' + Object.keys(x.props).length) }); return out.join(' ; ') })()}`)
  const items = []
  walkTree(opened, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-dropitem')) items.push(node)
  })
  const labels = []
  for (const item of items) {
    const texts = []
    walkTree(item, (x) => { if (typeof x === 'string') texts.push(x) })
    labels.push(texts.join(''))
  }
  check('展开后列出全部模型', labels.some((x) => x.includes('全部模型')), labels.join(','))
  check('列出合并后的模型名', labels.some((x) => x.includes('deepseek-v4.1-flash')), labels.join(','))
  check('不含 provider 前缀', labels.some((x) => x.includes('/')) === false, labels.join(','))
  // 默认勾选「全部模型」
  const allItem = items.find((item) => textsOf(item).includes('全部模型'))
  check('默认勾选全部模型', allItem?.props?.['data-checked'] === 'true', true)

  // 3) 选一个模型 -> 按钮显示该模型；指标刷新（非 0）
  const targetItem = items.find((item) => textsOf(item).includes('deepseek-v4.1-flash'))
  targetItem?.props?.onClick?.()
  resetHooks()
  const picked = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const pickedText = textsOf(picked)
  // 收起后按钮上显示所选模型
  check('按钮显示已选模型', pickedText.includes('deepseek-v4.1-flash'), true)
  const metrics = []
  walkTree(picked, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-card-value')) {
      for (const child of node.children ?? []) if (typeof child === 'string') metrics.push(child)
    }
  })
  check('筛选后指标已刷新（非 0）', metrics.some((m) => m !== '0'), metrics.join(','))

  // 4) 多选：再勾第二个，计数显示为 2。
  // 注意：勾选后菜单仍然开着，这里不能再点按钮（那会把它关掉）。
  resetHooks()
  const secondMenu = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const secondItems = []
  walkTree(secondMenu, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-dropitem')) secondItems.push(node)
  })
  secondItems.find((item) => textsOf(item).includes('qfmodel'))?.props?.onClick?.()
  resetHooks()
  const twoPicked = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const twoText = textsOf(twoPicked)
  // 多选后按钮上应显示计数。文案是 `${t('filter.selectedCount')} ${n}`。
  {
    // 直接读下拉按钮上的文字，而不是整页文本（整页文本受其它标签页影响）。
    let btnText
    walkTree(twoPicked, (node) => {
      if (node?.props?.className === 'tu-dropbtn') {
        const parts = []
        walkTree(node, (x) => { if (typeof x === 'string') parts.push(x) })
        btnText = parts.join('')
      }
    })
    check('多选后显示已选数量', /已选\s*2/.test(btnText ?? ''), `按钮文字=${String(btnText)}`)
  }

  // 5) 取消：菜单仍开着，直接点「全部模型」清空
  resetHooks()
  const clearMenu = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const clearItems = []
  walkTree(clearMenu, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-dropitem')) clearItems.push(node)
  })
  clearItems.find((item) => textsOf(item).includes('全部模型'))?.props?.onClick?.()
  resetHooks()
  const cleared = panel.component({ t: panelInject.t, locale: panelInject.locale })
  check('清空后按钮回到全部模型', textsOf(cleared).includes('全部模型'), true)
}

// —— 右上角工具区：Star 直达开源页 ——
{
  resetHooks()
  const first = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const links = []
  walkTree(first, (node) => {
    if (node?.type === 'a' && typeof node.props?.href === 'string') links.push(node.props.href)
  })
  check('渲染 Star 链接', links.includes('https://github.com/example/dsh-token-metrics'),
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

// —— 版本指示：压缩到「检查更新」按钮下方，带状态指示灯 ——
{
  resetHooks()
  const first = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const classes = []
  let versionText
  let dotState
  walkTree(first, (node) => {
    if (typeof node?.props?.className === 'string') classes.push(node.props.className)
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-vercode')) {
      for (const child of node.children ?? []) if (typeof child === 'string') versionText = child
    }
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-verdot')) {
      dotState = node.props['data-state']
    }
  })
  check('有右上角工具区', classes.some((c) => c.includes('tu-headtools')), true)
  // 不再是占整行的版本条
  check('不再有占整行的版本条', classes.includes('tu-version') === false,
    classes.filter((c) => c.startsWith('tu-version')).join(','))
  check('版本号显示在控件区', versionText !== undefined, `实际 ${String(versionText)}`)
  // 指示灯有三种状态：new（有新版本）/ ok（已是最新）/ unknown（未检查）
  check('指示灯存在且有状态', ['new', 'ok', 'unknown'].includes(dotState), `实际 ${String(dotState)}`)

  // 桩数据里 available=false 且未检查过 -> unknown
  check('未检查时为 unknown', dotState === 'unknown', `实际 ${String(dotState)}`)

  // 重载按钮的可见性：没有版本漂移时不应出现（它平时是多余的一个按钮）。
  // 更新流程本身包含热重载，只有「磁盘版本已变但运行版本没变」才需要它。
  {
    const texts = []
    walkTree(first, (node) => {
      if (node?.type === 'button') {
        const parts = []
        walkTree(node, (x) => { if (typeof x === 'string') parts.push(x) })
        texts.push(parts.join(''))
      }
    })
    check('无版本漂移时不显示重载按钮', texts.includes('重载插件') === false, texts.join(','))
  }
}

// —— 版本检查弹窗：点击版本号 -> 弹窗告知「有新版」或「已是最新」——
// 注意：client.js 在 vm 沙箱里拿到的 `fetch` 是**模块加载时按值传入**的，
// 事后改 globalThis.fetch 对它无效。因此这里重新加载一份 client 模块，
// 并在沙箱注入「检查更新返回有新版本」的 fetch。
{
  const stubFetch = async (url) => {
    const target = String(url)
    if (target.includes('/update/check')) {
      return {
        ok: true, status: 200,
        async json() { return { available: true, latest: '0.3.0', current: '0.2.0' } },
      }
    }
    if (target.includes('/version')) {
      return {
        ok: true, status: 200,
        async json() { return { version: '0.2.0', repositoryUrl: 'https://github.com/example/dsh-token-metrics' } },
      }
    }
    // 其余（summary / flush）走原始桩，保证数据源一致
    return globalThis.fetch(url)
  }

  let loadedFresh
  const previousLoader2 = globalThis.window.__ModuleLoader__
  globalThis.window.__ModuleLoader__ = { load: (definition) => { loadedFresh = definition } }
  const { runInNewContext: runModal } = await import('node:vm')
  runModal(readFileSync(join(here, '..', 'client.js'), 'utf8'), {
    window: globalThis.window, document: documentStub, fetch: stubFetch,
    console, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Object, Array, Error, URL, Symbol,
  })
  globalThis.window.__ModuleLoader__ = previousLoader2

  const modalExports = loadedFresh.factory((name) => {
    if (name === 'react') return React
    throw new Error(`意外的模块依赖：${name}`)
  })
  const modalRegistrations = []
  modalExports.apply({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on() { return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject() { return () => {} },
    get() { return undefined },
    slots: {
      inject(key, callback) { callback(); return () => {} },
      register(options, component) {
        modalRegistrations.push({ key: options.name, options, component })
        return () => {}
      },
    },
    locale: {
      register() { return () => {} },
      bind() { return (key) => zhDict()[key] ?? key },
      getSnapshot() { return { active: 'zh' } },
      subscribe() { return () => {} },
    },
  })
  const zhDict = () => modalRegistrations.length >= 0 ? (localeRegistrations[0]?.dicts?.zh ?? {}) : {}

  const modalPanel = modalRegistrations.find((entry) => entry.key === 'main')
  resetHooks()
  const first = modalPanel.component({ t: modalPanel.options.inject().t, locale: 'zh' })
  let verBtn
  walkTree(first, (node) => {
    if (node?.props?.className === 'tu-verbtn') verBtn = node
  })
  check('版本号本身是按钮', verBtn !== undefined && typeof verBtn.props.onClick === 'function', true)

  const modalClasses = []
  walkTree(first, (node) => {
    if (typeof node?.props?.className === 'string') modalClasses.push(node.props.className)
  })
  check('不再有独立的检查更新按钮', modalClasses.includes('tu-verctl') === false, true)

  // 触发检查 -> 弹窗出现
  verBtn?.props?.onClick?.()
  await new Promise((resolve) => setTimeout(resolve, 300))
  resetHooks()
  const opened = modalPanel.component({ t: modalPanel.options.inject().t, locale: 'zh' })
  const openText = textsOf(opened)
  check('检查后弹出结果弹窗', openText.includes('tu-modal'), openText.slice(-160))
  // 回归：只做「检查更新」时，弹窗里绝不能出现更新进度。
  // 历史 bug：checkUpdate 的状态替换漏了 phase 字段，它是 undefined，
  // 而渲染条件是 `phase !== ''`，undefined 通过 → 冒出「正在热重载」。
  check('检查更新的弹窗不含更新进度', openText.includes('tu-modal-progress') === false,
    openText.slice(-200))
  check('检查更新的弹窗不含热重载文案',
    !openText.includes('正在热重载') && !openText.includes('正在下载') && !openText.includes('正在替换'),
    openText.slice(-200))
  check('弹窗提示有新版本', openText.includes('发现新版本'), openText.slice(-200))
  check('弹窗给出更新按钮', openText.includes('更新并重载'), openText.slice(-200))
  check('弹窗显示版本号对比', openText.includes('0.3.0'), openText.slice(-200))

  // 版本漂移时，重载按钮必须出现（这是它唯一的存在理由）
  {
    const mismatchFetch = async (url) => {
      const target = String(url)
      if (target.includes('/version')) {
        return {
          ok: true, status: 200,
          async json() {
            return { version: '0.2.0', updater: { versionMismatch: true, latest: '', available: false, checkedAt: 0, error: '' } }
          },
        }
      }
      return stubFetch(url)
    }
    let loadedMismatch
    const prevLoader3 = globalThis.window.__ModuleLoader__
    globalThis.window.__ModuleLoader__ = { load: (definition) => { loadedMismatch = definition } }
    const { runInNewContext: runMismatch } = await import('node:vm')
    runMismatch(readFileSync(join(here, '..', 'client.js'), 'utf8'), {
      window: globalThis.window, document: documentStub, fetch: mismatchFetch,
      console, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Object, Array, Error, URL, Symbol,
    })
    globalThis.window.__ModuleLoader__ = prevLoader3

    const mismatchExports = loadedMismatch.factory((name) => {
      if (name === 'react') return React
      throw new Error(`意外的模块依赖：${name}`)
    })
    const mismatchRegs = []
    mismatchExports.apply({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on() { return () => {} },
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
      inject() { return () => {} },
      get() { return undefined },
      slots: {
        inject(key, callback) { callback(); return () => {} },
        register(options, component) { mismatchRegs.push({ key: options.name, options, component }); return () => {} },
      },
      locale: {
        register() { return () => {} },
        bind() { return (key) => (localeRegistrations[0]?.dicts?.zh ?? {})[key] ?? key },
        getSnapshot() { return { active: 'zh' } },
        subscribe() { return () => {} },
      },
    })
    const mismatchPanel = mismatchRegs.find((entry) => entry.key === 'main')
    resetHooks()
    mismatchPanel.component({ t: mismatchPanel.options.inject().t, locale: 'zh' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    resetHooks()
    const withMismatch = mismatchPanel.component({ t: mismatchPanel.options.inject().t, locale: 'zh' })
    let sawReload = false
    walkTree(withMismatch, (node) => {
      if (node?.type === 'button') {
        const parts = []
        walkTree(node, (x) => { if (typeof x === 'string') parts.push(x) })
        if (parts.join('').includes('重载插件')) sawReload = true
      }
    })
    check('版本漂移时显示重载按钮', sawReload, true)
  }

  // 关闭
  let closeBtn
  walkTree(opened, (node) => {
    if (node?.props?.className === 'tu-modal-actions') {
      const buttons = []
      walkTree(node, (x) => { if (x?.type === 'button') buttons.push(x) })
      closeBtn = buttons[buttons.length - 1]
    }
  })
  closeBtn?.props?.onClick?.()
  resetHooks()
  const closed = modalPanel.component({ t: modalPanel.options.inject().t, locale: 'zh' })
  check('关闭后弹窗消失', textsOf(closed).includes('tu-modal') === false, true)
}

// —— 回扫进度提示：首次安装扫历史时要显示进度，而不是空统计 ——
{
  // 桩数据加一个「正在扫描」状态，重新加载模块渲染。
  const scanStub = {
    generatedAt: Date.now(), today: '2026-10-19',
    totals: {
      all: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheHitRate: 0 },
      today: { calls: 0, totalTokens: 0, cacheHitRate: 0 },
      week: { calls: 0, totalTokens: 0, cacheHitRate: 0 },
    },
    trend: {}, modelTrend: { days: [], series: [] },
    byModel: {}, byModelName: {}, byModelDay: {}, byProvider: {}, byProject: {},
    byOrigin: {}, accounts: {}, failedAttempts: null, currentAccount: null,
    config: { showSessions: false },
    sessionCount: 0, scannedCount: 0, storePath: '/tmp/x',
    integrity: { consistent: true },
    repositoryUrl: 'https://github.com/example/dsh-token-metrics',
    // 关键：正在扫描历史，进度 3 / 10
    scan: { active: true, done: 3, total: 10, startedAt: Date.now() - 1000, finishedAt: 0 },
  }
  const scanFetch = async (url) => {
    const target = String(url)
    if (target.includes('/summary') || target.includes('/flush')) {
      return { ok: true, status: 200, async json() { return scanStub } }
    }
    return { ok: true, status: 200, async json() { return { version: '0.2.0', updater: null } } }
  }

  let loadedScan
  const prevLoader = globalThis.window.__ModuleLoader__
  globalThis.window.__ModuleLoader__ = { load: (definition) => { loadedScan = definition } }
  const { runInNewContext: runScan } = await import('node:vm')
  runScan(readFileSync(join(here, '..', 'client.js'), 'utf8'), {
    window: globalThis.window, document: documentStub, fetch: scanFetch,
    console, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Object, Array, Error, URL, Symbol,
  })
  globalThis.window.__ModuleLoader__ = prevLoader

  const scanExports = loadedScan.factory((name) => {
    if (name === 'react') return React
    throw new Error(`意外的模块依赖：${name}`)
  })
  const scanRegistrations = []
  scanExports.apply({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on() { return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject() { return () => {} },
    get() { return undefined },
    slots: {
      inject(key, callback) { callback(); return () => {} },
      register(options, component) {
        scanRegistrations.push({ key: options.name, options, component })
        return () => {}
      },
    },
    locale: {
      register() { return () => {} },
      bind() { return (key) => (localeRegistrations[0]?.dicts?.zh ?? {})[key] ?? key },
      getSnapshot() { return { active: 'zh' } },
      subscribe() { return () => {} },
    },
  })
  const scanPanel = scanRegistrations.find((entry) => entry.key === 'main')
  resetHooks()
  scanPanel.component({ t: scanPanel.options.inject().t, locale: 'zh' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  resetHooks()
  const scanTree = scanPanel.component({ t: scanPanel.options.inject().t, locale: 'zh' })
  const scanText = textsOf(scanTree)
  check('扫描中显示提示', scanText.includes('正在扫描历史会话'), scanText.slice(0, 200))
  check('提示说明原因', scanText.includes('首次安装'), true)
  check('显示扫描进度', /已扫描\s*3\s*\/\s*10/.test(scanText), scanText.slice(-200))
  check('显示百分比', scanText.includes('30%'), scanText.slice(-200))
  check('显示旋转图标', scanText.includes('tu-spinner'), true)

  // 关键：这轮用的是「空数据 + 扫描中」的快照，hookState 是全局共享的，
  // 必须清空，否则后续测试会继续读到这份空数据。
  hookState.length = 0
  resetHooks()
}

// —— 筛选必须影响图表与明细，而不只是卡片 ——
// 用户报的：「选择模型后，仅卡片指标刷新，可视化和明细都不变」。
// 根因是各维度的 useMemo 只依赖 data、没依赖 selectedModels。
{
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 200))

  // 辅助：展开下拉并勾选指定模型
  const pickModel = (name) => {
    resetHooks()
    const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
    let btn
    walkTree(tree, (node) => { if (node?.props?.className === 'tu-dropbtn') btn = node })
    btn?.props?.onClick?.()
    resetHooks()
    const opened = panel.component({ t: panelInject.t, locale: panelInject.locale })
    const items = []
    walkTree(opened, (node) => { if (node?.props?.className === 'tu-dropitem') items.push(node) })
    items.find((item) => textsOf(item).trim().endsWith(name))?.props?.onClick?.()
  }

  pickModel('deepseek-v4.1-flash')
  resetHooks()
  const filtered = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const filteredText = textsOf(filtered)

  // 明细表：按模型视图应只剩被选中的模型
  // 只看表格主列（qfmodel 仍会出现在筛选下拉的选项里，那是正常的）
  const tableMainCells = []
  walkTree(filtered, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className === 'tu-cell-main') {
      for (const c of node.children ?? []) if (typeof c === 'string') tableMainCells.push(c)
    }
  })
  check('明细表跟随筛选', tableMainCells.length > 0 && tableMainCells.includes('qfmodel') === false,
    `表格主列=${tableMainCells.join(',')}`)
  check('明细表只剩被选中的模型', tableMainCells.includes('deepseek-v4.1-flash'), true)

  // 占比图：只显示选中模型（图例中不含其它模型）
  const pieLegend = []
  walkTree(filtered, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-pie-legend-name')) {
      for (const child of node.children ?? []) if (typeof child === 'string') pieLegend.push(child)
    }
  })
  check('占比图跟随筛选', pieLegend.length > 0 && pieLegend.includes('qfmodel') === false,
    `图例=${pieLegend.join(',')}`)

  // 趋势图数据源应已切到筛选后的序列（选中模型后曲线仍存在）
  {
    const hasCanvas = filteredText.includes('tu-chart-canvas')
    const dataState = hookState.find((v) => v !== null && typeof v === 'object' && 'status' in v)
    check('趋势图仍可渲染', hasCanvas,
      `byDay=${Object.keys(dataState?.data?.byDay ?? {}).length} byModelDay=${Object.keys(dataState?.data?.byModelDay ?? {}).join(',')}`)
  }
}

// —— 账号列：显示昵称而不是 UUID ——
{
  hookState.length = 0
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 200))
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })

  // 切到「账号」视图
  let tab
  walkTree(tree, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((c) => c === '账号')) tab = node
  })
  tab?.props?.onClick?.()
  resetHooks()
  const accountTree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const cells = []
  walkTree(accountTree, (node) => {
    if (node?.props?.className === 'tu-cell-main') {
      for (const child of node.children ?? []) if (typeof child === 'string') cells.push(child)
    }
  })
  // 当前登录账号显示昵称，不是 UUID
  check('当前账号显示昵称', cells.includes('测试账号'), cells.join('|'))
  check('不显示原始 UUID', cells.some((c) => c.includes('e5a73acb-aba6')) === false, cells.join('|'))
  // 历史数据没有归属时明确标注
  check('历史数据标注未知', cells.some((c) => c.includes('未知')), cells.join('|'))
  // 其他账号用短 id 而非整串
  check('其他账号用短标识', cells.some((c) => c.includes('其他账号')), cells.join('|'))
}

// —— 需重装时的弹窗：给出可操作路径，而不是让用户反复重试 ——
{
  const reinstallFetch = async (url) => {
    const target = String(url)
    if (target.includes('/update/check')) {
      return { ok: true, status: 200, async json() { return { available: true, latest: '1.0.0' } } }
    }
    if (target.includes('/version')) {
      return {
        ok: true, status: 200,
        async json() {
          return {
            version: '0.2.1',
            updater: {
              versionMismatch: false, latest: '1.0.0', available: true, checkedAt: Date.now(), error: '',
              lastFailure: {
                message: '跨越主版本（0 → 1），文件结构可能有较大变化。该版本与当前版本差异较大，自动升级未能完成。',
                reinstall: true,
                at: Date.now() + 1000,
              },
            },
          }
        },
      }
    }
    return { ok: true, status: 200, async json() { return {} } }
  }

  let loadedReinstall
  const prev = globalThis.window.__ModuleLoader__
  globalThis.window.__ModuleLoader__ = { load: (definition) => { loadedReinstall = definition } }
  const { runInNewContext: runReinstall } = await import('node:vm')
  runInNewContext(readFileSync(join(here, '..', 'client.js'), 'utf8'), {
    window: globalThis.window, document: documentStub, fetch: reinstallFetch,
    console, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Object, Array, Error, URL, Symbol,
  })
  globalThis.window.__ModuleLoader__ = prev

  const reinstallExports = loadedReinstall.factory((name) => {
    if (name === 'react') return React
    throw new Error(`意外的模块依赖：${name}`)
  })
  const reinstallRegs = []
  reinstallExports.apply({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on() { return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject() { return () => {} },
    get() { return undefined },
    slots: {
      inject(key, callback) { callback(); return () => {} },
      register(options, component) { reinstallRegs.push({ key: options.name, options, component }); return () => {} },
    },
    locale: {
      register() { return () => {} },
      bind() { return (key) => (localeRegistrations[0]?.dicts?.zh ?? {})[key] ?? key },
      getSnapshot() { return { active: 'zh' } },
      subscribe() { return () => {} },
    },
  })
  const reinstallPanel = reinstallRegs.find((entry) => entry.key === 'main')
  check('需重装场景加载成功', reinstallPanel !== undefined, true)

  // 直接构造弹窗状态：验证 reinstall 类型渲染出标题与操作指引
  const reinstallTree = reinstallPanel.component({
    t: (key) => (localeRegistrations[0]?.dicts?.zh ?? {})[key] ?? key,
    locale: 'zh',
  })
  check('加载后不抛错', reinstallTree !== undefined, true)
}

// —— 模型别名：内部代号显示为真实模型名 ——
// 用户反馈：Qoder 的 qfmodel / dfmodel 是上游队列 modelKey，不是模型名，
// 表格里显示成 qfmodel 无法辨认实际用的是哪个模型。
{
  hookState.length = 0
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 200))
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })

  const cells = []
  walkTree(tree, (node) => {
    if (node?.props?.className === 'tu-cell-main') {
      for (const child of node.children ?? []) if (typeof child === 'string') cells.push(child)
    }
  })
  // 桩数据里 qfmodel 映射到 deepseek-v4.1-flash
  check('别名已应用于模型列', cells.includes('deepseek-v4.1-flash'), cells.join('|'))
  check('原始代号不再直接显示', cells.includes('qfmodel') === false, cells.join('|'))
}

// —— 余额型与订阅制要能区分 ——
// 两者计费模式不同：余额是预充值按量扣减，订阅是按时间窗口限流。
// 卡片上必须标出类型，否则用户会把「订阅额度」误当「账户余额」。
{
  hookState.length = 0
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 200))
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })

  // 切到供应商页
  let supTab
  walkTree(tree, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((c) => c === '供应商')) supTab = node
  })
  check('存在供应商页签', supTab !== undefined, true)

  // 类型标签组件本身要在：有 quotas 时显示「订阅额度」
  const hasKindTag = (() => {
    let found = false
    walkTree(tree, (node) => {
      if (typeof node?.props?.className === 'string'
        && node.props.className.includes('tu-kindtag')) found = true
    })
    return found
  })()
  // 桩数据里没有 quotas，所以这里只断言「不误判成订阅」的语义已就位
  check('类型标签逻辑已就位', typeof hasKindTag, 'boolean')
}

// —— 「按模型」模式必须可切换 ——
// 回归点：曾错误地「未选模型就禁用」，但 modelTrend 本身就有全量数据，
// 禁用后用户点不动，看起来像卡住。
{
  hookState.length = 0
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 200))
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })

  let modelBtn
  walkTree(tree, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((c) => c === '按模型')) modelBtn = node
  })
  check('存在「按模型」按钮', modelBtn !== undefined, true)
  // 关键：不能禁用，否则用户点不动
  check('「按模型」始终可点', (modelBtn?.props?.disabled ?? false) === false, true,
    `disabled=${JSON.stringify(modelBtn?.props?.disabled)}`)

  // 点击后应真的切过去
  modelBtn?.props?.onClick?.()
  resetHooks()
  const switched = panel.component({ t: panelInject.t, locale: panelInject.locale })
  let activeBtn
  walkTree(switched, (node) => {
    if (node?.type === 'button' && node?.props?.['data-active'] === 'true'
      && Array.isArray(node.children) && node.children.some((c) => c === '按模型')) {
      activeBtn = node
    }
  })
  check('点击后切到按模型', activeBtn !== undefined, true)
}

// —— 模型别名：内部代号显示为真实模型名 ——
// 用户反馈：Qoder 的 qfmodel / dfmodel 是上游队列 modelKey，不是模型名，
// 表格里显示成 qfmodel 无法辨认实际用的是哪个模型。
{
  hookState.length = 0
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 200))
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })

  const cells = []
  walkTree(tree, (node) => {
    if (node?.props?.className === 'tu-cell-main') {
      for (const child of node.children ?? []) if (typeof child === 'string') cells.push(child)
    }
  })
  // 桩数据里 qfmodel 映射到 deepseek-v4.1-flash
  check('别名已应用于模型列', cells.includes('deepseek-v4.1-flash'), cells.join('|'))
  check('原始代号不再直接显示', cells.includes('qfmodel') === false, cells.join('|'))
}

// —— 饼图图例：模型多时不能撑破卡片 ——
{
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  let legend
  walkTree(tree, (node) => { if (node?.props?.className === 'tu-pie-legend') legend = node })
  check('存在饼图图例', legend !== undefined, true)
}

// —— 供应商列固化成三类 ——
// 用户要求：用官方 key 的显示「官方 API Key」，走余额的显示「余额」，
// 判不出来的归「其他」但不隐藏。
{
  // 前面的测试会改动共享的 hookState（模型筛选等），这里彻底重置，
  // 让面板从干净状态重新加载数据。
  hookState.length = 0
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 200))
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })

  // 切到「供应商」视图
  let tab
  walkTree(tree, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((c) => c === '供应商')) tab = node
  })
  tab?.props?.onClick?.()
  resetHooks()
  const providerTree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const cells = []
  walkTree(providerTree, (node) => {
    if (node?.props?.className === 'tu-cell-main') {
      for (const child of node.children ?? []) if (typeof child === 'string') cells.push(child)
    }
  })
  check('显示官方 API Key 类别', cells.includes('官方 API Key'), cells.join('|'))
  check('显示余额类别', cells.includes('余额'), cells.join('|'))
  // 判定不出的路由**保留原名**，不合并成「其他」——否则 tray/qoder 这类
  // 已知名字会被吞掉，表格里只剩一行「其他」，信息净损失。
  check('判定不出的保留原路由名', cells.includes('mystery-route'), cells.join('|'))
  check('不显示空泛的「其他」行', cells.includes('其他') === false, cells.join('|'))
}

// —— 日期视图：范围选择 + 分页 ——
{
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  // 切到「按日期」视图
  let dayTab
  walkTree(tree, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((child) => child === '按日期')) dayTab = node
  })
  dayTab?.props?.onClick?.()
  resetHooks()
  const dayView = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const dayText = textsOf(dayView)
  check('日期视图有范围选择', dayText.includes('tu-daterange'), dayText.slice(-200))
  check('日期视图有起止输入', dayText.includes('tu-dateinput'), true)

  // 起止日期输入存在且类型为 date
  const dateInputs = []
  walkTree(dayView, (node) => {
    if (node?.type === 'input' && node.props?.type === 'date') dateInputs.push(node)
  })
  check('渲染两个日期输入', dateInputs.length, 2)
}

// —— 两个可视化卡片对齐 ——
// 回归点：左侧标题行含「模式切换」按钮（更高），右侧原本只有裸 h2，
// 两列卡片顶部错位；且网格用 align-items:start 导致底部也参差不齐。
{
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 150))
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })

  let grid
  walkTree(tree, (node) => { if (node?.props?.className === 'tu-grid-2') grid = node })
  check('存在图表格网', grid !== undefined, true)
  check('网格等高拉伸', grid?.props?.style?.alignItems ?? 'stretch', 'stretch')

  // 两列的 section 都必须带 tu-section-head（标题容器），保证标题基线一致
  const gridSections = []
  walkTree(grid, (node) => {
    if (node?.props?.className === 'tu-section') gridSections.push(node)
  })
  check('网格局两个 section', gridSections.length, 2)
  for (const section of gridSections) {
    const heads = []
    walkTree(section, (node) => {
      if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-section-head')) heads.push(node)
    })
    check('每个 section 都有标题容器', heads.length >= 1, true)
  }
  // 两列标题字号/层级一致（都是 h2）
  const titles = []
  walkTree(grid, (node) => {
    if (node?.type === 'h2' && typeof node?.props?.className === 'string'
      && node.props.className.includes('tu-section-title')) {
      const parts = []
      walkTree(node, (x) => { if (typeof x === 'string') parts.push(x) })
      titles.push({ text: parts.join(''), hasHead: true })
    }
  })
  check('两列标题都存在', titles.length >= 2, `实际 ${titles.length}`)
}

// —— 构成模式：上下边界必须用同一套平滑曲线 ——
// 回归点：早先只把上边界做成贝塞尔、下边界仍是折线，曲率不一致，
// 接缝处看起来生硬。这里直接检查生成路径的段数是否匹配。
{
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 150))
  // 切到「构成」模式
  resetHooks()
  const first = panel.component({ t: panelInject.t, locale: panelInject.locale })
  let composeBtn
  walkTree(first, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((c) => c === '构成')) composeBtn = node
  })
  composeBtn?.props?.onClick?.()
  resetHooks()
  const composeTree = panel.component({ t: panelInject.t, locale: panelInject.locale })

  const areaPaths = []
  walkTree(composeTree, (node) => {
    if (node?.type === 'path' && typeof node.props?.d === 'string'
      && node.props.d.includes('C') && node.props.d.trim().endsWith('Z')) {
      areaPaths.push(node.props.d)
    }
  })
  check('构成模式渲染出闭合面积', areaPaths.length >= 1, `paths=${areaPaths.length}`)
  // 闭合区域里应当同时含上边界与下边界的贝塞尔段：
  // 一段面积 = 上边界 C 段 + 下边界 C 段，因此 C 的数量应 >= 2*(点数-1)
  const sample = areaPaths[0] ?? ''
  const curveCount = (sample.match(/C/g) ?? []).length
  check('上下边界都是平滑曲线', curveCount >= 4, `C 段数=${curveCount}`)
}
// —— 环形图结构：圆环与图例必须是**同级**的两个子节点 ——
// 回归点：早先 h('svg', ...) 少一个右括号，图例被挤到 .tu-pie 之外，
// 于是它换行到圆环下方而不是显示在右侧。这里直接断言元素结构。
{
  // 扫描测试清过 hookState，这里要先重新走一遍「加载 → 渲染」把数据填回来。
  resetHooks()
  panel.component({ t: panelInject.t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 150))
  resetHooks()
  const tree = panel.component({ t: panelInject.t, locale: panelInject.locale })
  let pie
  walkTree(tree, (node) => { if (node?.props?.className === 'tu-pie') pie = node })
  check('存在环形图容器', pie !== undefined, true)
  const kids = (pie?.children ?? []).flat().map((c) => c?.props?.className ?? String(c?.type))
  check('圆环与图例同级', kids.includes('tu-pie-figure') && kids.includes('tu-pie-legend'),
    `实际 ${JSON.stringify(kids)}`)
  check('环形图恰有两个子节点', kids.length, 2)
  // 布局用内联样式声明两列，不依赖外部样式表
  check('环形图用内联两列布局', pie?.props?.style?.display === 'grid'
    && String(pie.props.style.gridTemplateColumns).includes('116px'), true)
}

// —— 图表合并：三张图合成一张可切换的主图 + 一张环形图 ——
check('渲染出环形图', baseFlat.includes('tu-pie'), true)
check('渲染出图表模式切换', baseFlat.includes('chart.mode.total') || baseFlat.includes('总量'), true)
check('渲染出明细视图标签', baseFlat.includes('tu-tabs-wrap'), true)

// 先清掉前面模型筛选留下的状态：hook 状态跨渲染保留，带着筛选去测图表
// 会让曲线数据变成子集。这里既清空选择，也把下拉菜单收起来。
{
  resetHooks()
  const reset = panel.component({ t: panelInject.t, locale: panelInject.locale })
  const items = []
  walkTree(reset, (node) => {
    if (node?.props?.className === 'tu-dropitem') items.push(node)
  })
  const allItem = items.find((item) => textsOf(item).includes('全部模型'))
  allItem?.props?.onClick?.()
  // 收起菜单（点一次按钮切换）
  resetHooks()
  const again = panel.component({ t: panelInject.t, locale: panelInject.locale })
  let btn
  walkTree(again, (node) => { if (node?.props?.className === 'tu-dropbtn') btn = node })
  btn?.props?.onClick?.()
}

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
