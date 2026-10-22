/**
 * 接口来源校验（安全门卫）的自检。
 *
 * 为什么单独成一个测试文件：评审实测发现插件路由**绕过了** DSH 对自家
 * API 的来源检查 —— 带恶意 Origin 的请求打 DSH 接口返回 403，打插件接口
 * 返回 200。这意味着用户打开任意恶意网页就能：偷已存的 API Key（
 * /supplier/models 接受任意 baseUrl + 站点 id）、改模型配置、触发更新。
 *
 * 原有测试把 webServer 设成 undefined，HTTP 层完全没被覆盖，所以这个洞
 * 一直没被发现。这里直接单测门卫函数，不依赖真实 HTTP 服务。
 */

import { isTrustedRequest } from '../index.js'

const failures = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const req = (headers) => ({ headers })

// —— 必须拒绝：跨站浏览器请求 ——
check('恶意 Origin 被拒', isTrustedRequest(req({ origin: 'https://evil.example.com' })), false)
check('跨站 Sec-Fetch-Site 被拒',
  isTrustedRequest(req({ 'sec-fetch-site': 'cross-site' })), false)
check('跨站 + 伪造回环 Origin 仍被拒',
  isTrustedRequest(req({ origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'cross-site' })), false)
check('空 Origin 字符串按无 Origin 处理',
  isTrustedRequest(req({ origin: '' })), true)
check('畸形 Origin 被拒',
  isTrustedRequest(req({ origin: 'not a url' })), false)
check('file:// Origin 被拒',
  isTrustedRequest(req({ origin: 'file:///tmp/x.html' })), false)
check('外部 https Origin 被拒',
  isTrustedRequest(req({ origin: 'https://attacker.ngrok.io' })), false)

// —— 必须放行：同源 / 非浏览器 ——
check('无 Origin（同机 CLI）放行', isTrustedRequest(req({})), true)
check('127.0.0.1 Origin 放行',
  isTrustedRequest(req({ origin: 'http://127.0.0.1:53536' })), true)
check('localhost Origin 放行',
  isTrustedRequest(req({ origin: 'http://localhost:53536' })), true)
check('IPv6 回环 Origin 放行',
  isTrustedRequest(req({ origin: 'http://[::1]:53536' })), true)
check('same-origin 标记放行',
  isTrustedRequest(req({ origin: 'http://127.0.0.1:53536', 'sec-fetch-site': 'same-origin' })), true)
check('same-site 标记放行',
  isTrustedRequest(req({ origin: 'http://127.0.0.1:53536', 'sec-fetch-site': 'same-site' })), true)
check('none（地址栏直开）放行',
  isTrustedRequest(req({ origin: 'http://127.0.0.1:53536', 'sec-fetch-site': 'none' })), true)

// —— 边界：headers 缺失不应抛错 ——
check('无 headers 不抛错', isTrustedRequest({}), true)
check('null 请求不抛错', isTrustedRequest(null), true)

if (failures.length > 0) {
  console.log('失败：')
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exit(1)
}
console.log('✓ 接口来源校验全部断言通过')
console.log('  恶意 Origin / 跨站 Sec-Fetch / 畸形 Origin 全部拒绝；同源与同机请求放行')
