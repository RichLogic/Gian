# 用本地程序打开 — 设计文档

**日期：** 2026-05-20
**状态：** 头脑风暴已通过 — 待写实施计划
**范围：** Files 页面新增 "Open" 按钮，把当前文件交给系统默认程序或用户
配置的外部编辑器打开。

---

## 1. 背景与动机

Files 页面目前在 app 内做语法高亮预览，并有一个 "↗ Open in new tab" 链
接，作用是在新浏览器标签里打开文件。**没有任何途径把文件交给本地程序**
（比如 `.psd` 给 Photoshop、`.py` 给 VS Code、`.pdf` 给 Preview）。本次
就是补这个口子。

Host 已经有 `POST /api/working_trees/:id/reveal`（`packages/host/src/web/
app.ts:1656`），在 macOS 上用 `open` 把文件夹在 Finder 里高亮显示。本
feature 就是它的文件级别版本，并且做了三个推广：
(a) 任意路径；(b) 用户可配置的编辑器列表；(c) 系统默认程序作为兜底。

Host 始终跟文件在同一台机器。浏览器可以远程（Cloudflare Tunnel / Tailscale），
但被启动的程序运行在 **Host 那台机器** 上 — 这跟现有的 "Reveal in Finder"
按钮预期一致，用户已经接受。

---

## 2. 数据模型

`SystemConfig`（`packages/shared/src/model.ts`）新增一个字段：

```ts
external_editors: ExternalEditor[]

interface ExternalEditor {
  id: string;         // uuid，open API 用这个稳定句柄引用
  name: string;       // 显示名，比如 "VS Code"
  command: string;    // 可执行名（走 PATH 解析）或绝对路径
                      // 比如 "code" 或
                      //      "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"
  args: string[];     // argv 模板；等于 "{path}" 的 token 会被替换为
                      // 文件绝对路径。如果没有这个占位符，路径会被追加到
                      // argv 末尾。
}
```

存储：在已有的 `config` K/V 表里，挂一行 key=`external_editors`，value 是
JSON 序列化后的字符串。`loadConfig` / `saveConfig` 透明地 parse/stringify。
默认值 `[]`。

`PATCH /api/settings` 时的校验：

- `id` 非空字符串
- `name` 非空、trim 后 ≤ 64 字符
- `command` 非空字符串
- `args` 字符串数组（可以为空）
- 列表内 id 不重复
- 校验失败的条目静默丢弃，**不**返 500

---

## 3. Host API

### 新端点

```
POST /api/working_trees/:id/open
body: { path: string, editor_id?: string }
```

行为：

1. 用 `resolveWorkingTree(:id)` 解 working tree，用
   `resolveWithinWorkspace(wt.path, body.path)` 解文件 — 跟 `/raw`、
   `/reveal` 用同一套防护。路径越界返 400。
2. stat 解出来的绝对路径；不存在返 404。
3. `editor_id` 缺省 → 调系统默认 opener：
   - `darwin`：`open <abs-path>`
   - `linux`：`xdg-open <abs-path>`
   - `win32`：`cmd /c start "" "<abs-path>"`
4. `editor_id` 提供了：
   - 在当前 `external_editors` 列表里查这个 id。未知 → 404。
   - 拼 argv：拷贝 `editor.args`，每个等于 `"{path}"` 的 token 替换为绝对
     路径。如果没有任何 `"{path}"` token，把绝对路径追加在末尾。
   - `execFile(editor.command, argv, ...)` 启动 — **永远不走 shell**。
     这样 `name`/`args` 里如果含空格或 shell 元字符，也不会被解释。
5. spawn 选项跟 reveal 一致：`timeout: 5000`、`stdio: 'ignore'`、
   `detached: true`，spawn 后 `.unref()`，让子进程不阻塞 daemon 的事件
   循环。子进程必须比 HTTP 请求活得久（GUI 应用不会在 launcher 退出时跟着
   退）。
6. 成功 → `200 { ok: true }`。spawn 出错（ENOENT、EACCES）→ `500
   { error: string }`，沿用现有错误信封。

### Settings 端点

不新增端点。`external_editors` 直接走现有的 `GET /api/settings` 和
`PATCH /api/settings`。

---

## 4. Web API 和 UI

### API 客户端（`packages/web/src/api.ts`）

```ts
export async function openFileWith(
  workingTreeId: string,
  path: string,
  editorId?: string,
): Promise<{ ok: true } | { error: string }>
```

包装 `POST /api/working_trees/:id/open`。

### FilesView 预览头

现状（`FilesView.tsx:649-671`）：只有一个 "↗ Open in new tab" 链接。

改成一个分裂按钮组：

```
[ Open ] [ ▾ ]    ↗ Open in new tab
```

- **"Open"（主按钮）** → `openFileWith(wt, path)`，不带 `editor_id`。
  触发系统默认程序。
- **"▾"（caret）** → 弹出一个小菜单，锚在 caret 上：
  - 每个已配置编辑器一行，只显示名称，点击 → `openFileWith(wt, path,
    editor.id)`。
  - 分隔线 + 末行 "Configure editors…"，点击打开 Settings 面板并把焦点
    滚动到 External editors 那一节。
  - 列表为空时，菜单里只有 "Configure editors…" 一项。
- **"↗ Open in new tab"** 不动，它面向浏览器，不是本地程序。

错误处理：拿到 `{ error }` 时，沿用 view 里其他 API 调用相同的通知机制
（toast / 行内错误）。

### Settings 面板（`SettingsBody.tsx`）

在 Appearance / 网络 / 默认值各节下面新增 "External editors" 一节：

- 标题 + 一行说明（"出现在 Files 页面 Open 菜单里的程序。Args 里的
  `{path}` 会被替换为文件路径；没有这个占位符则把路径追加到末尾。"）。
- 列表，每行：
  - `Name` 输入框（文本，≤ 64 字符）
  - `Command` 输入框（文本）
  - `Args` 输入框（文本）。存盘时按空白分隔切分为 `string[]`，**不**做 shell
    引号解析。需要含空格的单个参数（编辑器 CLI 里很罕见）这一版不支持；
    在帮助文案里说明这个限制。`{path}` token 仍然在切分后做整 token 替换。
  - 右侧 "✕" 删除按钮
- 列表下方 "+ Add editor" 按钮。点了新增一行（uuid 新生成，字段空白），
  自动 focus 到新行。
- 沿用现有 500ms 防抖自动存（`SettingsPanel.tsx`），不加显式 Save 按钮。

空状态：一句简短提示 "未配置编辑器。添加后即可在 Files 页面调用。"

---

## 5. 安全

- 路径解析复用 `/raw`、`/reveal` 同一套 `resolveWithinWorkspace`。越界
  访问被拒。
- spawn 永远用 `execFile`，**不**用 `exec`。`command` 和每个 `args` 元素
  都是独立 argv 元素，里面的空格/shell 元字符不会被解释。
- 编辑器条目是用户在自己机器上配置的，信任模型跟用户选 executor（Claude /
  Codex 二进制）一样：用户配置，daemon 启动。
- `{path}` 替换在整个 argv token 上操作；token 含 `{path}` 子串（比如
  `--file={path}`）的，整个 token 被替换为 `--file=/abs/path`。这是有意
  设计，匹配最常见的编辑器 CLI 约定。
- spawn 用 `detached: true` + `.unref()`。子进程独立于 daemon，daemon 也
  不保留句柄 — Unix 上无僵尸风险（init 来 reap），不需要 orphan 跟踪。

---

## 6. 跨平台行为

| OS      | 默认 opener                | 配置编辑器 |
|---------|---------------------------|-----------|
| macOS   | `open <path>`             | `execFile(cmd, argv)` |
| Linux   | `xdg-open <path>`         | `execFile(cmd, argv)` |
| Windows | `cmd /c start "" "<path>"` | `execFile(cmd, argv)` |

`process.platform` 是分派器，沿用 host 里已有的平台判断模式。注意：现有
`/reveal` 端点目前只支持 macOS；本设计为 **默认 opener 和配置编辑器**
三个平台都实现，但 `/reveal` 自己补齐 Linux/Windows 不在本次范围内
（之后可以共用同一个分派 helper）。

用户填的 `command` 是用户的跨平台问题：他们填自己 OS 上能跑的命令就行。

---

## 7. 不做（Out of scope）

- 按扩展名记忆默认编辑器（"`.py` 永远用 VS Code 打开"）— 不做这种持久化，
  只有全局列表。
- 编辑器图标 / 品牌资源。
- "Choose application…" 原生选择对话框（macOS 的 `osascript`、Windows 的
  `OpenWith.exe`，Linux 没有标准）— 已经讨论过，跨平台一致性差，pass。
- 编辑器列表拖拽排序，按插入顺序展示。手动排序作为后续可能的小迭代。
- 给 `/reveal` 补 Linux/Windows。另一个 concern。
- 单个文件的 reveal-in-Finder（区别于文件夹）— 可能的后续，复用同一套
  分派器。

---

## 8. 测试

**Host 单测**（`packages/host/test/` 或贴着现有路由测试放）：

- `editor_id` 缺省 → 按 `process.platform` 调 `open` / `xdg-open` /
  `start`。注入 fake spawn 断言 argv。
- `editor_id` 有效 → 用 `command` 加替换后的 argv 启动。两条分支都覆盖：
  含 `{path}` 替换、不含 token 追加。
- `editor_id` 有效但 `args` 含多个 `{path}` token — 全部替换。
- `editor_id` 未知 → 404。
- `path` 越出 working tree → 400（traversal 防护）。
- `path` 在磁盘上不存在 → 404。
- Settings 来回：PATCH `external_editors`，GET 读回同一份列表。非法条目
  被丢弃。

**Web 测试**（`packages/web/test/` Vitest）：

- 打开文件时，FilesView 头部渲染 "Open" + caret。
- caret 菜单列出已配置编辑器和末行 "Configure editors…"。
- 点击某个编辑器行调 `openFileWith` 时带正确的 `editor_id`。
- 编辑器列表为空时，菜单里仍然有 "Configure editors…"。
- Settings：增/删/改行更新 PATCH payload。

**手动验证**（写在 PR 描述里，不自动化）：

- macOS 上：默认 `open` 能打开 `.md`、`.png`、`.pdf`。
- macOS 上：配置 `code --new-window {path}` 实际打开 VS Code。
- 验证子进程在 daemon 重启后还活着（detached + unref 语义）。

---

## 9. 涉及文件（估计）

- `packages/shared/src/model.ts` — `SystemConfig`、`ExternalEditor` 类型。
- `packages/host/src/db/config.ts`（或 `loadConfig` / `saveConfig` 所在
  位置）— 新字段的 JSON parse/stringify。
- `packages/host/src/web/app.ts` — 新的 `/open` 路由；平台默认 opener 的
  小分派 helper。
- `packages/host/test/...` — 路由 + 分派器的新测试。
- `packages/web/src/api.ts` — `openFileWith`。
- `packages/web/src/views/FilesView.tsx` — 头部按钮组 + 菜单。
- `packages/web/src/components/SettingsBody.tsx` — External editors 节。
- `packages/web/src/styles/...` — 分裂按钮和编辑器行布局的少量 CSS。
- `packages/web/test/...` — Vitest 覆盖。

不需要数据库 schema 迁移（新 key 直接落在 `config` K/V 表里）。

---

## 10. Traceability

实施时在 `docs/quality/traceability.md` 加一行：

- 需求：Files 页面可以把文件交给本地程序。
- 代码：`/open` 路由 + FilesView 头部 + Settings 节。
- 测试：上面列的新 host + web 测试。
