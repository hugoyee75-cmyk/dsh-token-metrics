/**
 * 发布元数据自检。
 *
 * 开源仓库里最容易悄悄退化的不是代码，而是元数据：仓库地址写回占位符、
 * 声明了 files 白名单却漏掉运行必需的文件、版本号与 CHANGELOG 脱节。
 * 这些都不会让测试失败，但会让「自更新」和「安装」在用户那边坏掉。
 *
 * 因此这里把发布前该成立的约束固化成断言，CI 与 `npm run check` 都会跑。
 *
 * 运行：node test/metadata-test.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const failures = []
const notes = []
function check(label, condition, detail) {
  if (!condition) failures.push(`${label}${detail ? `：${detail}` : ''}`)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// —— 1. repository 必须是真实地址 ——
// 自更新固定从这里解析 owner/repo；占位符意味着更新通道直接坏掉。
const repoUrl = String(pkg.repository?.url ?? '')
check('repository 已声明', repoUrl.length > 0)
check('repository 不是占位符', !/YOUR_GITHUB_USER|placeholder|example\.com/i.test(repoUrl), repoUrl)

const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repoUrl)
check('repository 可解析出 owner/repo', match !== null, repoUrl)
const owner = match?.[1] ?? ''
const repo = match?.[2] ?? ''

// homepage / bugs 应与 repository 指向同一处，避免用户点进 404。
check('homepage 与 repository 一致', String(pkg.homepage ?? '').includes(`${owner}/${repo}`), pkg.homepage)
check('bugs 与 repository 一致', String(pkg.bugs?.url ?? '').includes(`${owner}/${repo}`), pkg.bugs?.url)
check('author 已填写', typeof pkg.author === 'string' && pkg.author.trim().length > 0)
check('license 已声明', typeof pkg.license === 'string' && pkg.license.length > 0)

// —— 2. files 白名单必须覆盖运行必需文件 ——
// 漏掉任何一个，用户装到的包就是缺件的。
const files = Array.isArray(pkg.files) ? pkg.files : []
check('声明了 files 白名单', files.length > 0)

const required = [
  'index.js',      // 入口
  'client.js',     // 前端面板
  'src',           // updater + reload
  'cordis.patch.yml', // bundle patch
  'icon.svg',
  'README.md',
  'LICENSE',
]
for (const entry of required) {
  check(`files 覆盖 ${entry}`, files.includes(entry), `实际：${files.join(', ')}`)
}

// 白名单里列出的东西必须真的存在于磁盘上。
for (const entry of files) {
  // 通配项（locale/*.json）只检查其目录。
  const target = entry.includes('*') ? entry.slice(0, entry.indexOf('/')) : entry
  check(`files 中的 ${entry} 存在`, existsSync(join(root, target)))
}

// —— 3. 包内实际存在但未声明的运行文件 ——
// 防止新增模块后忘记加进白名单。
for (const entry of ['test', 'package.json']) {
  const expected = entry === 'package.json' // npm 总是打包 package.json
  if (!expected && files.includes(entry)) check(`${entry} 不应进包`, false)
}
notes.push(`包内容：${files.length} 项`)

// —— 4. 双语文档齐全 ——
check('中文 README 存在', existsSync(join(root, 'README.md')))
check('英文 README 存在', existsSync(join(root, 'README.en.md')))
check('英文 README 已声明进 files', files.includes('README.en.md'))
check('LICENSE 文件存在', existsSync(join(root, 'LICENSE')))
for (const doc of ['CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md']) {
  check(`${doc} 存在`, existsSync(join(root, doc)))
}

// —— 5. 版本一致性 ——
// index.js 的导出版本与 package.json 必须一致：自更新用后者解析、
// 用前者校验热重载后的实际代码。
const indexSource = readFileSync(join(root, 'index.js'), 'utf8')
const versionMatch = /export const version = '([^']+)'/.exec(indexSource)
check('index.js 导出了 version', versionMatch !== null)
if (versionMatch !== null) {
  check('index.js 与 package.json 版本一致', versionMatch[1] === pkg.version,
    `index.js=${versionMatch[1]} package.json=${pkg.version}`)
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  check('CHANGELOG 记录了当前版本', changelog.includes(`[${pkg.version}]`),
    `CHANGELOG 中未见 [${pkg.version}]`)
}

// —— 6. engines 声明 ——
check('声明了 node engines', typeof pkg.engines?.node === 'string', pkg.engines?.node)

// —— 7. 无密钥泄漏（轻量扫描） ——
// 只在源码与文档里找明显的凭据形状，避免把测试用的假值也当成泄漏。
const secretPattern = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/
for (const file of ['index.js', 'client.js', 'src/updater.js', 'src/reload.js']) {
  const text = readFileSync(join(root, file), 'utf8')
  check(`${file} 无凭据形状字符串`, !secretPattern.test(text))
}

// —— 输出 ——
if (failures.length > 0) {
  console.error('发布元数据自检失败：')
  for (const failure of failures) console.error('  ✗', failure)
  process.exit(1)
}

console.log('✓ 发布元数据自检通过')
console.log(`  ${owner}/${repo} v${pkg.version} · ${files.length} 项进包 · 双语文档齐全`)
for (const note of notes) console.log(`  ${note}`)
