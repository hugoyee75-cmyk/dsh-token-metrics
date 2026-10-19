# 安全说明

## 插件会碰什么数据

dsh-token-metrics 运行在 DSH 宿主进程内，并且刻意只读：

| 数据 | 用途 | 是否写入 | 是否外发 |
| --- | --- | --- | --- |
| 会话日志中的 usage 字段 | 统计 Token 用量 | 否 | 否 |
| 当前登录账号的昵称与余额 | 页面顶部展示 | 否 | 否 |
| 聚合结果 | 统计页数据 | 写入 `$DSH_HOME/token-metrics/usage.json` | 否 |

**插件从不读取凭据。** 账号信息通过宿主的 `deepseekAccount.getProfile` / `getBalance` 获取，这两个接口本身就不返回 token、密钥或密码。等 `trackAccount: false` 可完全关闭账号读取，只保留用量统计。

**插件不发起网络请求。** 唯一的例外是你主动触发更新检查（页面按钮或 `POST /api/dsh-token-metrics/update/apply`），此时它会访问 `package.json` 中 `repository` 字段指向的 GitHub 仓库。除此之外没有任何出站流量，用量数据不会离开本机。

## 更新通道的信任模型

自更新是本插件里安全面最大的一块，设计上做了这些约束：

- **更新源不可配置。** 地址固定来自 `package.json` 的 `repository` 字段，不接受来自配置或 HTTP 请求的 URL。这是刻意的：能让配置指向任意地址，就等于让一个字段写入变成在宿主进程里执行任意代码。
- **解压前检查路径穿越。** 下载的 tar 包中任何 `..` 或绝对路径条目都会被拒绝，避免文件被写到包目录之外。
- **替换前备份，失败即回滚。** 激活失败会把磁盘与运行时都恢复到先前状态，不留下半装状态。
- **激活校验版本。** 热重载用 `expectedVersion` 确认跑起来的是新代码，而不是缓存中的旧对象。
- **可选 sha256 校验清单。** 用于确认下载内容与发布时一致。

即便如此，自更新意味着**插件会替换自己的源码并重载**。如果你不接受这一模型，设 `autoUpdate: false` 关闭它，手动通过 `plugin_manager install_bundle` 升级。

## 报告漏洞

请**不要**公开提交安全 Issue。用 GitHub 的 [Report a vulnerability](https://github.com/hugoyee75-cmyk/dsh-token-metrics/security/advisories/new) 私下报告，或发邮件至仓库所有者。

请在报告中包含：

- 受影响的版本
- 复现步骤或 PoC
- 影响面：能否被远程触发、是否需要本地访问

我会尽快确认并回复。确认后会在 CHANGELOG 与 Release Notes 中致谢（除非你希望匿名）。

## 支持范围

安全修复只针对最新发布版本。插件通过热重载在运行时替换代码，因此升级成本很低，建议保持最新。
