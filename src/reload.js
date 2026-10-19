/**
 * 自热重载：把运行中的插件实例换成磁盘上的新代码，不重启应用。
 *
 * ## 为什么需要自己实现
 *
 * 内核的 HMR 服务靠监视文件来重载插件，但它**有意关闭了模块监视**，也没有
 * 「立即重载这个插件」的 API。所以插件要更新自己，只能自己做一遍它内部
 * `partialReload` 走的同一套动作：
 *
 * 1. 快照当前 runtime 的 fiber 及其配置；
 * 2. 把本包的模块从 Node 的 ESM `loadCache` 和 CJS `require.cache` 里退出去；
 * 3. 通过 loader 重新 import 入口文件，让新源码真正被求值；
 * 4. 注销旧 fiber，用同一份配置注册替代品，并把 loader entry 重新挂上，
 *    这样配置写入和 volatile 更新仍然落到活的 fiber 上；
 * 5. 任何一步失败就把缓存和旧注册原样恢复——返回结果会明确说明旧的
 *    runtime 有没有被恢复，而不是含糊地承诺「应该没事」。
 *
 * 重载从一个普通定时器里启动，位于被注销的 fiber 之外，因此调用者自己的
 * effect 清理不会中途取消这次替换。
 *
 * ## 与参考实现的差异
 *
 * 这里的 `purgeCaches` 同时处理 Node 24 的原生 LoadCache（它的
 * `Map.prototype.delete` 只清一个类型槽）和旧版 Map 语义，并用「重新
 * import 后是否仍与旧对象同一」来验证缓存真的失效；没失效就加
 * generation 查询参数强制重新求值。这段逻辑来自实战踩坑，值得保留。
 *
 * @module src/reload.js
 */

import { watch } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

/** ESM 里访问 CJS 缓存需要 createRequire。 */
const require = createRequire(import.meta.url)

/** 同一时刻只允许一次重载，避免两次替换互相踩。 */
let inFlight = null

/** 每个包的依赖 generation 钩子只装一次。 */
const hooksKey = Symbol.for('dsh-token-usage.reload-hooks')
const reloadHooks = globalThis[hooksKey] ??= new Map()

/**
 * 让入口的 generation 传播到它 import 的依赖上。
 *
 * 某些内核会隐藏自己的模块缓存，导致只有入口被重新求值、依赖仍是旧的。
 * 这里注册一个 resolve 钩子，把入口 URL 上的 `dtu-reload` 查询参数同样
 * 加到它解析出的每个依赖上，使整棵子图都重新求值。
 */
function enableFreshDependencies(packageUrl) {
  if (reloadHooks.has(packageUrl)) return
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      if (!context.parentURL?.startsWith(packageUrl) || !resolved.url.startsWith(packageUrl)) return resolved
      const generation = new URL(context.parentURL).searchParams.get('dtu-reload')
      if (generation === null) return resolved
      const target = new URL(resolved.url)
      target.searchParams.set('dtu-reload', generation)
      return { ...resolved, url: target.href }
    },
  })
  reloadHooks.set(packageUrl, hook)
}

/** 当前是否有重载在跑。 */
export function isReloading() {
  return inFlight !== null
}

/** 本包目录（带尾斜杠的 file:// URL）。 */
export function packageUrlOf(entryModuleUrl) {
  return new URL('../', entryModuleUrl).href
}

/** 本包入口文件（index.js）的 file:// URL。 */
export function entryUrlOf(entryModuleUrl) {
  return new URL('../index.js', entryModuleUrl).href
}

/**
 * 找出 loadCache 里属于本包的所有键。
 *
 * 键的比较要容忍大小写与百分号编码的差异——Node 解析器和 `new URL`
 * 对同一路径可能产出不同写法。
 */
export function packageCacheKeys(loadCache, packageUrl) {
  const base = decodeURIComponent(packageUrl).replace(/\/+$/, '').toLowerCase() + '/'
  const keys = []
  for (const key of loadCache.keys()) {
    if (typeof key !== 'string') continue
    let normalized
    try {
      normalized = decodeURIComponent(key).toLowerCase()
    } catch {
      normalized = key.toLowerCase()
    }
    if (normalized.startsWith(base)) keys.push(key)
  }
  return keys
}

/**
 * 备份并从两个模块缓存里移除本包的模块。
 *
 * loadCache 用鸭子类型访问：Node 24.12+ 把那个 Map 子类换成了自己的结构，
 * 在新运行时上 `instanceof Map` 为假，尽管 keys/get/delete 仍像 Map 一样
 * 工作。真是 Map 时优先用 `Map.prototype` 的方法（Node 24 早期的
 * LoadCache.delete 只清一个类型槽）；否则用它自己的方法。
 *
 * @returns {{esm: Map<string, unknown>, cjs: Map<string, object>}} 备份，供回滚
 */
export function purgeCaches(internal, packageUrl) {
  const backup = { esm: new Map(), cjs: new Map() }
  const cache = internal?.loadCache
  if (cache !== null && cache !== undefined && typeof cache.keys === 'function'
    && typeof cache.get === 'function' && typeof cache.delete === 'function') {
    const read = (key) => {
      try {
        return Map.prototype.get.call(cache, key)
      } catch {
        try {
          return cache.get(key)
        } catch {
          return undefined
        }
      }
    }
    const drop = (key) => {
      try {
        Map.prototype.delete.call(cache, key)
        return
      } catch { /* 不是真正的 Map，走下面的分支 */ }
      try {
        cache.delete(key)
      } catch { /* 尽力而为 */ }
    }
    for (const key of packageCacheKeys(cache, packageUrl)) {
      backup.esm.set(key, read(key))
      drop(key)
    }
  }
  const require = createRequire(import.meta.url)
  for (const key of backup.esm.keys()) {
    try {
      const filePath = fileURLToPath(key)
      if (require.cache[filePath] !== undefined) {
        backup.cjs.set(filePath, require.cache[filePath])
        delete require.cache[filePath]
      }
    } catch {
      // 非 file: URL，CJS 侧无需处理
    }
  }
  return backup
}

/** 回滚：把 purge 的备份放回去。 */
export function restoreCaches(internal, backup) {
  const cache = internal?.loadCache
  for (const [key, job] of backup.esm) {
    try {
      Map.prototype.set.call(cache, key, job)
    } catch {
      try {
        cache.set(key, job)
      } catch { /* 尽力而为 */ }
    }
  }
  const require = createRequire(import.meta.url)
  for (const [filePath, module] of backup.cjs) require.cache[filePath] = module
}

/**
 * 就地重载调用者的插件实例。
 *
 * @param {object} ctx - `apply` 收到的上下文
 * @param {object} [options]
 * @param {object} [options.logger]
 * @param {string} [options.packageUrl] 本包目录 URL
 * @param {string} [options.entryUrl] 入口文件 URL
 * @param {string} [options.expectedVersion] 期望新代码声明的版本；不符即失败
 * @returns {Promise<{ok: true, version: string, fibers: number}
 *   | {ok: false, error: string, restored: boolean}>}
 */
export function selfReload(ctx, options = {}) {
  if (inFlight !== null) return inFlight
  inFlight = (async () => {
    const logger = options.logger ?? console
    const packageUrl = options.packageUrl ?? packageUrlOf(import.meta.url)
    const entryUrl = options.entryUrl ?? entryUrlOf(import.meta.url)
    const loader = ctx.loader
    const registry = ctx.registry
    if (loader === undefined || registry === undefined) {
      return { ok: false, error: 'no loader/registry on this context', restored: false }
    }

    // 插件身份就是注册表用来索引 runtime 的那个 exports 对象。
    const previous = ctx.fiber?.runtime?.callback
    if (previous === undefined || previous === null) {
      return { ok: false, error: 'no runtime to reload (plugin was not registered the ordinary way)', restored: false }
    }
    const runtime = registry.get(previous)
    const fibers = [...(runtime?.fibers ?? [])].map((fiber) => {
      const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined
      const plugin = typeof previous === 'function'
        ? { apply: previous, inject: { ...fiber.inject }, Config: runtime.Config, name: runtime.name }
        : previous
      return { fiber, entry, plugin, config: entry === undefined ? fiber._config : entry.options.config }
    })
    if (fibers.length === 0) {
      return { ok: false, error: 'runtime has no live fibers', restored: false }
    }

    const internal = loader.internal
    const backup = purgeCaches(internal, packageUrl)
    logger.info?.(`token-usage: 热重载清出 ${backup.esm.size} 个缓存模块`)

    const importFresh = async (url) => loader.unwrapExports(await loader.import(url, () => []))
    let replacement
    let busted = false
    try {
      replacement = await importFresh(entryUrl)
      if (replacement === undefined || typeof replacement.apply !== 'function') {
        throw new Error('reloaded module does not export apply()')
      }
      if (backup.esm.size === 0 || replacement === previous || replacement.apply === previous
        || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
        // 缓存清理在这个内核上没生效（loadCache 结构随 Node 版本变过）。
        // 用 generation 查询参数强制入口重新求值。
        enableFreshDependencies(packageUrl)
        const freshUrl = new URL(entryUrl)
        freshUrl.searchParams.set('dtu-reload', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
        replacement = await importFresh(freshUrl.href)
        busted = true
        if (replacement === undefined || typeof replacement.apply !== 'function') {
          throw new Error('reloaded module does not export apply()')
        }
        if (replacement === previous || replacement.apply === previous
          || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
          throw new Error('replacement is still the previous plugin after cache invalidation')
        }
      }
      if (options.expectedVersion !== undefined && replacement.version !== options.expectedVersion) {
        throw new Error(
          `activation version mismatch: expected ${options.expectedVersion}, got ${String(replacement.version ?? '(missing)')}`,
        )
      }
    } catch (error) {
      restoreCaches(internal, backup)
      return {
        ok: false,
        error: `re-import failed, old code still running (${error?.message ?? error})`,
        restored: true,
      }
    }
    globalThis[Symbol.for('dsh-token-usage.last-reload')] = { at: Date.now(), purged: backup.esm.size, busted }

    try {
      registry.delete(previous)
      await Promise.all(fibers.map(({ fiber }) => fiber.await()))
    } catch (error) {
      // 旧 fiber 无论如何都没了；下面的重新注册仍然是正确动作，
      // 因此这里只记日志、不向上抛，以免跳过注册。
      logger.warn?.(`token-usage: 热重载注销时报告 ${error?.message ?? error}`)
    }

    try {
      const created = []
      for (const { fiber, entry, config } of fibers) {
        const registered = fiber.parent.registry.plugin(replacement, config)
        const fresh = registered.ctx.fiber
        if (entry !== undefined) {
          fresh.entry = entry
          entry.fiber = fresh
        }
        created.push(fresh)
      }
      await Promise.all(created.map((fiber) => fiber.await()))
      logger.info?.(`token-usage: 热重载完成，重新注册 ${created.length} 个 fiber`)
      return { ok: true, version: String(replacement.version ?? ''), fibers: created.length }
    } catch (error) {
      // 新代码起来失败了：把旧代码放回缓存和注册表。
      restoreCaches(internal, backup)
      try {
        registry.delete(replacement)
      } catch { /* 可能从未启动 */ }
      try {
        const restored = []
        for (const { fiber, entry, plugin, config } of fibers) {
          const registered = fiber.parent.registry.plugin(plugin, config)
          const fresh = registered.ctx.fiber
          if (entry !== undefined) {
            fresh.entry = entry
            entry.fiber = fresh
          }
          restored.push(fresh)
        }
        await Promise.all(restored.map((fiber) => fiber.await()))
        return {
          ok: false,
          error: `new code failed to start, previous version restored (${error?.message ?? error})`,
          restored: true,
        }
      } catch (restoreError) {
        return {
          ok: false,
          error: `new code failed to start (${error?.message ?? error}); runtime restore failed too `
            + `(${restoreError?.message ?? restoreError})`,
          restored: false,
        }
      }
    }
  })()
  return inFlight.finally(() => { inFlight = null })
}

/**
 * 监视包目录，任何源文件变化就热重载。
 *
 * 默认关闭：正式安装不会自己改写自己的文件。它面向开发与「改一行看效果」
 * 的场景，由配置项 `watchFiles` 打开。
 *
 * @returns {() => void} 停止函数
 */
export function watchPackage(packageDir, { onChange, logger = console, debounceMs = 800 } = {}) {
  let timer
  let paused = false
  let watcher
  try {
    watcher = watch(packageDir, { recursive: true })
  } catch (error) {
    logger.warn?.(`token-usage: 无法监视 ${packageDir}（${error?.message ?? error}）`)
    return () => {}
  }
  const schedule = () => {
    if (paused) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (paused) return
      onChange?.()
    }, debounceMs)
    timer.unref?.()
  }
  watcher.on('change', schedule)
  watcher.on('error', (error) => logger.warn?.(`token-usage: 监视器错误（${error?.message ?? error}）`))
  return () => {
    paused = true
    clearTimeout(timer)
    try {
      watcher.close()
    } catch { /* 已经关了 */ }
  }
}

