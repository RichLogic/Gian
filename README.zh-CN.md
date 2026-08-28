<p align="center">
  <img src=".github/assets/readme/gian-icon.svg" alt="Gian app icon" width="112" height="112">
</p>

<h1 align="center">Gian</h1>

<p align="center"><strong>在一个本地桌面工作区中使用 Codex、Claude Code、Kimi Code 和 DeepSeek Harness。</strong></p>

<p align="center">
  把 Agent 会话、审批、Tasks、worktree、文件、Diff 和终端集中到一个专注的 macOS 应用中。
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://github.com/RichLogic/Gian/releases/download/v0.5.3/Gian-0.5.3-arm64.dmg"><img src="https://img.shields.io/badge/Download_for_macOS-Gian_0.5.3-E4572E?style=for-the-badge&logo=apple&logoColor=white" alt="Download Gian for macOS Apple Silicon"></a>
</p>

<p align="center">
  <a href="https://github.com/RichLogic/Gian/releases/tag/v0.5.3"><img src="https://img.shields.io/badge/release-v0.5.3_beta-C65D3A" alt="Current Gian beta release v0.5.3"></a>
  <img src="https://img.shields.io/badge/platform-macOS_Apple_Silicon-1F2328?logo=apple" alt="Platform macOS Apple Silicon">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2F7D6D" alt="MIT License"></a>
</p>

<p align="center">
  <img src=".github/assets/readme/gian-overview.webp" alt="Gian desktop app showing grouped agent sessions, live tool execution, and file changes" width="100%">
</p>

## 为什么选择 Gian

- 在同一个桌面界面中使用 Codex、Claude Code、Kimi Code 和 DeepSeek Harness。
- 同时保留多个会话，在它们之间快速切换，不再来回翻找终端。
- 以结构化事件查看回复、计划、工具调用、命令、审批和错误。
- 用 Tasks 归纳相关会话，不在你和 Agent 之间加入自动化 Manager。
- 在仓库和隔离的 Git worktree 之间工作，随时查看 Files、Diffs 和 workspace 终端。
- 恢复官方 CLI 支持的原生会话，同时保留各服务商自己的登录、订阅、配置和计费方式。

## Beta 功能范围

当前 Beta 聚焦于可靠的本地编程闭环：

- 创建、发送、停止、排队、引导、压缩和清空 Agent 会话。
- 回答 Agent 的问题，批准或拒绝命令与工具调用。
- 在服务商支持时选择其原生模型、推理等级和权限模式。
- 附加文件与图片，查看实时 transcript 和当前上下文用量。
- 在内置 Browser 中打开项目页面，创建 Side Chat，并在明确的 Turn
  边界 Fork 支持该能力的 Agent 会话。
- 创建或接入 workspace，发现 worktree，查看改动文件和 Diff。
- 创建、重命名、置顶、完成、重新打开和删除 Tasks 及其分组会话。
- 发现并恢复官方 Agent CLI 支持的原生会话。
- 配置 AI Agents、外观、项目根目录和桌面通知。

当前 Beta 有意不包含自动化 Task Manager，以及 Discord/Slack Bots。

## 界面细节

### 用 Tasks 组织相关会话

<img src=".github/assets/readme/gian-tasks.webp" alt="Gian Tasks view with sessions grouped by release, quality, UI, and documentation work" width="100%">

### 在对话旁查看改动

<img src=".github/assets/readme/gian-changes.webp" alt="Gian Changes inspector listing unstaged dashboard files beside an agent conversation" width="100%">

## 安装 macOS Beta

Gian 当前是面向 **Apple Silicon 的 unsigned macOS Beta**。它尚未经过 Apple 公证，因此第一次打开时 macOS Gatekeeper 会给出提示。

1. 从[当前 Beta Release](https://github.com/RichLogic/Gian/releases/tag/v0.5.3)下载 [`Gian-0.5.3-arm64.dmg`](https://github.com/RichLogic/Gian/releases/download/v0.5.3/Gian-0.5.3-arm64.dmg)。
2. 打开 DMG，把 Gian 拖入 **Applications（应用程序）**。
3. 在 Finder 中按住 Control 点击 Gian，选择 **Open（打开）**，再在 Gatekeeper 对话框中选择一次 **Open（打开）**。
4. 如果没有这个选项，打开 **System Settings > Privacy & Security（系统设置 > 隐私与安全性）**，在 Gian 对应提示旁选择 **Open Anyway（仍要打开）**。

普通用户**不需要**安装 Node.js、pnpm，不需要克隆源码，也不需要单独安装 Gian 服务。

首次启动时，Gian 会依次引导你完成 GitHub 登录、Agent 配置和项目父目录选择。只要有一个 Agent 可用就能完成设置，其余 Agent 均为可选项。

## 支持的 Agents

| Agent | 官方运行时 | Gian 集成方式 |
|---|---|---|
| Codex | OpenAI Codex CLI | 共享 app-server Proxy |
| Claude Code | Anthropic Claude Code CLI | 结构化 print-mode Proxy |
| Kimi Code | Moonshot AI Kimi CLI | 共享 ACP Proxy |
| DeepSeek Harness | DeepSeek DSH CLI | 托管 Profile、Bridge 和共享 Proxy |

Gian 可以检测现有 CLI，也可以使用自定义可执行文件路径。如果 CLI 尚未安装，初始化流程可以启动服务商的官方安装器。Gian 会从同一个 GitHub Release 下载对应版本的集成 Proxy，并在启用前完成校验。

## 从源码构建

源码构建面向贡献者和开发者，需要 **Node.js 24 LTS**（`>=24 <25`）和 **pnpm 10**。

```bash
git clone https://github.com/RichLogic/Gian.git
cd Gian
pnpm install
pnpm build
pnpm dev
```

开发启动器默认使用 Gian 的公开 GitHub OAuth Client ID。Fork 可以显式覆盖：

```bash
GIAN_GITHUB_CLIENT_ID=<your-oauth-client-id> pnpm dev
```

仓库规范和开发检查请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 工作原理

```text
Official Agent CLI <-> Gian Proxy <-> Gian Host <-> Electron App
                                      |
                                      `-> local SQLite data
```

Electron App 会自动启动并管理内置 Host。Host 只绑定本机 loopback，把状态存储在本地，并使用每次启动生成的桌面凭据。Gian 自有 Proxy 把各官方 CLI 的结构化事件整理给界面；登录、模型权限、订阅和计费仍由官方 CLI 负责。

## 网络与隐私

- Gian 把数据库、下载的 Proxy 和日志保存在你的 Mac 本地，不使用 Gian 云服务。
- 登录使用 GitHub OAuth Device Flow。Gian 不申请 OAuth scopes，只读取账号公开资料，并使用 macOS 安全存储加密 token。
- Gian 会连接 GitHub Releases，下载版本化的集成 Proxy 和发布资源。
- Prompt、工具请求和模型响应通过官方 Agent CLI 及其服务商网络传输，Gian 不通过自有服务器中转模型流量。
- Agent 凭据、订阅、配置和原生会话数据继续由对应的官方 CLI 管理。

## 项目状态

Gian 正处于活跃 Beta 开发阶段。当前公开版本仅支持 macOS Apple Silicon，尚未签名；在稳定版之前，公开 API 和集成协议仍可能变化。

Bug 和功能建议请提交到 [GitHub Issues](https://github.com/RichLogic/Gian/issues)。所有公开构建可在 [Releases](https://github.com/RichLogic/Gian/releases) 查看。

## License

MIT，详见 [LICENSE](LICENSE)。
