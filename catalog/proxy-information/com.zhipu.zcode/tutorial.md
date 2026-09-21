# ZCode

## 1. 在 Gian 中做什么

ZCode Integration 连接 ZCode.app 内嵌 Runtime，把其编码会话与模型配置投影到 Gian。它不是控制 ZCode Desktop 窗口，也不读取正在运行的桌面应用私有通信通道或账号 Token。

ZCode 是外部 App 例外：Gian 管理自己的 Proxy，但不拥有 ZCode.app 的安装和更新。CLI 自报版本相同，并不保证两个 App 构建拥有相同资源、协议和独立运行能力。

## 2. 支持的能力与限制

- 当前适配器提供文本会话、配置解析、原生会话发现、历史重放、思考与用量事件。
- 权限交互受运行时和 Proxy 配置限制；模型、Provider、Thinking 等选项以该 Runtime 实际返回的目录为准。
- 不宣告图片/普通文件附件、重命名、原生历史删除、旁路对话、分叉、Steer 和 Gian MCP 集成。不要把 ZCode Desktop 自身支持的功能全部当作 Gian 已接入。
- 工具行为以活动事件展示，不补造不存在的 Step/Request 协议能力。

已确认的上游限制必须单独说明：ZCode.app 3.12.3 曾破坏独立嵌入启动所需的内置配置资源定位，并改变原生方法与 Provider 注入方式。Proxy 0.3.2 增加失败前置诊断，不代表这些上游问题已修复。后续 App 构建是否恢复可用，需要重新验证，不能只看仍然报告 0.16.5。

## 3. 运行原理与进程关系

```text
Gian Host
  -> shared-scope ZCode Proxy
      -> 按 canonical workspace 组织的 app-server Runtime 池
          -> ZCode.app 内嵌 zcode.cjs
              -> ZCode 原生 Session、Provider 与模型服务
```

内层使用 ZCode Protocol 的结构化 stdio 通信，外层使用 Gian Proxy 协议。相同工作区可以复用对应内层 Runtime；不同工作区的进程故障应保持隔离。共享 Proxy 不代表所有工作区只有同一个内层进程。

Gian 的关闭操作采用 detach 语义：解除订阅与所有权，不把原生 close/delete 当作普通退出。某些 ZCode 原生 close 行为会删除空会话，因此不能直接把外层关闭映射成删除。

## 4. 安装与依赖

先由用户正常安装并配置 ZCode.app。Gian 只在受支持的标准 App 位置发现其内嵌 Runtime，例如 /Applications 或用户 Applications 目录。具体使用路径由 Host 发现和校验，不接受用户手填任意可执行路径。

在 Gian 中执行 ZCode Integration 的安装/准备，表示下载 Gian Proxy 并发现、校验已有外部 Runtime；不表示下载安装、镜像、升级或降级 ZCode.app。

典型内嵌入口是：

```text
<已验证的 ZCode.app>/Contents/Resources/glm/zcode.cjs
```

最终入口仍以实际发现结果为准。资源布局、指纹和独立启动能力都是兼容边界，不能仅比较一个 CLI 版本字符串。Gian 的 Node 启动支持不等于可以绕过 ZCode 私有桌面上下文。

## 5. 第一次使用

1. 安装 ZCode.app，并使用其官方方式完成 Provider 配置。
2. 在 Gian 的 ZCode 详情进行发现/准备，查看是否报告明确的上游不兼容或缺失资源。
3. 仅在 Runtime 检查通过、能返回实际配置目录后，继续创建 ZCode Agent。
4. 在小范围工作区检查模型目录、权限交互与文本任务。
5. 若安装的是已知无法独立嵌入的 App 构建，先处理上游兼容问题，不用“换一个 API Key”或清空历史假装修复启动。

本稿不宣称当前机器或任意最新版 ZCode 已经通过真实模型验收。程序可启动、目录非空和一次模型任务成功是不同检查点。

## 6. HOME 与隔离

ZCode 的状态由外部应用及其官方配置目录管理，常见根为 ~/.zcode。它不提供与 Claude/Codex/Kimi/DSH 相同的 Gian-managed HOME 或 Custom HOME 隔离。

创建多个 Gian ZCode Agent，不应被描述成创建了多个独立 ZCode 账号或配置空间。也不要把其他 Agent 的 HOME 环境变量套到 ZCode 上。

Gian 不负责生成、迁移、删除或修补外部 App 的私有账号状态。保持原生历史；不要通过从运行进程提取凭据、修改桌面私有配置或复制 Token 来满足独立 Runtime 的启动条件。

## 7. 反向代理与自定义端点

只使用 ZCode 官方 Provider 配置支持的端点与认证方式。Gian 不提供第二条外部 CLI 路径，也不向 ZCode Desktop 私有服务索取认证头。

桌面应用里配置可用，不一定意味着独立 app-server 暴露了同样的 Provider 初始化方式。若独立运行返回空模型目录，应先核实上游是否提供这个公开嵌入合同，而不是把桌面内存里的配置或令牌导出给 Gian。

Gian Proxy、ZCode Provider 配置和模型反向代理是三层不同的概念。自定义端点无法修复 App 资源布局错误或已移除的协议方法。

## 8. 操作注意事项

- ZCode.app 的自行更新可能改变 Runtime 字节和资源，即使 CLI 版本字符串没有变化。
- 发现指纹变化或独立启动错误时，应暂停使用并报告明确原因；不自动替换成不受支持路径。
- 如需固定旧 App 构建，应由用户通过可信来源作出选择；Gian 不在后台下载或降级它。
- 不删除空/旧原生会话作为启动故障的修复步骤。普通 detach 与原生数据删除不能混淆。
- 历史验证证明的是指定构建和当时能力，不是对所有未来 App 版本的承诺。

## 9. 故障排查

| 现象 | 先检查 | 下一步 |
| --- | --- | --- |
| 未检测到 ZCode.app | 是否位于受支持的标准 App 目录 | 通过正常 App 安装流程处理，再重新发现；不输入任意 CLI 路径 |
| 内置 Provider 配置找不到 | App 构建与资源布局是否属于已知限制 | 使用可验证的受支持构建或等待上游修复，不伪造资源文件 |
| app-server 能启动但模型目录为空 | 上游是否支持独立 Provider 初始化 | 向上游确认公开能力；不从 Desktop 进程提取 Token |
| CLI 仍是同版本但 Gian 拒绝启动 | App 字节、资源或协议是否改变 | 保留诊断并重新验证，不只改版本白名单 |
| 附件、分叉或重命名不可用 | 当前 Proxy 是否宣告该能力 | 使用支持的文本/工作区流程，不把不可用操作当已实现 |
| 关闭后担心历史丢失 | 是否只是 Gian detach | 不另行调用原生删除；先通过官方工具核对历史 |
| 权限或官方认证请求不支持 | 原生方法是否在公开合同内 | 使用官方配置流程；不绕过账号边界 |
