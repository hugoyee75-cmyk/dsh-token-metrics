# 更新日志

本文件记录本项目的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-19

首个公开版本。

### 新增

- **Host 侧用量采集**：监听 `session/event` 与 `llm/stream` 两条通路，覆盖主会话、子代理、teammate、workflow 子会话、压缩与会话标题生成
- **启动回扫**：三条通路补算历史，其中一条直接从磁盘读取 `.jsonl.zstd` 会话日志，不依赖任何 Host 服务
- **Client 侧统计页**：侧边栏入口 + 独立面板，含总计、今日 / 近 7 天 / 全部、明细表多视图
- **图表**：可切换的主趋势图（总量 / 命中率 / 输入构成 / 按模型）+ 模型占比环形图，分类色自带亮暗两套值
- **缓存命中率**：按 `cacheRead / (cacheRead + input)` 计算，口径写在 README
- **多语言**：跟随 DSH 语言设置，运行时切换即时生效
- **账号维度**：只读读取登录账号与余额，带官方用量页入口
- **持久化**：`$DSH_HOME/token-usage/usage.json`，防抖写入 + 原子替换
- **自更新**：检查版本 → 下载 → 校验 → 备份 → 替换 → 热重载 → 失败回滚
- **热重载**：不重启应用即可换用新代码，失败时明确报错并回滚
- **HTTP 接口**：summary / flush / version / update.check / update.apply / reload / rebuild
- **测试**：Host 集成、Client 冒烟、更新器三套，外加与真实会话日志的独立比对脚本

### 设计取舍

- **失败请求默认不计入 token。** 所有适配器在 `assistant/attempt` 路径上都只上报 `{0,0,0}` 的 usage。保留该通道，上游开始上报真实用量后无需改代码即可生效
- **数据一致性存疑时绝不丢弃历史。** 只标记 `needsRebuild`，回扫成功后才重建
- **更新源不可配置。** 地址固定来自 `package.json` 的 `repository`，避免配置项变成任意代码执行入口

[0.2.0]: https://github.com/hugoyee75-cmyk/dsh-token-usage/releases/tag/v0.2.0
