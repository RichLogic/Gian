# Proxy 信息与发布合同

状态：内容维护合同。这里的 authoring schema 是内容维护格式，不擅自改变已发布的 Catalog wire schema。旧 Catalog 1.7.0 及其签名资产保持不变。

Catalog 1.8.0 的兼容发布范围：project.mjs 在临时编译输入中将九章教程依次投影到 setup（1–4）、usage（5–8）、troubleshooting（9），将完整历史 Markdown 放到 overview。发布前验证 changelog.json 与 Markdown 一致、历史顺序、九章完整性以及实际认证 Runtime 组合。所有正文沿用 v1 的签名资产清单。新 wire-level 版本索引、独立历史视图和 Host 基本信息状态改造不属于此次内容发布；后面的接入要求仍适用于这些后续能力。

## 1. 单一信息来源

| 信息 | 权威来源 | 不应怎么维护 |
| --- | --- | --- |
| pluginId、名称、Proxy 版本、进程范围、协议范围 | 对应 Proxy 的 Manifest/package，发布时检查一致 | 在 README、Web 常量或 Catalog 手填另一套版本 |
| 本机当前 Runtime 路径/版本、当前 Proxy | Host 当前激活 generation、安装收据；源码开发状态要明确区分 | 把 Catalog 的最新版本当作已安装版本 |
| 待安装 Runtime 与下载坐标 | 签名 Catalog 的 certified combination 和 Proxy 安装计划 | 从“上游 latest”、PATH 或 prose 推导 |
| 第一次安装的目标位置 | Host 用当前 dataDir 与认证安装计划计算 | Web 拼接用户可编辑 CLI 路径 |
| 教程、注意事项、排障 | 人工维护的 tutorial.md，经源码和行为证据核对 | 直接复制过时 README 或设计稿示例 |
| 版本历史 | changelog.json 中每个 Proxy 版本唯一的一条记录 | 将 App changelog 或跨 Proxy compare 链接冒充完整历史 |
| HOME | Host 的 Agent/Home 记录；ZCode 使用外部应用状态边界 | 写入签名 Catalog 或混入 Runtime 程序身份 |

当前教程不得枚举一张永远不变的模型表。可选模型、思考强度、模式和动作以当前 Runtime/Proxy 返回结果为准。能力清单须区分协议已实现、运行时条件成立和用户当前可用。

## 2. 基本信息展示

正文固定三行，顺序不得改变：Runtime 路径、Runtime 版本、Proxy 版本。名称和图标放在面板标题。不要把平台、Plugin ID、进程范围、Bridge 或认证矩阵重新塞进这三行。

- 已激活：显示 Host 收据中的当前值，不拿 latest 覆盖。
- 未安装：Runtime 版本显示“未安装”；路径显示 Host 返回的计划位置并明确“安装位置”。未有 Proxy 则 Proxy 版本显示“未安装”，目标版本属于安装预览，不能标“已安装”。
- 源码开发：可显示源码 Proxy 的实际版本，但应标明开发来源；不能因此宣称认证 Runtime 组合已激活。
- 更新：当前值仍显示旧组合；版本变化和 Update 放在三行后的操作区。未激活的新值不得提前替换当前值。
- ZCode：显示实际发现的 App 内嵌程序位置；未发现时显示“未检测到 ZCode.app”，不能编造一个已验证路径或下载目标。
- 路径只读；Copy 复制完整 canonical path。打开文件位置由 Host 执行，不接受 Web 任意路径。

basic.md 是状态样例，不是需要发布的静态本机状态。目标展示数据至少区分 current、candidate、origin 和 availability，避免仅有一个 version 字段。

## 3. 教程内容

每个 tutorial.md 固定九个二级章节：

1. 在 Gian 中做什么。
2. 支持的能力与限制。
3. 运行原理与进程关系。
4. 安装与依赖。
5. 第一次使用。
6. HOME 与隔离。
7. 反向代理与自定义端点。
8. 操作注意事项。
9. 故障排查。

九章是连续文档，导航只滚动定位，不隐藏其他章节。第三章必须对照当前源码；第七章不能假设不同厂商的 URL、认证头和协议可直接互换。第九章必须给出“现象 → 检查 → 下一步”，不能只有“检查配置”。

教程不得索取/展示凭据，不提供自动执行的远程 shell 命令，不承诺未经验证的上游版本、模型、平台或可回滚性。

## 4. 历史数据格式

changelog.json 顶层包含 schemaVersion、pluginId、currentVersion、entries、withdrawnVersions。每个 entries 项：

| 字段 | 类型/要求 | 含义 |
| --- | --- | --- |
| version | 稳定 SemVer，必填且唯一 | Proxy 版本，不是 App 或 CLI 版本 |
| firstPublishedAt | UTC ISO 时间，必填 | 该 Proxy 版本第一次公开发布的时间 |
| distributions | 非空数组 | 每次仓库分发的 tag、日期、URL、Manifest/归档摘要及 CLI 声明 |
| changes | 数组 | category、text、evidence；仅收录有证据的新增、变更、修复、注意事项 |
| evidenceCoverage | detailed / metadata-only | 历史说明是否已能精确归因 |
| unknowns | 字符串数组 | 不能从保留资料中证实的内容，明确显示而非编造 |

distributions 中的 Runtime 声明用 basis 区分 verified-declaration、recommended-declaration、unrecorded。这些声明都不能自动提升为完整认证组合。实际当前托管组合引用 current-combinations.json 对应 Catalog 坐标；历史组合只有找到当时的认证/Catalog 证据才能标为 certified。

同一版本在 Gian 和 Gian-Proxies 分发只保留一个 entries 项，各分发拥有自己的发布日期和 SHA-256。DSH 0.3.1 的新分发携带 Bridge，必须说明这个分发差异，而不能声称同版本不同来源的字节完全一致。

版本记录按 SemVer 从新到旧排列；日期保留原值，不为了排序改写发布日期。撤回版本在 withdrawnVersions 中单列，不提供安装操作。空的 Added/Changed/Fixed 分类不渲染。

## 5. 编译/发布必须阻止的错误

1. 当前 Manifest/package 版本在历史中没有记录，或出现多条。
2. 同一 pluginId 下重复版本、非法 SemVer、无来源的日期、重复分发 URL。
3. 当前组合的 Proxy/CLI/Bridge 与认证资产不一致。
4. 把 recommendedCliVersion 或历史兼容声明标成当前已安装/已认证组合。
5. 把已撤回的 0.4.0、draft、prerelease 或可变 latest/branch URL 当稳定可安装坐标。
6. 教程缺章、Markdown 含 HTML/script/style、越界文件、危险 URL、超限内容。
7. 新版本历史无事实说明；历史迁移项可以 metadata-only，但必须列明 unknowns，不能显示成“完整更新日志”。
8. 历史补录覆盖既有发布记录。更正须保留原来源、添加更正说明；不得改写已发布资产。

应使用已有 SemVer 与 Markdown parser，而不是通过字符串排序和 HTML 拼接实现。编译器产出需要把 tutorial 和 release-indexed changelog 都绑定到签名 asset manifest；Web 只渲染已验签且有界的内容。

## 6. 接入顺序

1. 先审核本目录正文、历史事实和字段分工。
2. 实现 authoring 编译输入；生成一份 tutorial 和有界、按版本索引的 history 投影。旧四文档可在迁移期间保留，但不得继续作为独立维护源。
3. 选择明确的 Catalog schema 兼容方案。旧客户端拒绝未知字段时，必须先具备消费端支持，不能把新字段硬塞进旧 strict schema。
4. Host 返回本机 current/candidate 状态；Web 保留三行 Basic，正文加载完整 tutorial 和 history，移除 changelogPending 占位。
5. 补齐结构化数据、签名、历史顺序、当前版本唯一性、迁移兼容、渲染安全及路径显示的检查。执行位置和测试范围由 Owner 选择。
6. 只在审核与所选验证通过后发布新的 Catalog 序列。文档修订不自动修改 Proxy 版本；若需消费端变更，App 发布独立进行。

## 7. 文件审阅验收清单

- 五个 shipping Proxy 均有完整九章，DSH 和 ZCode 不是普通 CLI 文案的换名版本。
- 用户能分清 Proxy 程序、厂商 Runtime、HOME 和 LLM 接口代理。
- 当前真实版本只来自结构化记录；不把“源码可运行”写成“发布组合已安装”。
- 历史以同一 Proxy 为边界；同版本分发合并；没有凭空补出的版本、日期和功能。
- 首次安装前的位置、安装后未登录、更新等待及失败保留状态均有具体样例。
- 只读文档和校验通过不等于真实 Provider、安装或 Desktop 验收通过。
