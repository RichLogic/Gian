# 需求追踪 Summary（人工审阅版）

> 日期：2026-05-17。
> 本文件是 `docs/quality/traceability.md` 的人工审阅辅助，不是需求注册表。
> 规则不变：如果某项需求仍在当前范围内，就必须在矩阵里有一行。

## 审阅方式

请给每个功能面标一个判断：

- `KEEP`：当前产品需求；保留在 `traceability.md`。
- `DROP`：已经不做；从矩阵中删除对应需求行。
- `DEFER`：不是当前版本范围；移出当前矩阵，或放到 future/backlog，但不要算作当前需求。
- `SPLIT`：部分保留，部分删除。

注意：如果某个功能仍然能通过 UI、REST、WebSocket 或 daemon 路径访问，它的安全和错误处理需求应继续保留，直到代码被移除或被明确 gated。

## 本轮人工范围结论

| 判断 | 功能面 |
|---|---|
| `DROP` | 登录、认证、session/API token、远程入口相关 auth。 |
| `DROP` | Remote access / tunnels，包括 Cloudflare、Tailscale、reverse proxy。 |
| `DROP` | Job Mode / 多轮自动继续。 |
| `DEFER` | Codex 和 Claude 的 TTY/runtime switching；目前属于规划中，先不作为测试要求。 |
| `KEEP` | Worktree sessions 和 Git branch operations。 |
| `KEEP` | Native Sessions adoption。 |
| `KEEP` | Workbench Terminal。 |
| `KEEP` | Discord/Slack Bots。 |
| `KEEP` | Install / daemon scripts，作为产品发布质量的一部分。 |
| `KEEP` | CI quality gate、E2E nightly、traceability gate，作为发布质量的一部分。 |
| `KEEP` | 文件 preview，包括 raw preview；因此对应的 HTML/SVG preview 安全要求仍保留。 |
| `SPLIT` | Command Palette / 页面搜索：追踪 file/session search；不追踪 command search。 |

## 看起来像当前核心产品面的范围

| 功能面 | 矩阵 ID | 为什么看起来仍是当前范围 | 审阅判断 |
|---|---|---|---|
| App shell、导航、Settings tab | WEB-001, SET-001 | 有 E2E；属于首屏可见产品面。 | KEEP? |
| Sessions 和 Transcript | SES-001..004, EVT-001..009 | 核心工作流；测试和活跃代码都存在。 | KEEP? |
| Approvals | APR-001..004, SEC-011 | agent 行为的安全边界；核心流程已有测试。 | KEEP? |
| Queue 核心 | QUEUE-001..003, INV-009 | QueueManager 和 UI 都存在；host 核心逻辑已有测试。 | KEEP? |
| Proxy / session persistence | PROXY-001..004, INV-001..012, proxy 相关 ERR 行 | runtime 主干能力。 | KEEP? |
| Workspace 管理 | SPACE-001..004, MIG-001, CFG-001 | Spaces UI 和 REST endpoints 存在；已有部分 E2E。 | KEEP? |

## 需要确认是否仍在当前范围内的功能面

| 功能面 | 矩阵 ID | 为什么可能已经不在当前范围 | 如果确认不做 |
|---|---|---|---|
| Job Mode / 多轮自动继续 | JOB-001, JOB-002 | 用户确认当前不是产品承诺。 | DROP：已从当前矩阵移出。 |
| Worktree sessions 和 Git branch 管理 | WT-001..003, GIT-001..003, INV-013/015 | 用户确认是当前产品承诺。 | KEEP：继续留在矩阵。 |
| Native session 浏览和 adoption | NATIVE-001, NATIVE-002, ERR-011 | 用户确认是当前产品范围。 | KEEP：继续留在矩阵。 |
| Structured ↔ TTY runtime 切换 | TTY-001, TTY-002, SEC-006/007 | 用户确认 TTY 在规划中，测试先不管。 | DEFER：已从当前矩阵移出。 |
| Workbench terminal | TERM-001 | 用户确认是当前产品范围。 | KEEP：继续留在矩阵。 |
| Bots UI 和 Discord/Slack IM bridge | BOT-001, IM-001..003, SEC-010, ERR-015/016 | 用户确认是当前产品范围。 | KEEP：继续留在矩阵。 |
| Remote access / tunnels | REMOTE-001, SEC-013, ERR-014 | 用户确认属于远程范围，当前不做。 | DROP：已从当前矩阵移出。 |
| Install / daemon scripts / CI gate | DAEMON-001, CI-001..003, ERR-017/018 | 用户确认发布质量应进矩阵；CI gate 是后续强制更新矩阵的执行面。 | KEEP：继续留在矩阵。 |
| Command Palette 的 file/session search | PAL-001 | 用户理想范围是追踪 file/session search，不需要 command search。 | SPLIT：保留 file/session search；command search 不作为当前需求。 |
| 浏览器 raw file preview | FILE-003, SEC-009 | 用户确认文件 preview 仍要做。 | KEEP：继续留在矩阵，并保留 HTML/SVG 安全要求。 |

## 声明了但还没实现的内容

这些暂时不应算作产品需求，除非后续决定实现；但 contract drift 本身值得跟踪。

| 功能面 | 矩阵 ID | 当前状态 | 建议判断 |
|---|---|---|---|
| WS messages：`session:reset`、`session:takeover`、`slash:execute`、`transcript:load_more` | CONTRACT-001 | Shared types 声明了这些消息；`ws-handler.ts` 明确注释还未处理。 | 只保留为 contract-drift GAP，或从 shared types 删除。 |
| Proxy notification registry 完整一致性 | CONTRACT-004 | reasoning / plan / auto / tty 等新事件存在，但 shared registry 可能滞后。 | 如果 proxies 仍是核心范围，保留为 contract-drift GAP。 |
| Codex / Claude TTY runtime | TTY 相关 future note | TTY 属于规划中；当前测试可以先不管。 | DEFER：不要把 TTY 作为当前需求加入矩阵。 |

## 建议的第一轮裁剪问题

人工审阅时，先回答这些 yes/no 问题：

1. Job Mode 是当前产品承诺吗？不是。
2. Worktree sessions 和 Git branch operations 是当前产品承诺吗？是。
3. Native Sessions adoption 是当前产品范围吗？是。
4. Structured ↔ TTY runtime switching 是当前产品范围吗？不是，规划中。
5. Workbench Terminal 是当前产品范围吗？是。
6. Discord/Slack bots 是当前产品范围吗？是。
7. Tunnel / remote access 是当前产品范围吗？不是。
8. Install / daemon scripts 应该在质量矩阵里，还是拆到 ops checklist？质量矩阵。
9. Command Palette 要追踪 file/session search，还是只追踪 command search？追踪 file/session search，不追踪 command search。
10. Raw HTML/SVG preview 是否应该继续可访问？文件 preview 仍要做。

这些问题确认后，再更新 `traceability.md`：

- 删除 `DROP` 的行。
- 把 `DEFER` 的行移出当前范围。
- 对仍然可访问的代码路径，保留对应安全和错误处理行。
