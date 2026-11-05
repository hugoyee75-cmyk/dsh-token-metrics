/**
 * 多帧 zstd 解压自检。
 *
 * 重点不是「能解压」，而是「帧内伪 magic 时不能把后面的真帧丢掉」。
 * Node 对截断帧不抛错、静默返回前缀，所以用注入的假解压器精确模拟这个
 * 行为，构造一份「第二帧内部含 magic」的日志。
 */

import { zstdCompressSync } from 'node:zlib'
import { decompressZstdFrames, ZSTD_MAGIC } from '../src/zstd.js'

const failures = []
function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}
function checkTrue(label, condition, detail = '') {
  if (condition !== true) failures.push(`${label}${detail === '' ? '' : `：${detail}`}`)
}

//#region 真实 zstd：多帧拼接

{
  const first = zstdCompressSync(Buffer.from('{"a":1}\n'))
  const second = zstdCompressSync(Buffer.from('{"b":2}\n'))
  const output = decompressZstdFrames(Buffer.concat([first, second]))
  check('两帧拼接', output.toString('utf8'), '{"a":1}\n{"b":2}\n')
}

{
  // 单帧不能被切坏。
  const single = zstdCompressSync(Buffer.from('only-one-frame'))
  check('单帧', decompressZstdFrames(single).toString('utf8'), 'only-one-frame')
}

{
  // 帧尾后面跟一段魔法数垃圾：不能因此丢掉前面的真帧。
  const frame = zstdCompressSync(Buffer.from('payload'))
  const raw = Buffer.concat([frame, ZSTD_MAGIC, Buffer.from([0, 0, 0, 0])])
  const output = decompressZstdFrames(raw)
  check('尾部伪 magic 不影响真帧', output.toString('utf8'), 'payload')
}

{
  // 完全不是 zstd：返回空而不是抛异常，调用方会退回纯文本。
  const output = decompressZstdFrames(Buffer.from('not-zstd-at-all'))
  check('非 zstd 输入', output.length, 0)
}

//#endregion

//#region 假解压器：帧内伪 magic 的精确回归

/** 构造一个「按帧前缀解码、截断时返回前缀」的假解压器，模拟 Node 的真实行为。 */
function makeFakeDecoder(frames) {
  return (input) => {
    for (const item of frames) {
      if (input.length >= item.frame.length && input.subarray(0, item.frame.length).equals(item.frame)) {
        return item.content
      }
      // 输入是某个帧的前缀：模拟 zstd 对截断帧静默返回部分内容。
      if (input.length < item.frame.length && item.frame.subarray(0, input.length).equals(input)) {
        const ratio = input.length / item.frame.length
        return item.content.subarray(0, Math.floor(item.content.length * ratio))
      }
    }
    return Buffer.alloc(0)
  }
}

{
  const frames = [
    { frame: Buffer.concat([ZSTD_MAGIC, Buffer.from('FRAME-ONE-BODY')]), content: Buffer.from('one|') },
    // 第二帧的压缩体内部带 magic：旧实现会在这里切错。
    {
      frame: Buffer.concat([ZSTD_MAGIC, Buffer.from('FRAME-TWO-'), ZSTD_MAGIC, Buffer.from('-BODY')]),
      content: Buffer.from('two|'),
    },
    { frame: Buffer.concat([ZSTD_MAGIC, Buffer.from('FRAME-THREE-BODY')]), content: Buffer.from('three|') },
  ]
  const raw = Buffer.concat(frames.map((item) => item.frame))
  const decoder = makeFakeDecoder(frames)
  const output = decompressZstdFrames(raw, decoder)
  check('帧内伪 magic 不丢帧', output.toString('utf8'), 'one|two|three|')

  // 对照：如果按旧逻辑「切出来能解就收」，会在伪 magic 处拿到截断前缀。
  const fakeOffset = frames[0].frame.length + frames[1].frame.indexOf(ZSTD_MAGIC, 1)
  const wrongCut = decoder(raw.subarray(frames[0].frame.length, fakeOffset))
  checkTrue('对照：伪切点确实只解出前缀', wrongCut.length < frames[1].content.length)
}

{
  // 第一帧末尾恰好是伪 magic（切出来仍能解出完整第一帧）：不能把它当边界后
  // 把真正的第二帧弄丢。
  const frames = [
    { frame: Buffer.concat([ZSTD_MAGIC, Buffer.from('A-BODY'), ZSTD_MAGIC]), content: Buffer.from('A|') },
    { frame: Buffer.concat([ZSTD_MAGIC, Buffer.from('B-BODY')]), content: Buffer.from('B|') },
  ]
  const raw = Buffer.concat(frames.map((item) => item.frame))
  const output = decompressZstdFrames(raw, makeFakeDecoder(frames))
  check('帧尾伪 magic 仍保留后续帧', output.toString('utf8'), 'A|B|')
}

{
  // Node 24 对「帧 + 尾部垃圾」的 zstdDecompressSync 会抛错，Node 26.5 则
  // 静默返回帧内容。两种行为都必须保住已经能解出的帧。
  const frames = [{ frame: Buffer.concat([ZSTD_MAGIC, Buffer.from('BODY')]), content: Buffer.from('ok') }]
  const raw = Buffer.concat([frames[0].frame, ZSTD_MAGIC, Buffer.from([0, 0, 0, 0])])
  const decoder = (input) => {
    if (input.length > frames[0].frame.length
      && input.subarray(0, frames[0].frame.length).equals(frames[0].frame)) {
      throw new Error('trailing garbage')
    }
    if (input.equals(frames[0].frame)) return frames[0].content
    return Buffer.alloc(0)
  }
  check('解到文件尾失败时保留可解帧', decompressZstdFrames(raw, decoder).toString('utf8'), 'ok')
}

//#endregion

if (failures.length > 0) {
  console.error(`zstd-test 失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('zstd-test 通过')
