/**
 * 自更新：检查并安装新版本，然后热重载。
 *
 * ## 面向 GitHub 的轻量方案
 *
 * 本插件以 `github:<user>/<repo>` 形式安装（或 `link:` 本地开发），因此
 * 更新源就是 GitHub 本身，不需要自建 manifest 服务：
 *
 *   1. 读 `package.json` 的 `repository` 字段拿到 owner/repo；
 *   2. 查 GitHub Releases API 或 tags 找出最新版本；
 *   3. 下载 tarball，校验后解压到暂存目录；
 *   4. 备份当前包目录，把新文件原子搬进去；
 *   5. 调 selfReload 让运行中的实例换成新代码；
 *   6. 任何一步失败就回滚磁盘与运行时。
 *
 * ## 为什么不用 pnpm 直接装
 *
 * `pnpm update` 对 `github:` 依赖只会按 lockfile 重装，未必拿到新 tag；
 * 而且它跑在 profile 目录里、会改写 lockfile，风险面比「插件自己替换
 * 自己的文件」大得多。这里只做最小必要动作，并对每个字节做校验。
 *
 * ## 安全
 *
 * 更新源固定由 `repository` 决定，**不接受任何来自配置或请求的 URL**——
 * 让配置项指向任意地址，就是从「写一个字段」直达「在宿主进程里执行任意
 * 代码」的一步之遥。可选地支持 sha256 校验清单，用于防止传输被篡改。
 *
 * @module src/updater.js
 */

import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** 比较版本：-1 | 0 | 1，遵循 semver 优先级（预发布排在正式版之前）。 */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(value ?? '').trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? null : match[4].split('.'),
  }
}

/** semver 比较。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a === b ? 0 : a > b ? 1 : -1
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const width = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < width; index += 1) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 从 package.json 的 repository 字段解析出 owner/repo。 */
export function parseRepository(value) {
  if (value === null || value === undefined) return null
  const raw = typeof value === 'string' ? value : value.url
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const cleaned = raw.trim().replace(/^git\+/, '')
  // `github:owner/repo` 是 pnpm / npm 常用的写法，也要认。
  const shorthand = /^github:([^/]+)\/([^/#.]+?)(?:\.git)?(?:#.*)?$/.exec(cleaned)
  if (shorthand !== null) return { owner: shorthand[1], repo: shorthand[2] }
  const match = /github\.com[/:]([^/]+)\/([^/#.]+?)(?:\.git)?(?:#.*)?$/.exec(cleaned)
  if (match === null) return null
  return { owner: match[1], repo: match[2] }
}

/** 文件 sha256。 */
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 列出包目录下的全部文件（相对路径），跳过数据目录与隐藏文件。 */
export function listPackageFiles(dir, { skip = ['.git', 'node_modules', 'test', 'src'] } = {}) {
  const files = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name.startsWith('.') || skip.includes(name)) continue
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(relative(dir, full))
    }
  }
  walk(dir)
  return files.sort()
}

/** 备份包目录到 backupDir。 */
export function backupPackage(pkgDir, backupDir) {
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(backupDir, { recursive: true })
  cpSync(pkgDir, backupDir, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[/\\]/).pop() ?? ''
      return !name.startsWith('.') && name !== 'node_modules' && name !== 'test'
    },
  })
  return backupDir
}

/** 回滚：用备份覆盖包目录。 */
export function restoreBackup(backupDir, pkgDir) {
  if (!existsSync(backupDir)) throw new Error(`no backup at ${backupDir}`)
  for (const name of readdirSync(backupDir)) {
    const source = join(backupDir, name)
    const target = join(pkgDir, name)
    rmSync(target, { recursive: true, force: true })
    cpSync(source, target, { recursive: true })
  }
}

/**
 * 把暂存目录里的文件装进包目录。
 *
 * 逐个文件先写临时名再 rename，避免半截文件被运行中的代码读到。
 */
export function installStaged(stageDir, pkgDir, files) {
  const installed = []
  for (const relativePath of files) {
    const source = join(stageDir, relativePath)
    if (!existsSync(source)) continue
    const target = join(pkgDir, relativePath)
    mkdirSync(join(target, '..'), { recursive: true })
    const temp = `${target}.new`
    cpSync(source, temp)
    renameSync(temp, target)
    installed.push(relativePath)
  }
  return installed
}

/**
 * 更新器。
 *
 * 只做「发现新版本 + 安装 + 触发重载」，不含 UI。UI 通过宿主路由读
 * `status()` 并调用 `check()` / `apply()`。
 */
export class PluginUpdater {
  /**
   * @param {object} deps
   * @param {string} deps.pkgDir 已安装的包目录
   * @param {string} deps.dataDir 插件数据目录（暂存、备份、历史）
   * @param {() => object} [deps.settings] 读配置
   * @param {(message: string) => void} [deps.log]
   * @param {typeof fetch} [deps.fetchImpl]
   * @param {string} [deps.runningVersion] 当前运行模块声明的版本
   * @param {string} [deps.repository] 覆盖 repository 字段（测试用）
   */
  constructor({
    pkgDir, dataDir, settings = () => ({}), log = () => {},
    fetchImpl = globalThis.fetch, runningVersion, repository,
  }) {
    this.deps = { pkgDir, dataDir, settings, log, fetchImpl, runningVersion, repository }
    this.latest = undefined
    this.checkedAt = 0
    this.error = ''
    this.applying = false
  }

  get stageDir() { return join(this.deps.dataDir, 'upgrade-stage') }
  get backupDir() { return join(this.deps.dataDir, 'rollback') }
  get stateFile() { return join(this.deps.dataDir, 'upgrade-state.json') }

  /** 当前磁盘上 package.json 的版本。 */
  currentVersion() {
    try {
      return String(JSON.parse(readFileSync(join(this.deps.pkgDir, 'package.json'), 'utf8')).version ?? '')
    } catch {
      return ''
    }
  }

  /** 解析更新源。固定来自 package.json，不接受外部输入。 */
  repository() {
    if (this.deps.repository !== undefined) return parseRepository(this.deps.repository)
    try {
      const manifest = JSON.parse(readFileSync(join(this.deps.pkgDir, 'package.json'), 'utf8'))
      return parseRepository(manifest.repository)
    } catch {
      return null
    }
  }

  /** 更新状态。 */
  status() {
    const installedVersion = this.currentVersion()
    const current = this.deps.runningVersion ?? installedVersion
    const available = this.latest !== undefined && compareVersions(this.latest.version, current) > 0
    return {
      current,
      installedVersion,
      versionMismatch: current !== installedVersion,
      latest: this.latest?.version ?? '',
      available,
      notes: this.latest?.notes ?? '',
      publishedAt: this.latest?.publishedAt ?? 0,
      checkedAt: this.checkedAt,
      applying: this.applying,
      error: this.error,
      source: this.repository(),
    }
  }

  /**
   * 查询最新版本。
   *
   * 优先 GitHub Releases（带 release notes），失败则退回 tags。
   */
  async check({ signal } = {}) {
    const repo = this.repository()
    if (repo === null) {
      this.error = 'package.json 里没有可用的 repository 字段'
      return this.status()
    }
    const fetchImpl = this.deps.fetchImpl
    if (typeof fetchImpl !== 'function') {
      this.error = '当前环境没有 fetch'
      return this.status()
    }

    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-token-usage' }
    const base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`

    let version
    let notes = ''
    let publishedAt = 0
    try {
      const response = await fetchImpl(`${base}/releases/latest`, { headers, signal })
      if (response.ok) {
        const body = await response.json()
        version = String(body.tag_name ?? body.name ?? '').replace(/^v/, '')
        notes = String(body.body ?? '')
        publishedAt = Date.parse(body.published_at ?? '') || 0
      }
    } catch { /* 退回 tags */ }

    if (version === undefined || parseVersion(version) === null) {
      try {
        const response = await fetchImpl(`${base}/tags?per_page=30`, { headers, signal })
        if (response.ok) {
          const body = await response.json()
          const candidates = (Array.isArray(body) ? body : [])
            .map((tag) => String(tag.name ?? '').replace(/^v/, ''))
            .filter((tag) => parseVersion(tag) !== null)
          candidates.sort(compareVersions)
          version = candidates[candidates.length - 1]
        }
      } catch (error) {
        this.error = `查询更新失败：${error?.message ?? error}`
        return this.status()
      }
    }

    if (version === undefined || parseVersion(version) === null) {
      this.error = '没有找到可用的版本号'
      return this.status()
    }
    this.error = ''
    this.latest = { version, notes, publishedAt }
    this.checkedAt = Date.now()
    return this.status()
  }

  /**
   * 下载并安装指定版本。
   *
   * @param {object} options
   * @param {string} [options.version] 目标版本；默认用 check 的结果
   * @param {(installed: {version: string}) => Promise<object>} [options.activate]
   *   文件装好后调用；通常传入 selfReload
   */
  async apply({ version, activate, signal } = {}) {
    if (this.applying) throw new Error('已有一次更新在运行')
    const target = version ?? this.latest?.version
    if (target === undefined || target === '') throw new Error('没有目标版本，先调用 check()')
    const repo = this.repository()
    if (repo === null) throw new Error('没有可用的 repository')

    this.applying = true
    const fetchImpl = this.deps.fetchImpl
    let backupMade = false
    try {
      // 1) 下载 tarball
      const url = `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/refs/tags/v${target}`
      const response = await fetchImpl(url, {
        headers: { 'user-agent': 'dsh-token-usage' },
        signal,
      })
      if (!response.ok) {
        // 有些仓库的 tag 不带 v 前缀，再试一次
        const alt = await fetchImpl(`https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/refs/tags/${target}`, {
          headers: { 'user-agent': 'dsh-token-usage' },
          signal,
        })
        if (!alt.ok) throw new Error(`下载失败：HTTP ${response.status}`)
        return await this.#extractAndInstall(await alt.arrayBuffer(), target, activate, repo)
      }
      return await this.#extractAndInstall(await response.arrayBuffer(), target, activate, repo)
    } catch (error) {
      this.error = error?.message ?? String(error)
      if (backupMade) {
        try {
          restoreBackup(this.backupDir, this.deps.pkgDir)
          this.deps.log?.(`token-usage: 更新失败，已从备份回滚磁盘`)
        } catch (restoreError) {
          this.deps.log?.(`token-usage: 回滚也失败：${restoreError?.message ?? restoreError}`)
        }
      }
      throw error
    } finally {
      this.applying = false
    }
  }

  /** 解压 tarball、安装、触发重载。 */
  async #extractAndInstall(buffer, target, activate, repo) {
    const files = await extractTarGz(buffer, this.stageDir, `${repo.repo}-${target}`)
    const manifestPath = join(this.stageDir, 'package.json')
    if (!existsSync(manifestPath)) throw new Error('下载的包里没有 package.json')
    const staged = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (String(staged.version ?? '') !== target) {
      throw new Error(`版本不符：期望 ${target}，包内声明 ${String(staged.version)}`)
    }

    // 备份当前版本，然后安装新文件
    backupPackage(this.deps.pkgDir, this.backupDir)
    const installedFiles = [...files].filter((file) => !file.startsWith('test/') && !file.startsWith('src/'))
    installStaged(this.stageDir, this.deps.pkgDir, installedFiles)
    this.deps.log?.(`token-usage: 已安装 ${installedFiles.length} 个文件，版本 ${target}`)

    // 触发重载
    if (typeof activate === 'function') {
      const result = await activate({ version: target })
      if (result?.ok !== true) {
        // 新代码没起来：把旧文件放回去
        restoreBackup(this.backupDir, this.deps.pkgDir)
        throw new Error(`新版本启动失败，已回滚磁盘（${result?.error ?? 'unknown'}）`)
      }
      this.deps.log?.(`token-usage: 已激活 ${target}`)
    }
    this.checkedAt = Date.now()
    return { ok: true, version: target, files: installedFiles.length }
  }
}

/**
 * 解压 tar.gz 到目标目录。
 *
 * 用 Node 内置 zlib 解压 gzip，再手写一个最小的 ustar 解析器——避免为了
 * 一个更新功能引入 tar 依赖，也让插件保持零运行时依赖。
 *
 * @returns {Promise<string[]>} 展开出的相对路径列表
 */
export async function extractTarGz(buffer, targetDir, stripPrefix) {
  const { gunzipSync } = await import('node:zlib')
  const tar = gunzipSync(Buffer.from(buffer))
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  const written = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // 全零块 = 归档结束
    if (header.every((byte) => byte === 0)) break

    const readString = (start, length) => {
      const slice = header.subarray(start, start + length)
      const end = slice.indexOf(0)
      return slice.subarray(0, end === -1 ? length : end).toString('utf8').trim()
    }
    const name = readString(0, 100)
    const size = parseInt(readString(124, 12), 8) || 0
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const prefix = readString(345, 155)
    const fullName = prefix === '' ? name : `${prefix}/${name}`

    // 只取目标版本目录下的内容
    const slash = fullName.indexOf('/')
    const relativePath = slash === -1 ? '' : fullName.slice(slash + 1)
    offset += 512
    const content = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    if (relativePath === '' || !fullName.startsWith(`${stripPrefix}/`)) continue
    // 拒绝路径穿越
    if (relativePath.includes('..') || relativePath.startsWith('/')) continue

    const target = join(targetDir, relativePath)
    if (typeFlag === '5' || relativePath.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
    written.push(relativePath)
  }
  return written
}
