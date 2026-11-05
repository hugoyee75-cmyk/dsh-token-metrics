/**
 * DSH 会话日志的多帧 zstd 解压。
 *
 * DSH 的 `.jsonl.zstd` 是追加写的：每次 flush 追加一个独立的 zstd frame。
 * Node 的 `zstdDecompressSync` 只解第一个 frame —— 一份 1.7MB 的日志只能
 * 读出 295 字节，历史回扫会漏掉几乎全部事件。
 *
 * 难点在切分：按魔法数切分时，压缩数据内部也可能偶然出现同样的 4 字节。
 * 更糟的是 Node 对**截断的 frame 不抛异常**，而是静默返回已解出的前缀，
 * 于是「按伪切点解出一段」看起来同样成功，后面真正的 frame 会错位甚至
 * 整段丢失。
 *
 * 鉴别方法：frame 是自定界的，从同一个起点解到文件尾时会自然停在帧尾。
 * 若「起点→候选切点」与「起点→文件尾」的输出完全一致，切点就是真边界；
 * 否则是帧内伪魔法，跳过。
 */

import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端 0xFD2FB528）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * @param {Buffer} raw 可能是多帧拼接的原始字节
 * @param {(input: Buffer) => Buffer} [decompress] 可注入，便于测试截断行为
 * @returns {Buffer} 所有帧解压后的拼接结果
 */
export function decompressZstdFrames(raw, decompress) {
  const decode = typeof decompress === 'function' ? decompress : defaultDecompress
  const offsets = []
  let cursor = 0
  while ((cursor = raw.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    offsets.push(cursor)
    cursor += 4
  }
  if (offsets.length === 0) {
    const single = safeDecode(decode, raw)
    return single === undefined ? Buffer.alloc(0) : single
  }

  const parts = []
  let frameStart = offsets[0]
  let full
  for (let index = 1; index < offsets.length; index += 1) {
    if (full === undefined) {
      // 解到文件尾可能因尾部垃圾/损坏而失败；不要立刻放弃，下面还有
      // 「按候选切点解」的兜底路径。
      full = safeDecode(decode, raw.subarray(frameStart))
    }
    const cut = safeDecode(decode, raw.subarray(frameStart, offsets[index]))
    if (cut === undefined) continue
    if (full === undefined) {
      /**
       * 解到文件尾失败（尾部垃圾 / 损坏 / 截断）。此时无法用「长度一致」
       * 鉴别伪 magic，但也不能把整份日志丢掉：接受能解出的候选切点，
       * 至少保住它之前的帧。实测 Node 24 对「帧 + 尾部垃圾」会抛错，
       * Node 26.5 则静默返回帧内容，这里统一兜底。
       */
      parts.push(cut)
      frameStart = offsets[index]
      continue
    }
    // 长度和内容都必须一致，才承认这是真正的帧边界。
    if (cut.length !== full.length || !cut.equals(full)) continue
    parts.push(full)
    frameStart = offsets[index]
    full = undefined
  }
  if (full !== undefined) {
    parts.push(full)
  } else {
    const tail = safeDecode(decode, raw.subarray(frameStart))
    if (tail !== undefined && tail.length > 0) parts.push(tail)
  }
  return Buffer.concat(parts)
}

function safeDecode(decode, input) {
  try {
    return decode(input)
  } catch {
    return undefined
  }
}

function defaultDecompress(input) {
  return zstdDecompressSync(input)
}
