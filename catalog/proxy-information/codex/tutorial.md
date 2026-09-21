# Codex

## 1. 在 Gian 中做什么

Codex Integration 把 Codex app-server 的会话、模型选择、工具活动、审批与历史接入 Gian。你使用 Gian 的工作区和会话界面，实际任务由受管 Codex CLI 执行。它不依赖正在运行的 Codex Desktop，也不是通过网页或终端画面抓取回答。

Gian Proxy 负责协议适配；模型 Provider、服务端点和认证由 Codex 在该 Agent 的配置环境中处理。

## 2. 支持的能力与限制

- 支持文本、图片和已宣告的 Skill 输入，以及会话重命名、原生会话发现与历史重放。
- 支持旁路对话、会话分叉、可用 Turn 边界分叉和 turn.steer；动作能否立即使用，还受会话状态、分叉边界和交互状态限制。
- 支持权限/问题交互、思考、Plan、Diff 和用量事件。Fast 等选项来自当前 Runtime 能力与模型配置，不保证所有模型都支持。
- 支持已协商的 Gian MCP Host 服务及协议 2.3 的只读自定义项清单；不能把“CLI 能运行某工具”推导为所有 Host 服务均获授权。
- 不宣告通用 input.localFile 和原生历史删除。让 Codex 在授权工作区读取文件，与通过协议发送一个任意文件附件是两回事。

不要用过去某个版本的固定模型列表替代当前 app-server 返回结果；服务配额或模型能力变化仍可能使一个可选模型暂时不可用。

## 3. 运行原理与进程关系

```text
Gian Host
  -> 可复用的 Codex Proxy
      -> Codex app-server --listen stdio://
          -> 原生线程与模型服务
```

Proxy 的进程范围是 shared，可在对应启动绑定内服务多个 Gian 会话。它与 app-server 通过结构化 stdio 协议通信，再把原生线程、Turn、工具和交互投影为 Gian 事件。

shared 不表示所有 Agent 必须共用同一个 HOME，也不承诺整台电脑永远只有一个 app-server。程序身份、配置环境和会话身份是不同维度；Gian 必须按实际启动绑定保持隔离。旁路对话使用独立线程，不污染父会话历史。

## 4. 安装与依赖

在 Agent Integrations 的 Codex 详情执行“安装”。Gian 获取签名 Catalog 指定的 Proxy 和 CLI 归档，校验大小、摘要、Manifest 与安装计划，解压并检查实际版本后激活。

```text
<dataDir>/runtimes/codex/<runtime-version>/<artifact-sha256>/bin/codex
```

这是 Gian 的程序目录，不是系统 PATH 中的 Codex 或 Codex Desktop 的安装目录。不要替换二进制，也不要手工把另一个 Codex 程序链接到这里。当前实际托管版本以 Catalog 组合为准，不能把 Manifest 的历史兼容列表当作用户可任意选择的版本菜单。

Node 运行环境由 Gian App/Host 提供。网络受限时，安装应显示明确阶段和错误；不得为了通过安装而关闭签名或完整性检查。

## 5. 第一次使用

1. 安装 Codex Integration，确认受管 Runtime 已激活。
2. 添加 Agent，选择新建托管 HOME，或明确选择要复用的已有 Codex HOME。
3. 从这个 Agent 打开 CLI 维护终端，按 Codex 的官方流程登录或配置 Provider。普通 Gian 对话不是登录表单。
4. 返回 Agent 详情，确认程序与配置状态；新 HOME 没有继承另一个 Agent 的登录是正常现象。
5. 选择工作区创建会话，核对模型、思考强度和权限模式；需要 Fast 时先确认当前 Runtime/模型确实提供该选项。
6. 先执行一个范围小的任务，观察真实审批、Plan/Diff 与完成状态，而不是只凭“请求已发送”认定任务成功。

本地原生会话发现也受 HOME 范围限制。找不到另一 HOME 的线程，不代表历史被删除。

## 6. HOME 与隔离

Gian 通过 CODEX_HOME 指向 Agent 选定的 Codex 状态根。托管目录为：

```text
<dataDir>/homes/codex/<agentId>/
```

这里承载该 CLI 的配置、登录状态和原生会话资料。多个 Agent 共享程序版本，但不默认共享 HOME。选择同一 Custom HOME 意味着主动共享其厂商状态。

HOME 不是沙箱。工作区访问、命令执行和网络等权限仍由 Codex 的策略与 Gian 的授权边界控制。不要把工作区中的项目配置、系统安装目录和 CODEX_HOME 当成同一个东西。

Gian 不要求把现有账号凭据复制到新目录；你可以在新 HOME 正常登录，或明确选择已有 HOME。已有会话保持原来的 HOME 绑定。

## 7. 反向代理与自定义端点

在这个 Agent 的 CODEX_HOME 中使用当前 Codex 支持的 Provider/端点配置，或在其维护终端完成官方配置流程。不要改 Gian Catalog 地址，也不要用自定义 CLI 路径替换受管安装。

核对模型标识、接口协议、认证方式和流式行为。只声称兼容 Chat Completions 的服务，不能直接当成完整兼容 Codex 所需的接口；工具、思考和用量也可能有差异。先确认同一 HOME 中的 Codex CLI 可以使用该 Provider，再排查 Gian 适配层。

配置文件和日志中的 Token/API Key 不应进入源码、截图或 Issue。不同 Agent 使用不同 HOME 配置端点，不依靠修改全机环境变量切换所有会话。

## 8. 操作注意事项

- 更新改变同类 Agent 使用的全局认证组合；不单独追逐 CLI 的 latest。
- 活动 Turn 和维护终端会让更新等待；队列中的消息应等待更新完成后继续，而不是被当成永久占用者。
- 分叉和旁路对话要使用界面提供的边界，不手改原生线程 ID 或把父子线程混为一个会话。
- 不把工具卡片出现等同于工具成功；错误和权限请求应按原生结果处理。
- 旧 Runtime 保留不等于可以任意回滚已被新版迁移的 HOME 数据。升级失败先保留日志和原生历史。

## 9. 故障排查

| 现象 | 先检查 | 下一步 |
| --- | --- | --- |
| Runtime 未安装但 Proxy 版本可见 | 源码开发 Proxy 与激活组合是否被混淆 | 安装完整 Integration，核对 Host 状态 |
| 模型为空或出现容量/配额错误 | 当前 HOME 的 Provider 和服务状态 | 用同一维护终端检查，不替换成另一个 HOME |
| Fast 不出现 | 当前模型与 Runtime 是否提供该选项 | 接受能力约束，不硬塞未宣告配置 |
| 原生历史找不到 | Agent/会话绑定的 CODEX_HOME | 回到原 HOME；不要重建线程来伪装恢复 |
| 普通文件附件被拒绝 | 是否属于已宣告输入类型 | 在授权工作区引用/读取文件，或使用受支持输入 |
| 分叉或 Steer 被拒绝 | Turn 状态、边界、待处理交互 | 按界面允许的动作继续，不绕过生命周期约束 |
| 更新等待或失败 | 同类运行中任务、终端、错误阶段 | 结束占用并重试；不删除锁、收据或原生历史 |
