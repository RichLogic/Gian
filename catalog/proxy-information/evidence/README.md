# 证据说明

取数时间：2026-09-20。这里只保存公开发行元数据、公开 Manifest 和已验签 Catalog 的事实快照，不保存账号、HOME 内容、凭据或签名私钥。

- releases.json：遍历 RichLogic/Gian 的全部 Release 页，并读取 Gian-Proxies 的发行页；仅保留五个 shipping Proxy 的非 draft、非 prerelease 记录。当前共 49 条分发记录。
- manifests.json：下载这 49 条记录中的 Manifest sidecar，并逐个核对 GitHub 资产提供的 SHA-256。包含旧推荐 CLI 字段和新 verifiedVersions，保留二者区别。
- current-combinations.json：来自此前下载并验证签名的 catalog-v1.7.0；它是当前托管目标的依据，不是本机激活状态。
- dsh-bridge-versions.json：从对应旧公开 Git tag 的 dsh-bridge/package.json 读取版本；这只能证明源码组合，不能替代归档完整性或真实运行证据。

旧 Release 的 body 多为自动生成的跨 Proxy 比较链接，例如从 Claude tag 比较到 Codex tag。这样的链接不能直接作为 Codex 的用户变更说明。changelog.json 只采用可归因的 Manifest 差异、已确认的源码修复及公开发行事实；其余标为 metadata-only。

当前源码参考：

- capabilities：各 Proxy 的 protocol/v2-adapter.ts；ZCode 的 identity.ts 与 adapter.ts。
- HOME：packages/host/src/agents/home.ts。
- 安装布局：packages/proxy-protocol/src/runtime-install.ts 与各 Proxy runtime/install.ts。
- 真实目标组合：current-combinations.json。
- Kimi 0.3.2：4f145332、b6191ced、763ed833 及公开当前源码。
- ZCode 0.3.2：6af05744 与 Issue #163。
- DSH 新仓库分发的 Bridge：9b39f25c、packages/proxies/dsh-proxy/package.json 的 bundlePackages 与 runtime/profile.ts。

教程描述的是源码已实现的能力与边界，不宣称本轮重新运行了安装、模型调用、历史恢复或 UI 测试。旧 README 中“协议仅 2.1”“当前 ZCode 0.1.1”等表述不作为当前版本事实。
