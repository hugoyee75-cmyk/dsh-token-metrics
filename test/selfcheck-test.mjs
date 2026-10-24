/**
 * 接口自检的自检。
 *
 * 背景：插件依赖 DSH 的 session/event、llm/stream、sessionPersistence。
 * DSH 升级时这些接口可能静默失效（插件照常启动，只是数据不再增长），
 * 用户很久才发现。runSelfCheck 把这些契约变成可观测的检查项。
 */

import { runSelfCheck } from '../src/selfcheck.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const failures = []
function check(label, condition, detail) {
  if (!condition) failures.push(`${label}${detail ? `：${detail}` : ''}`)
}

const NOW = 1_800_000_000_000
const baseStore = {
  total: { calls: 100 },
  seen: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 1])),
  performance: { total: { ttftCount: 50 } },
}

// —— 全绿场景 ——
{
  const r = runSelfCheck({
    env: {
      hasSessionPersistence: true, persistenceSource: 'inject',
      startedAt: NOW - 3_600_000, store: baseStore, now: NOW,
    },
  })
  check('全部正常时 ok 为 true', r.ok === true)
  check('无失败项', r.failed === 0, `实际 ${r.failed}`)
  check('无警告项', r.warned === 0, `实际 ${r.warned}`)
  check('检查项齐全', r.items.length >= 4, `实际 ${r.items.length}`)
}

// —— sessionPersistence 不可用：应为 warn 而非 fail ——
// 有磁盘直读兜底，所以不该判成致命失败
{
  const r = runSelfCheck({
    env: {
      hasSessionPersistence: false, startedAt: NOW - 3_600_000,
      store: baseStore, now: NOW,
    },
  })
  const item = r.items.find((i) => i.id === 'sessionPersistence')
  check('persistence 缺失判为 warn', item?.level === 'warn', `实际 ${item?.level}`)
  check('persistence 缺失仍 ok', r.ok === true)
  check('提示里说明有兜底', String(item?.detail).includes('兜底'), item?.detail)
}

// —— 磁盘兜底：属设计内正常路径，不应报警 ——
// 实测踩过一次：热重载后 persistenceState 没被赋值，自检误报
// 「历史会话服务不可用」，实际磁盘兜底一直正常工作。
{
  const r = runSelfCheck({
    env: {
      hasSessionPersistence: false, persistenceSource: 'disk-fallback',
      startedAt: NOW - 3_600_000, store: baseStore, now: NOW,
    },
  })
  const item = r.items.find((i) => i.id === 'sessionPersistence')
  check('磁盘兜底判为 ok', item?.level === 'ok', `实际 ${item?.level}`)
  check('磁盘兜底不产生警告', r.warned === 0, `实际 ${r.warned}`)
  check('说明功能不受影响', String(item?.detail).includes('不受影响'), item?.detail)
}

// —— 刚启动、尚无调用：不应误报 ——
// 这是最容易误报的场景：启动 10 秒就判「事件失效」会吓到用户
{
  const r = runSelfCheck({
    env: {
      hasSessionPersistence: true, startedAt: NOW - 10_000,
      store: { total: { calls: 0 }, seen: {}, performance: { total: { ttftCount: 0 } } },
      now: NOW,
    },
  })
  const ev = r.items.find((i) => i.id === 'session/event')
  const llm = r.items.find((i) => i.id === 'llm/stream')
  check('刚启动不误报 session/event', ev?.level === 'ok', `实际 ${ev?.level}`)
  check('刚启动不误报 llm/stream', llm?.level === 'ok', `实际 ${llm?.level}`)
}

// —— 运行很久仍无数据：应升级为 warn ——
{
  const r = runSelfCheck({
    env: {
      hasSessionPersistence: true, startedAt: NOW - 3_600_000,
      store: { total: { calls: 0 }, seen: {}, performance: { total: { ttftCount: 0 } } },
      now: NOW,
    },
  })
  const ev = r.items.find((i) => i.id === 'session/event')
  const llm = r.items.find((i) => i.id === 'llm/stream')
  check('久无调用提示事件可能失效', ev?.level === 'warn', `实际 ${ev?.level}`)
  check('久无采样提示接口可能变了', llm?.level === 'warn', `实际 ${llm?.level}`)
}

// —— 数据不一致：应为 fail ——
{
  const r = runSelfCheck({
    env: {
      hasSessionPersistence: true, startedAt: NOW - 3_600_000,
      store: {
        total: { calls: 100 },
        seen: { k1: 1, k2: 1 },        // 只有 2 个键，与 100 不符
        performance: { total: { ttftCount: 50 } },
      },
      now: NOW,
    },
  })
  const item = r.items.find((i) => i.id === 'integrity')
  check('数据不一致判为 fail', item?.level === 'fail', `实际 ${item?.level}`)
  check('不一致时 ok 为 false', r.ok === false)
}

// —— 边界：空输入不抛错 ——
{
  let threw = false
  try { runSelfCheck(undefined) } catch { threw = true }
  check('空输入不抛错', threw === false)
}

// —— 自动回滚：自检不通过时必须触发回滚 ——
// 这不是自检模块内部的逻辑，而是「activate 返回 ok:false -> updater 回滚」
// 这条链路。用静态检查确认链路没有被改断（运行时行为由 update-test 覆盖）。
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')
  const updaterSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'updater.js'), 'utf8')

  // activate 里：重载成功后才自检，自检失败返回 ok:false
  check('activate 会跑更新后自检', src.includes('probeAfterUpdate(ctx, logger)'), true)
  check('自检失败时返回 ok:false',
    src.includes('新版本激活后自检未通过') && src.includes('ok: false'), true)

  // updater 里：activate 返回非 ok 就回滚
  check('updater 在 activate 失败时回滚',
    updaterSrc.includes('result?.ok !== true') && updaterSrc.includes('restoreBackup(this.backupDir'), true)
}

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 接口自检全部断言通过')
console.log('  全绿 / 服务缺失 / 刚启动不误报 / 久无数据预警 / 数据不一致')
