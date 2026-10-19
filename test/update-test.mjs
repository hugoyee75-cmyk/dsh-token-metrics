/**
 * 自更新与热重载的单元测试。
 *
 * 这两块逻辑最容易出「静默失败」——回滚没回滚、版本比对形同虚设、
 * 路径穿越被放过。所以这里逐项验证行为，而不只是「跑起来没报错」。
 *
 * 运行：node test/update-test.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  PluginUpdater, backupPackage, compareVersions, extractTarGz,
  installStaged, listPackageFiles, parseRepository, parseVersion, restoreBackup,
} from '../src/updater.js'
import { isReloading, packageCacheKeys, packageUrlOf, entryUrlOf } from '../src/reload.js'

const failures = []
function check(label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

//#region 版本比较

check('解析基本版本', JSON.stringify(parseVersion('1.2.3')), JSON.stringify({ major: 1, minor: 2, patch: 3, pre: null }))
check('拒绝非法版本', parseVersion('abc'), null)
check('拒绝两段版本', parseVersion('1.2'), null)
check('预发布解析', JSON.stringify(parseVersion('1.2.3-rc.1').pre), JSON.stringify(['rc', '1']))
check('补丁位递增', compareVersions('1.0.0', '1.0.1'), -1)
check('次版本位递增', compareVersions('1.1.0', '1.0.9'), 1)
check('相等', compareVersions('1.0.0', '1.0.0'), 0)
check('预发布早于正式版', compareVersions('1.0.0-rc.1', '1.0.0'), -1)
check('rc.1 早于 rc.2', compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
check('正式版晚于预发布', compareVersions('2.0.0', '1.9.9-rc.9'), 1)

//#endregion

//#region repository 解析

check('github 短写法', JSON.stringify(parseRepository('github:foo/bar')), JSON.stringify({ owner: 'foo', repo: 'bar' }))
check('git+https 写法', JSON.stringify(parseRepository('git+https://github.com/foo/bar.git')), JSON.stringify({ owner: 'foo', repo: 'bar' }))
check('纯 URL 写法', JSON.stringify(parseRepository('https://github.com/a/b')), JSON.stringify({ owner: 'a', repo: 'b' }))
check('对象形式', JSON.stringify(parseRepository({ url: 'https://github.com/a/b.git' })), JSON.stringify({ owner: 'a', repo: 'b' }))
check('非 github 返回 null', parseRepository('https://gitlab.com/a/b'), null)
check('空值返回 null', parseRepository(''), null)

//#endregion

//#region tar 解压（含安全检查）

/** 构造一个最小 tar 包，用来验证解析器。 */
function makeTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    const name = entry.name
    header.write(name, 0, 100, 'utf8')
    header.write('0000644', 100, 8, 'utf8')
    header.write('0000000', 108, 8, 'utf8')
    header.write('0000000', 116, 8, 'utf8')
    header.write(`${entry.content.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
    header.write('00000000000 ', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write(entry.type ?? '0', 156, 1, 'utf8')
    header.write('ustar  ', 257, 8, 'utf8')
    // 校验和
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')} `, 148, 8, 'utf8')
    blocks.push(header, Buffer.from(entry.content))
    const padding = (512 - (entry.content.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(512 * 2))
  return gzipSync(Buffer.concat(blocks))
}

const tarHome = mkdtempSync(join(tmpdir(), 'dtu-tar-'))
const archive = makeTar([
  { name: 'dsh-token-usage-1.0.0/', content: '', type: '5' },
  { name: 'dsh-token-usage-1.0.0/index.js', content: 'export const version = "1.0.0"' },
  { name: 'dsh-token-usage-1.0.0/package.json', content: '{"version":"1.0.0"}' },
  { name: 'dsh-token-usage-1.0.0/locale/zh.json', content: '{}' },
  { name: 'dsh-token-usage-1.0.0/../../../etc/evil', content: 'pwned' },
])
const extracted = await extractTarGz(archive, join(tarHome, 'stage'), 'dsh-token-usage-1.0.0')
check('解压出文件', extracted.includes('index.js'), true)
check('解压出子目录文件', extracted.includes('locale/zh.json'), true)
check('拒绝路径穿越', extracted.some((f) => f.includes('..')), false)
check('路径穿越文件未落盘', existsSync(join(tarHome, 'stage', '..', '..', '..', 'etc', 'evil')), false)
check('解压内容正确', readFileSync(join(tarHome, 'stage', 'index.js'), 'utf8'), 'export const version = "1.0.0"')
check('剥离了顶层目录', existsSync(join(tarHome, 'stage', 'package.json')), true)

// 越界路径不得写到 targetDir 之外
check('未写到父目录', existsSync(join(tarHome, 'etc')), false)
rmSync(tarHome, { recursive: true, force: true })

//#endregion

//#region 备份与回滚

const backupHome = mkdtempSync(join(tmpdir(), 'dtu-backup-'))
const pkgDir = join(backupHome, 'pkg')
mkdirSync(join(pkgDir, 'locale'), { recursive: true })
writeFileSync(join(pkgDir, 'index.js'), 'OLD')
writeFileSync(join(pkgDir, 'locale', 'zh.json'), '{}')
writeFileSync(join(pkgDir, 'package.json'), '{"version":"1.0.0"}')

const backupDir = join(backupHome, 'rollback')
backupPackage(pkgDir, backupDir)
check('备份成功', existsSync(join(backupDir, 'index.js')), true)

// 模拟更新：内容换掉
writeFileSync(join(pkgDir, 'index.js'), 'NEW')
check('更新后内容已变', readFileSync(join(pkgDir, 'index.js'), 'utf8'), 'NEW')

// 回滚
restoreBackup(backupDir, pkgDir)
check('回滚恢复内容', readFileSync(join(pkgDir, 'index.js'), 'utf8'), 'OLD')
check('回滚保留子目录', existsSync(join(pkgDir, 'locale', 'zh.json')), true)

// 安装暂存文件
const stageHome = join(backupHome, 'stage')
mkdirSync(stageHome, { recursive: true })
writeFileSync(join(stageHome, 'index.js'), 'STAGED')
writeFileSync(join(stageHome, 'newfile.js'), 'NEWFILE')
const installed = installStaged(stageHome, pkgDir, ['index.js', 'newfile.js', 'missing.js'])
check('安装了两个文件', installed.length, 2)
check('安装内容正确', readFileSync(join(pkgDir, 'index.js'), 'utf8'), 'STAGED')
check('新增文件已就位', readFileSync(join(pkgDir, 'newfile.js'), 'utf8'), 'NEWFILE')
check('缺失文件被跳过', installed.includes('missing.js'), false)

rmSync(backupHome, { recursive: true, force: true })

//#endregion

//#region 包文件清单

const listHome = mkdtempSync(join(tmpdir(), 'dtu-list-'))
mkdirSync(join(listHome, 'locale'), { recursive: true })
mkdirSync(join(listHome, 'node_modules', 'dep'), { recursive: true })
mkdirSync(join(listHome, '.git'), { recursive: true })
writeFileSync(join(listHome, 'index.js'), '')
writeFileSync(join(listHome, 'locale', 'zh.json'), '')
writeFileSync(join(listHome, 'node_modules', 'dep', 'index.js'), '')
const packageFiles = listPackageFiles(listHome)
check('清单不含 node_modules', packageFiles.some((f) => f.startsWith('node_modules')), false)
check('清单不含 .git', packageFiles.some((f) => f.startsWith('.git')), false)
check('清单含源码', packageFiles.includes('index.js'), true)
rmSync(listHome, { recursive: true, force: true })

//#endregion

//#region 更新器：失败必须回滚

const upHome = mkdtempSync(join(tmpdir(), 'dtu-updater-'))
const installedDir = join(upHome, 'pkg')
mkdirSync(installedDir, { recursive: true })
writeFileSync(join(installedDir, 'index.js'), 'V1')
writeFileSync(join(installedDir, 'package.json'), JSON.stringify({
  name: 'dsh-token-usage', version: '1.0.0', repository: 'github:foo/bar',
}))

const updater = new PluginUpdater({
  pkgDir: installedDir,
  dataDir: join(upHome, 'data'),
  runningVersion: '1.0.0',
  repository: 'github:foo/bar',
  fetchImpl: async () => ({ ok: true, status: 200, async json() { return { tag_name: 'v1.1.0', body: 'notes', published_at: '2026-01-01T00:00:00Z' } } }),
})
const status = await updater.check()
check('检测到新版本', status.latest, '1.1.0')
check('标记可更新', status.available, true)
check('更新源已解析', JSON.stringify(status.source), JSON.stringify({ owner: 'foo', repo: 'bar' }))

// 版本相同则不可更新
const sameUpdater = new PluginUpdater({
  pkgDir: installedDir, dataDir: join(upHome, 'data2'), runningVersion: '1.1.0',
  repository: 'github:foo/bar',
  fetchImpl: async () => ({ ok: true, status: 200, async json() { return { tag_name: 'v1.1.0' } } }),
})
check('同版本不可更新', (await sameUpdater.check()).available, false)

// 没有 repository 时明确报错，不静默
const noRepo = new PluginUpdater({
  pkgDir: installedDir, dataDir: join(upHome, 'data3'), runningVersion: '1.0.0', repository: null,
  fetchImpl: async () => ({ ok: true, status: 200, async json() { return {} } }),
})
check('缺少 repository 时报错', (await noRepo.check()).error.includes('repository'), true)

// apply：下载内容版本不符 -> 必须回滚，磁盘保持原样
const mismatchUpdater = new PluginUpdater({
  pkgDir: installedDir, dataDir: join(upHome, 'data4'), runningVersion: '1.0.0', repository: 'github:foo/bar',
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() {
      return makeTar([
        { name: 'bar-1.1.0/package.json', content: '{"version":"9.9.9"}' },
        { name: 'bar-1.1.0/index.js', content: 'BAD' },
      ])
    },
  }),
})
let mismatchError
try {
  await mismatchUpdater.apply({ version: '1.1.0' })
} catch (error) {
  mismatchError = error
}
check('版本不符时抛错', mismatchError !== undefined, true)
check('版本不符时磁盘未被污染', readFileSync(join(installedDir, 'index.js'), 'utf8'), 'V1')

// apply：激活失败 -> 必须回滚磁盘
const activateFailUpdater = new PluginUpdater({
  pkgDir: installedDir, dataDir: join(upHome, 'data5'), runningVersion: '1.0.0', repository: 'github:foo/bar',
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() {
      return makeTar([
        { name: 'bar-1.1.0/package.json', content: '{"version":"1.1.0"}' },
        { name: 'bar-1.1.0/index.js', content: 'NEW' },
      ])
    },
  }),
})
let activateError
try {
  await activateFailUpdater.apply({ version: '1.1.0', activate: async () => ({ ok: false, error: 'reload failed' }) })
} catch (error) {
  activateError = error
}
check('激活失败时抛错', activateError !== undefined, true)
check('激活失败后磁盘回滚', readFileSync(join(installedDir, 'index.js'), 'utf8'), 'V1')
check('激活失败后 package.json 回滚', JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version, '1.0.0')

// apply：一切正常 -> 文件更新
const okUpdater = new PluginUpdater({
  pkgDir: installedDir, dataDir: join(upHome, 'data6'), runningVersion: '1.0.0', repository: 'github:foo/bar',
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() {
      return makeTar([
        { name: 'bar-1.2.0/package.json', content: '{"version":"1.2.0"}' },
        { name: 'bar-1.2.0/index.js', content: 'V12' },
      ])
    },
  }),
})
const applied = await okUpdater.apply({ version: '1.2.0', activate: async () => ({ ok: true }) })
check('更新成功', applied.ok, true)
check('更新后内容生效', readFileSync(join(installedDir, 'index.js'), 'utf8'), 'V12')
check('更新后版本已升', JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version, '1.2.0')

// apply：网络失败 -> 磁盘不动
const netFailUpdater = new PluginUpdater({
  pkgDir: installedDir, dataDir: join(upHome, 'data7'), runningVersion: '1.2.0', repository: 'github:foo/bar',
  fetchImpl: async () => ({ ok: false, status: 503, async arrayBuffer() { return new ArrayBuffer(0) } }),
})
let netError
try {
  await netFailUpdater.apply({ version: '1.3.0' })
} catch (error) {
  netError = error
}
check('网络失败时抛错', netError !== undefined, true)
check('网络失败时磁盘未变', readFileSync(join(installedDir, 'index.js'), 'utf8'), 'V12')

rmSync(upHome, { recursive: true, force: true })

//#endregion

//#region 发布一致性：version 必须与 package.json 一致

// selfReload 会用 expectedVersion 校验替换上去的代码版本。如果模块里声明的
// version 和 package.json 漂移了，更新流程会在激活那一步失败——而这属于
// 「发布时忘了改一处」的典型错误，必须在 CI 里挡住。
const rootDir = fileURLToPath(new URL('..', import.meta.url))
const manifestVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version
const moduleSource = readFileSync(join(rootDir, 'index.js'), 'utf8')
const declaredVersion = /export const version = '([^']+)'/.exec(moduleSource)?.[1]
check('index.js 声明了 version', typeof declaredVersion, 'string')
check('version 与 package.json 一致', declaredVersion, manifestVersion)

// repository 必须能被解析出 owner/repo，否则自更新拿不到更新源
const manifestRepo = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).repository
check('repository 可解析', parseRepository(manifestRepo) !== null, true)
// 开源前要把占位符换掉。这里不阻断本地开发，但必须显式告警——
// 占位符留着会让自更新拿不到正确的更新源。
if (parseRepository(manifestRepo)?.owner === 'YOUR_GITHUB_USER') {
  console.warn('! package.json 的 repository 仍是占位符 YOUR_GITHUB_USER，发布前请替换为真实地址')
}

//#endregion

//#region 热重载辅助函数

check('未在重载', isReloading(), false)
// 这两个 helper 面向 src/ 下的模块（selfReload 的调用方就在那里），
// `../` 上一层即包根目录。
const pkgUrl = packageUrlOf('file:///a/b/src/reload.js')
check('packageUrlOf 定位到包根', pkgUrl, 'file:///a/b/')
check('entryUrlOf 指向包根的 index.js', entryUrlOf('file:///a/b/src/reload.js'), 'file:///a/b/index.js')

// packageCacheKeys 只认本包、并容忍编码差异
const fakeCache = new Map([
  ['file:///a/b/index.js', 1],
  ['file:///a/b/src/reload.js', 2],
  ['file:///a/bc/other.js', 3],
  ['file:///a/other%20pkg/index.js', 4],
])
const keys = packageCacheKeys(fakeCache, 'file:///a/b/')
check('命中本包两个模块', keys.length, 2)
check('不误伤同前缀的兄弟包', keys.includes('file:///a/bc/other.js'), false)

//#endregion

if (failures.length > 0) {
  console.error('失败：')
  for (const failure of failures) console.error('  ✗', failure)
  process.exit(1)
}

console.log('✓ 更新与热重载测试全部通过')
console.log('  版本比较 / repository 解析 / tar 解压安全 / 备份回滚 / 包清单 / 更新器失败回滚 / 缓存键匹配')
