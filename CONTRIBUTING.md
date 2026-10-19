# 贡献指南

感谢你愿意改进 dsh-token-usage。

## 开发环境

只需要 Node.js，没有依赖需要安装，也没有构建步骤：

```bash
node --version    # 需要 ^22.19.0 或 >=24.0.0
npm run check     # 语法检查 + 全部测试
```

提交前请确保 `npm run check` 通过。

## 提 Issue

用仓库的 Issue 模板。描述问题时请附上：

- DSH 版本与 Node 版本
- 现象，以及你期望的结果
- 复现步骤；能贴日志最好
- 如果是页面问题，说明语言设置与主题（亮色 / 暗色）

**不要**在 Issue 里贴凭据、token 或完整的会话日志——里面有你的对话内容。

## 提 PR

- 一个 PR 做一件事，标题用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀
- 新增行为请补测试，测试放在 `test/` 下
- 改了配置项、接口或统计口径，请同步更新 `README.md` 与 `README.en.md`
- 保持零运行时依赖：新增依赖前先开 Issue 讨论

## 代码风格

仓库没有引入 lint 工具，靠以下约定：

- ES modules，2 空格缩进，不加分号（跟随现有代码）
- 注释解释**为什么**，而不是复述代码在做什么
- 面向用户的文案同时提供 `zh` 与 `en` 两份，键名必须一致（有测试把关）

`.editorconfig` 已配置好常见的编辑器规则。

## 测试

```bash
npm run check     # 全套
npm test          # Host + Client + 更新器
npm run verify    # 与真实会话日志独立比对，需要宿主正在运行
```

前三个不需要宿主，CI 里跑的就是它们。`verify` 需要读本机会话日志，因此不进 CI。

改统计逻辑时，建议同时跑 `npm run verify`：它把插件算出的数字和直接从会话日志算出的数字做比对，能发现自测覆盖不到的偏差。

## 提交信息

用 Conventional Commits 风格，说明「为什么」而不只是「改了什么」：

```
fix(host): 回扫失败时保留现有数据而不是清零

原实现检测到 calls 与去重键数不符就直接重建，而重建依赖
sessionPersistence；该服务不可见时历史数据会永久丢失。
现在只标记 needsRebuild，回扫成功后再生效。
```

## 许可

贡献的代码按 [MIT](LICENSE) 授权。
