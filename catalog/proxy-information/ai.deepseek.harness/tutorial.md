# DeepSeek Harness

## 1. 在 Gian 中做什么

DeepSeek Harness Integration 把 DSH 的 Agent 运行时接入 Gian。它不是直接向一个模型端点发请求的薄聊天客户端；Gian 需要 Proxy、Bridge、DSH 程序及其 profile 共同工作。

你在 Gian 中选择工作区与任务配置，DSH 按自身的 Agent/Provider 模型执行。Provider、Model、Reasoning 与 Agent Preset 不能被合并成一个含义模糊的“模型名称”。

## 2. 支持的能力与限制

- 支持文本任务、原生状态重放、配置解析、思考、用量、Step 和 Request 事件。
- 受信的已有 Gian Session 可以通过绑定证明恢复；这不等于允许任意导入一个外部 DSH 原生 Session ID。
- 权限交互只有在 Bridge 真正宣告并能往返原生请求时才提供。权限预设来自 DSH，不是 Gian 另外发明的一套审批含义。
- 当前不宣告任意原生历史发现/删除、会话重命名、图片/普通文件附件、旁路对话或分叉。某个内部方法存在，不等于 Host 已获得对应公开能力。
- 自定义项清单会区分可读取、部分可见与上游不支持；不能把不支持当成“配置不存在”。

不要把所有工具活动都渲染成成功，也不要在无 Bridge 证据时宣称用户问题或 MCP 服务已完整接入。

## 3. 运行原理与进程关系

```text
Gian Host
  -> DSH Proxy（gian.proxy）
      -> DSH 进程的 gian profile
          -> @gian/dsh-bridge（gian.dsh.bridge/1.0）
              -> DSH 原生会话、Agent、Provider 与模型服务
```

Proxy 的进程范围为 shared。Bridge 运行在 DSH profile 中，负责把 DSH 原生行为转成明确的桥接协议，再由 Proxy 转成 Gian 协议。Bridge 不是网络反向代理，也不是另一个由用户选路径的 CLI。

进程、绑定证明和原生 Session 所有权一起约束恢复流程。发现其他活动所有者时不能抢占；关闭 Gian 会话也不应顺便删除厂商历史。

## 4. 安装与依赖

完整依赖包括 Gian 提供的 Node 环境、受管 DSH Runtime、DSH Proxy，以及与之配套的 Bridge/profile。新仓库发行的 DSH Proxy 自带对应 Bridge，不再依赖等一次 App 发版来提供它。

```text
<dataDir>/runtimes/deepseek-harness/<runtime-version>/<artifact-sha256>/
  node_modules/@deepseek-ai/dsh/lib/bin.js

已校验的 DSH Proxy 安装目录/
  proxy.mjs
  bridge/
```

这些是程序组件，不是账号配置。Gian 以签名 Catalog 的完整归档与安装计划安装；不要在受管目录手工 npm update，也不要随意替换 Bridge。更新时即使某个组件版本没变，也要确认它属于当前完整组合。

在首次实际启动前，Proxy 会为选定 DSH_HOME 准备/核对 gian profile，使 Bridge 可以被解析。这个受控 profile 与用户选择的模型服务配置不是一回事。

## 5. 第一次使用

1. 安装 DeepSeek Harness Integration，等待 Proxy、DSH Runtime 和必要依赖全部通过检查并激活。
2. 添加 Agent，选择新的托管 HOME 或明确复用的已有 DSH HOME。
3. 打开此 Agent 的 CLI 维护终端，按 DSH 当前版本支持的方式配置 Provider。不要把一个在其他 profile 中可用的配置自动视为 gian profile 已配置。
4. 返回 Gian，确认 Provider、Model、Reasoning 和 Agent Preset 的实际选项；选项由运行中的 DSH/Bridge 提供。
5. 在小范围工作区任务中检查工具、权限预设和完成事件。安装完成并不意味着 Provider 账号配置已完成。

若 Bridge/profile 启动失败，先保留错误和目录状态，修复依赖后再试；不要创建一个空原生 Session 冒充原会话恢复。

## 6. HOME 与隔离

Gian 使用 DSH_HOME 指向 Agent 状态目录：

```text
<dataDir>/homes/ai.deepseek.harness/<agentId>/
  profiles/gian/
```

DSH 的 HOME/profile 保存配置、认证和会话资料，具体文件由 DSH 版本管理。Bridge 所在的 Proxy 归档则属于程序组件。两者不能混放或通过互相复制来“修好依赖”。

不同 Agent 默认有独立 HOME；同一已有 HOME 会共享对应厂商状态。Gian 不自动清空自定义 HOME；使用已有 HOME 前应明确它会被 CLI 和受控 profile 准备逻辑正常读写。HOME 隔离不替代工作区权限或 DSH 的执行策略。

## 7. 反向代理与自定义端点

自定义端点属于 DSH 的 Provider 配置。应在选定 HOME、实际使用的 gian profile 下，按当前 DSH 版本支持的配置格式设置，并确认模型与该 Provider 的关联。

不要把 Bridge 的 stdio 地址或 Gian Catalog 地址当成模型 Base URL。DSH 可以有自己的 Provider 和 Agent Preset 层，不能把其他 CLI 的环境变量名字照搬过来并声称等价。

先验证 DSH 本身能读取这份 Provider 配置，再排查 Bridge/Proxy。凭据保留在厂商配置机制中，不写入 Catalog、Proxy Manifest 或分发归档。

## 8. 操作注意事项

- 更新是一组组件的协同更新，不是单独升级 npm 包；新旧 Bridge 混用可能造成协议或配置错误。
- 不手改原生 Session ID、绑定证明或 profile 链接来强行接管另一个进程的会话。
- Provider/Model/Reasoning 和会话绑定的 Agent Preset 要按其真实作用域使用；改变一项可能需要重新解析其他选项。
- 不通过“Full access”之类名称猜测权限。应看 DSH 当前返回的原生预设与实际请求。
- 日志应包含失败阶段和组件版本，但不能包含完整 Provider 配置、账号文件或 HMAC 材料。

## 9. 故障排查

| 现象 | 先检查 | 下一步 |
| --- | --- | --- |
| 找不到 @gian/dsh-bridge | 是否使用完整的已发布 Proxy 包 | 恢复完整包或重装该 Integration，不单独复制未知 Bridge |
| gian profile 无法启动 | profile 是否完整、组件是否配套 | 使用正常安装/启动流程修复，保留原 HOME |
| 模型或 Provider 为空 | 当前 HOME 和 gian profile 的 Provider 配置 | 在同一维护终端配置，而不是修改另一个 profile |
| 原生会话恢复被拒绝 | 是否有其他活动所有者、绑定是否属于 Gian | 正常结束旧所有者；不要绕过绑定证明 |
| 文件/图片或分叉不可用 | 当前公开能力是否宣告 | 按已支持文本与工作区工具流程操作，不静默丢附件 |
| 权限交互缺失 | Bridge 是否宣告并实现原生交互 | 不强行增加权限标签；提交脱敏协议/版本证据 |
| Node/程序启动报错 | Gian Node、DSH Runtime、Bridge 完整性 | 按错误阶段恢复认证组合，不改用户全机 Node 来掩盖问题 |
