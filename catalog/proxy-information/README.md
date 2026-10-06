# Proxy 信息内容源

本目录维护教程和历史，审阅通过后由 Gian-Proxies 的 Catalog 工作流编译发布。Catalog 1.8.0 使用兼容 v1 的正文投影，不改变 Proxy 版本、签名密钥或运行中的 App。本机基本信息样例不是静态发布状态。

## 先看哪些文件

| Proxy | 基本信息与状态样例 | 产品教程 | 版本历史 |
| --- | --- | --- | --- |
| Claude Code | [基本信息](claude/basic.md) | [中文](claude/tutorial.md) / [English](claude/tutorial.en.md) | [版本更新](claude/changelog.md) |
| Codex | [基本信息](codex/basic.md) | [中文](codex/tutorial.md) / [English](codex/tutorial.en.md) | [版本更新](codex/changelog.md) |
| Kimi Code | [基本信息](kimi/basic.md) | [中文](kimi/tutorial.md) / [English](kimi/tutorial.en.md) | [版本更新](kimi/changelog.md) |
| DeepSeek Harness | [基本信息](ai.deepseek.harness/basic.md) | [中文](ai.deepseek.harness/tutorial.md) / [English](ai.deepseek.harness/tutorial.en.md) | [版本更新](ai.deepseek.harness/changelog.md) |
| ZCode | [基本信息](com.zhipu.zcode/basic.md) | [中文](com.zhipu.zcode/tutorial.md) / [English](com.zhipu.zcode/tutorial.en.md) | [版本更新](com.zhipu.zcode/changelog.md) |
| Grok Build | [基本信息](grok/basic.md) | [中文](grok/tutorial.md) / [English](grok/tutorial.en.md) | [版本更新](grok/changelog.md) |

先读 Claude 的完整流程，再看 DSH 的依赖关系、ZCode 的外部 App 例外与 Grok 的会话级 Runtime。六份教程均按同样的九个章节组织，但能力、运行方式和限制按各自实现撰写，不套同一份能力说明。

## 这份稿件的边界

- 基本信息只保留 Runtime 路径、Runtime 版本、Proxy 版本三项。各 basic.md 中的状态样例是给审阅者看的，不会作为一整页额外字段塞进 UI。
- 教程正文面向使用 Gian 的用户。源码、证据与迁移规则集中在本目录的附录，不要求用户理解认证矩阵才能操作。
- 发布组合快照使用已发布的 Proxy 认证记录，并保留上一份签名 Catalog 的未更新组合，不表示这台机器已经安装该 Runtime。
- 版本历史合并同版本的新旧仓库分发，不把迁移当成新的 Proxy 版本。已撤回的 0.4.0 不作为可用版本。
- 旧 Release 多数只有整仓库比较链接，不能当作某个 Proxy 的详细变更记录。历史版本的发布日期、协议、CLI 声明均有证据；无法准确归因的功能变更明确标为未记录，不能补写想象中的“新增/修复”。
- Grok 0.3.5 已完成独立准入；Catalog 只声明 Grok CLI 1.0.41 真实 stdio 暴露的能力。

## 审阅重点

1. 用户能否从教程独立完成安装、创建 Agent、配置 HOME、首次登录和更新？
2. 能否区分 Gian Proxy、厂商 Runtime 和 LLM 反向代理？
3. 能否看懂“Proxy 已有、Runtime 未安装”“新 HOME 尚未登录”和“上游 Runtime 不兼容”的区别？
4. DSH Bridge、Kimi 的不同发行版本、ZCode 已知限制是否说清楚？
5. 版本历史是否具体、可追溯，是否把未知历史诚实地留作未知？

## 给实现与发布使用的文件

- `localizations.json`：六个 Proxy 的中英文名称与简介。`tutorial.md` 是中文，`tutorial.en.md` 是英文；`history-copy.en.json` 维护历史说明的英文翻译，日期、版本、摘要与证据仍只来自原 `changelog.json`。
- 双语编译输出增加签名资产 `catalog-localizations-v1.json` 和 `docs/<pluginId>/<locale>/*.md`，不改变旧 v1 索引字段。Gian 根据界面语言选 `en` 或 `zh-CN`，文档 URL 和缓存按语言隔离；旧 Catalog 没有双语资产时保留其原始内容，不伪造翻译。
- [信息与发布合同](CONTRACT.md)：字段来源、三段展示、校验规则、旧数据迁移和验收要求。
- 每个 Proxy 的 changelog.json：唯一的结构化历史内容源；changelog.md 是便于审阅的投影，不应独立维护两份历史。
- [内容校验器](validate.mjs)：核对当前版本唯一性、历史顺序、真实发行日期/摘要、九章结构及 Markdown 投影一致性。Catalog 发布工作流执行，失败阻止发布。
- [v1 正文投影](project.mjs)：setup 为教程第 1–4 章，usage 为第 5–8 章，troubleshooting 为第 9 章；现有界面依次渲染后得到完整教程。overview 发布完整版本历史 Markdown，独立版本更新视图仍需消费端接入。
- [证据说明](evidence/README.md)：取数范围、来源层级和已知缺口。
- [当前发布组合](evidence/current-combinations.json)：四个新版来自真实发布与认证记录，ZCode 保留上一份签名 Catalog 的组合。
- [公开 Release 记录](evidence/releases.json)、[历史 Manifest](evidence/manifests.json)、[DSH Bridge 版本](evidence/dsh-bridge-versions.json)。

发布时复制 official-source 到临时目录，再由本目录生成四份正文，覆盖旧占位内容；不在旧 strict schema 中加入新字段。完整历史的维护索引仍为 changelog.json，当前签名资产只承载其 Markdown 投影，不冒充已经支持新的 wire-level release index。basic.md、CONTRACT.md 和 evidence 是维护与审阅材料，不作为用户机器的基本信息发布。

历史编号有空缺时不补造未发布版本。本稿列出 52 个唯一版本、55 次公开分发；其中 28 个旧版本尚不足以恢复完整的功能变更说明，均显式保留证据边界。

校验器默认只读；显式传 --render 才从 changelog.json 重新生成 changelog.md。依赖复用仓库已锁定的 SemVer 与 Markdown parser，不需要新增一套依赖版本。
