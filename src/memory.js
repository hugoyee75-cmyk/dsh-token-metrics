/**
 * 内存保护。
 *
 * 为什么需要：回扫要一次性读大量会话日志（Codex 的归档就有 1GB），
 * 解析出来的 JSON 对象会瞬间撑高堆内存。DSH 跑在用户机器上，插件把
 * 宿主拖死是不可接受的。
 *
 * 策略：不做事前精确估算（估不准），改成**执行中检查**——
 * 每处理一批就看一下堆占用，超过阈值就让出控制权，等 GC 回收后再继续。
 */

/** 默认阈值：堆用到上限的这个比例就开始让步。 */
const DEFAULT_SOFT_RATIO = 0.7

/** 让步时的单次等待（毫秒）。给 GC 一点时间，也不要等太久。 */
const YIELD_MS = 16

/**
 * 读取当前堆占用。
 *
 * `heapUsed / heap_size_limit` 比总 RSS 更能反映「离 OOM 还有多远」，
 * 因为 RSS 里包含不必回收的部分。
 */
export function heapPressure() {
  try {
    const usage = process.memoryUsage()
    if (!Number.isFinite(usage.heapUsed) || !Number.isFinite(usage.heapTotal)) return 0
    // 用 heapTotal 做分母而不是 heap_size_limit：后者是 V8 允许的上限，
    // 通常远大于实际占用，用它做比值会让阈值几乎永不触发。
    const limit = Math.max(usage.heapTotal, usage.heapUsed)
    return limit > 0 ? usage.heapUsed / limit : 0
  } catch {
    return 0
  }
}

/**
 * 创建一个内存闸门。
 *
 * 用法：
 *   const gate = createMemoryGate({ softRatio: 0.7 })
 *   for (const file of files) {
 *     await gate.check()   // 压力大时在这里让步
 *     process(file)
 *   }
 *
 * @param {object} [options]
 * @param {number} [options.softRatio] 软阈值，超过就让步
 * @param {number} [options.maxRounds] 连续让步次数上限，防止死等
 * @param {(ratio:number)=>void} [options.onPressure] 触发让步时的回调（用于日志）
 */
export function createMemoryGate({
  softRatio = DEFAULT_SOFT_RATIO,
  maxRounds = 20,
  onPressure,
} = {}) {
  const ratio = Number.isFinite(softRatio) ? Math.min(0.95, Math.max(0.3, softRatio)) : DEFAULT_SOFT_RATIO
  let yields = 0

  return {
    /** 当前压力（每次实时读取，不缓存）。 */
    pressure: heapPressure,

    /**
     * 检查一次。压力超过阈值就让步，返回是否让步过。
     *
     * 连续让步达到上限后不再等待——说明内存已经降不下来，
     * 继续死等只会让插件失去响应，不如让调用方自己决定怎么处理。
     */
    async check() {
      const current = heapPressure()
      if (current < ratio) {
        yields = 0
        return false
      }
      if (yields >= maxRounds) return false
      yields += 1
      try {
        onPressure?.(current)
      } catch { /* 回调异常不影响主流程 */ }
      await new Promise((resolve) => setTimeout(resolve, YIELD_MS))
      return true
    },

    /** 已经让步过多少次（排障用）。 */
    get yields() {
      return yields
    },
  }
}
