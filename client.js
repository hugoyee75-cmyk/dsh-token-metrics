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
      'field.input': '输入',
      'field.output': '输出',
      'field.cacheRead': '缓存读',
      'field.cacheWrite': '缓存写',
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
      'chart.mode.compose': '构成',
      'chart.mode.model': '按模型',
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
      'field.input': 'Input',
      'field.output': 'Output',
      'field.cacheRead': 'Cache read',
      'field.cacheWrite': 'Cache write',
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
      'chart.mode.compose': 'Composition',
      'chart.mode.model': 'By model',
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
[data-theme='dark'] .tu-root {
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
  align-items: center;
  gap: 16px;
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
    function MetricCard({ label, value, accent, rate, suffix }) {
      const text = suffix === undefined ? formatCompact(value) : `${value}${suffix}`
      return h('div', {
        className: 'tu-card',
        'data-accent': accent === true ? 'true' : 'false',
        'data-rate': rate === true ? 'true' : 'false',
      },
      h('div', { className: 'tu-card-label' }, label),
      h('div', { className: 'tu-card-value', title: formatNumber(value) }, text),
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
        mode === 'cache' ? point.rate * 100 : point.total
      ))
      const max = Math.max(...rawValues, 1)
      const formatValue = mode === 'cache'
        ? (value) => `${value.toFixed(1)}%`
        : formatCompact

      const coords = rawValues.map((value, index) => ({
        x: toX(index), y: toY(value, max), value, point: points[index],
      }))
      const path = smoothPath(coords)
      const area = `${path} L${coords[coords.length - 1].x.toFixed(2)},${baseY.toFixed(2)}`
        + ` L${coords[0].x.toFixed(2)},${baseY.toFixed(2)} Z`
      const stroke = mode === 'cache' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-brand-primary)'
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
      const facetOf = useCallback((facetKey) => {
        if (data === undefined) return {}
        if (selectedModels.length === 0) {
          // 全局视图：直接用 host 的 byXxx 桶，避免重复求和。
          const map = {
            provider: data.byProvider,
            project: data.byProject,
            origin: data.byOrigin,
            account: data.accounts,
            day: data.byDay,
          }
          return map[facetKey] ?? {}
        }
        // 筛选视图：把选中模型的该维度桶逐个相加。
        const merged = {}
        for (const name of selectedModels) {
          const facets = data.byModelFacets?.[name]?.[facetKey]
          if (facets === undefined) continue
          for (const [key, counters] of Object.entries(facets)) {
            const target = merged[key] ?? (merged[key] = {
              calls: 0, inputTokens: 0, outputTokens: 0,
              cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
            })
            for (const field of Object.keys(target)) {
              target[field] += counters[field] ?? 0
            }
          }
        }
        return merged
      }, [data, selectedModels])

      const modelRows = useMemo(() => {
        if (data === undefined) return []
        return Object.entries(data.byModel ?? {})
          .map(([key, counters]) => {
            const slash = key.indexOf('/')
            return {
              key,
              model: slash === -1 ? key : key.slice(slash + 1),
              provider: slash === -1 ? '—' : key.slice(0, slash),
              calls: formatNumber(counters.calls),
              input: formatNumber(counters.inputTokens),
              output: formatNumber(counters.outputTokens),
              cacheRead: formatNumber(counters.cacheReadTokens),
              reasoning: formatNumber(counters.reasoningTokens),
              // 命中率由 Host 统一算好；没有就用本地兜底，保证列不空。
              hitRate: `${Math.round((counters.cacheHitRate ?? hitRateOf(counters)) * 100)}%`,
              total: formatNumber(counters.totalTokens),
              sortKey: counters.totalTokens ?? 0,
            }
          })
          .sort((a, b) => b.sortKey - a.sortKey)
      }, [data])

      const providerRows = useMemo(() => {
        if (data === undefined) return []
        // 供应商列固化成三类：官方 API Key / 余额 / 其他。
        // 同类别的多个路由合并成一行——用户要的是「两类」，
        // 不是逐个中转站。具体路由名放 tooltip，信息不丢。
        const kinds = data?.providerKinds ?? {}
        const merged = new Map()
        for (const [name, counters] of Object.entries(facetOf('provider'))) {
          const kind = kinds[name] ?? 'unknown'
          const existing = merged.get(kind) ?? {
            key: kind,
            kind,
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
          merged.set(kind, existing)
        }
        return [...merged.values()]
          .map((row) => ({
            key: row.kind,
            provider: t(`providerKind.${row.kind}`),
            routeHint: row.routes.join(', '),
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
        return Object.values(data.bySession ?? {})
          .map((entry) => ({
            key: entry.id,
            session: entry.title || t('noTitle'),
            provider: entry.provider ?? '—',
            model: entry.model ?? '—',
            lastUsed: formatTime(entry.lastAt, locale),
            total: formatNumber(entry.counters?.totalTokens ?? 0),
            sortKey: entry.lastAt ?? 0,
          }))
          .sort((a, b) => b.sortKey - a.sortKey)
          .slice(0, 200)
      }, [data, locale, t])


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
        return Object.entries(facetOf('account'))
          .map(([id, entry]) => ({
            key: id,
            account: id === 'unknown' ? t('account.unknown') : id,
            calls: formatNumber(entry.calls ?? 0),
            input: formatNumber(entry.inputTokens ?? 0),
            output: formatNumber(entry.outputTokens ?? 0),
            total: formatNumber(entry.totalTokens ?? 0),
            firstSeen: formatTime(entry.firstAt, locale),
            sortKey: entry.totalTokens ?? 0,
          }))
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
        const source = data.byModelName ?? {}
        const entries = Object.entries(source)
          .map(([key, counters]) => ({ key, value: counters.totalTokens ?? 0 }))
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
      }, [data, t, selectedModels])

      // 图表数据：按天升序。trend 由 Host 预先算好命中率，这里只做投影。
      const trendSeries = useMemo(() => {
        // 选中模型时，趋势图换成所选模型的合并曲线。
        if (selectedModels.length > 0) {
          return Object.keys(data?.byDay ?? {})
            .sort()
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
        return Object.entries(data.trend)
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([day, counters]) => ({
            label: day.slice(5),
            total: counters.totalTokens ?? 0,
            // 悬停提示要显示当天调用次数，缺了它会恒显示 0。
            calls: counters.calls ?? 0,
            input: counters.inputTokens ?? 0,
            cacheRead: counters.cacheReadTokens ?? 0,
            output: counters.outputTokens ?? 0,
            rate: counters.cacheHitRate ?? 0,
          }))
      }, [data, selectedModels])

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

      const cards = h('div', { className: 'tu-cards' },
        h(MetricCard, { label: t('field.total'), value: totals?.totalTokens ?? 0, accent: true }),
        h(MetricCard, {
          label: t('field.cacheHitRate'),
          value: Math.round((totals?.cacheHitRate ?? 0) * 100),
          rate: true,
          suffix: '%',
        }),
        h(MetricCard, { label: t('field.input'), value: totals?.inputTokens ?? 0 }),
        h(MetricCard, { label: t('field.output'), value: totals?.outputTokens ?? 0 }),
        h(MetricCard, { label: t('field.cacheRead'), value: totals?.cacheReadTokens ?? 0 }),
        h(MetricCard, { label: t('field.cacheWrite'), value: totals?.cacheWriteTokens ?? 0 }),
        h(MetricCard, { label: t('field.reasoning'), value: totals?.reasoningTokens ?? 0 }),
        h(MetricCard, { label: t('field.calls'), value: totals?.calls ?? 0 }),
      )

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
              `${t('account.balance')} ${wallet.balance} ${wallet.currency}`)),
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
                }, t(option.labelKey)),
                ),
              ),
            ),
            h(TrendChart, {
              points: trendSeries,
              mode: chartMode,
              t,
              modelTrend: data?.modelTrend,
            }),
          ),
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
      h('div', { className: 'tu-modal-title' }, t('version.checkTitle')),
      h('div', { className: 'tu-modal-body' },
        versionDialog.kind === 'new'
          ? `${t('version.newBody')}（${pluginVersion} → ${versionDialog.latest}）`
          : versionDialog.kind === 'success'
            ? `${t('version.success')}：${t('version.successBody')} ${versionDialog.latest}`
            : versionDialog.kind === 'same'
              ? `${t('version.sameBody')}（${pluginVersion}）`
              : `${t('version.checkFailed')}：${versionDialog.message}`),
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
        }, versionDialog.kind === 'new' ? t('version.dialogLater') : t('version.dialogOk')),
        ),
      ))

      // 页脚只保留更新时间，并靠右下角。回扫会话数与数据文件路径是排障信息，
      // 放在主界面上属于噪音（而且「已回扫 26 / 21」这种比值本身会让人困惑）。
      const note = h('div', { className: 'tu-note' },
        h('span', null, `${t('updatedAt')} ${formatTime(data?.generatedAt, locale)}`),
      )

      return h('div', { className: 'tu-root' },
        head, scanBar, tabs, accountBar, cards, charts, sections, warn, note, versionModal)
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

    function apply(ctx) {
      // 每个注册都独立兜底：一处失败不应该让整块 UI 消失。
      ctx.effect(() => insertStyles(), 'token-metrics: 样式')

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
