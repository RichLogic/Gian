# Session UI polish — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle six UI improvements — font scale per zone, executor color-bar row layout with branch, collapsible workspace grouping, hide/unhide workspaces, theme-bound accent with expanded palette, and an original Gian mascot animation that replaces flickering per-card "thinking…" text.

**Architecture:** Phase 0 lays the data foundation (SystemConfig extensions, Workspace.hidden migration, runtime sanitize). Phases 1–6 implement six visually independent slices that can ship in any order. CSS work uses a single `--zone-scale` custom property for font scaling and `:root` token redirects for accent expansion. The mascot is one new React component with two inline SVGs (static + animated).

**Tech Stack:** TypeScript, React, Vitest + React Testing Library (web), `node:test` (host), better-sqlite3 (config table, workspaces migration), CSS custom properties, inline SVG with CSS keyframes.

**Spec:** `docs/superpowers/specs/2026-05-21-session-ui-polish-design.md`

**Mockups:**
- `docs/mockups/2026-05-21-session-grouping.html`
- `docs/mockups/2026-05-21-gian-mascot.html`

---

## File map

**Create:**
- `packages/host/migrations/022_workspace_hidden.sql` — `ALTER TABLE workspaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`.
- `packages/web/src/components/GianMascot.tsx` — `<GianMascot size state title />` with static + working SVGs.
- `packages/web/test/settings-appearance.test.tsx` — Settings UI: font scales, theme reset accent, hidden workspace toggle.
- `packages/host/test/config-sanitize.test.ts` — `loadConfig` allowlist tests.
- `packages/host/test/workspace-hide.test.ts` — migration + API behaviour.

**Modify:**
- `packages/shared/src/model.ts` — `Workspace.hidden`, `SystemConfig.font_scale_*`, `SystemConfig.accent` literal union, `THEME_DEFAULT_ACCENT`.
- `packages/host/src/storage/config.ts` — runtime allowlist sanitize; new defaults.
- `packages/host/src/storage/workspaces.ts` (or equivalent) — read/write `hidden`.
- `packages/host/src/web/app.ts` — PATCH workspace route accepts `hidden`.
- `packages/web/src/styles/tokens.css` — `--zone-scale` token redirect, 8 accents, theme palette tweaks.
- `packages/web/src/styles/gian-v2.css` — `.sb-group` collapsible, `.rail-item` exec color bar, `.ri-branch`, `.ri-exec-mini`, `.sb-hidden-link`.
- `packages/web/src/App.tsx` — body data attributes for font scales.
- `packages/web/src/components/Terminal.tsx` — observe `data-scale-code`; refit on change.
- `packages/web/src/components/SettingsBody.tsx` — Font scales rows, expanded accent buttons, theme resets accent, Workspaces section.
- `packages/web/src/views/CodingView.tsx` — SessionRow (exec bar + branch + mini icon), `renderGroups` (collapsible + count), sidebar hidden-link footer, active-session badge when ws hidden, NewSessionView greying.
- `packages/web/src/transcript/apply.ts` and/or `Transcript.tsx` — remove per-card "thinking…" rendering.
- `docs/quality/traceability.md`, `docs/ai/STATE.md`, `docs/ai/SESSION_LOG.md` — end-of-turn updates.

---

## Phase 0 — Data foundation

### Task 1: Extend `SystemConfig` and `Workspace` types

**Files:**
- Modify: `packages/shared/src/model.ts`

- [ ] **Step 1: Add `THEME_DEFAULT_ACCENT` and accent literal union above `SystemConfig`**

In `packages/shared/src/model.ts`, just above the `SystemConfig` interface:

```ts
export type Accent =
  | 'azure' | 'amber' | 'violet'   // theme defaults
  | 'teal' | 'moss' | 'ink' | 'plum' | 'ember';

export type FontScale = 'sm' | 'md' | 'lg' | 'xl';

export const THEME_DEFAULT_ACCENT: Record<'light' | 'warm' | 'dark', Accent> = {
  light: 'azure',
  warm: 'amber',
  dark: 'violet',
};
```

- [ ] **Step 2: Update `SystemConfig` accent + add font scale fields**

Change `accent: string` to `accent: Accent`. After `density:` add:

```ts
  font_scale_chrome: FontScale;
  font_scale_chat: FontScale;
  font_scale_code: FontScale;
```

- [ ] **Step 3: Add `hidden` to `Workspace`**

```ts
export interface Workspace {
  id: string;
  name: string;
  path: string;
  sort_order: number;
  hidden: 0 | 1;       // SQLite 布尔惯例（同 Session.archived）
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 4: Run typecheck to find break sites**

Run: `pnpm -r typecheck`
Expected: host (`config.ts` loadConfig defaults, workspace queries) and possibly tests break. List the call sites — they're handled in Tasks 2–4.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/model.ts
git commit -m "feat(shared): Accent/FontScale types + Workspace.hidden + THEME_DEFAULT_ACCENT"
```

---

### Task 2: Workspace `hidden` migration + storage

**Files:**
- Create: `packages/host/migrations/022_workspace_hidden.sql`
- Modify: workspace read/write site (find via `Grep "FROM workspaces"` under `packages/host/src/storage/`)
- Create: `packages/host/test/workspace-hide.test.ts`

- [ ] **Step 1: Write the migration**

`packages/host/migrations/022_workspace_hidden.sql`:

```sql
ALTER TABLE workspaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Write failing test for round-trip**

`packages/host/test/workspace-hide.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.js';      // existing helper — verify path
import { listWorkspaces, updateWorkspace, createWorkspace } from '../src/storage/workspaces.js';

test('workspace.hidden defaults to false and round-trips', () => {
  const db = createTestDb();
  const ws = createWorkspace(db, { name: 'wsA', path: '/tmp/a' });
  assert.equal(ws.hidden, false);

  updateWorkspace(db, ws.id, { hidden: true });
  const after = listWorkspaces(db).find(w => w.id === ws.id);
  assert.equal(after?.hidden, true);
});
```

Run: `pnpm -F @gian/host exec node --test --import tsx test/workspace-hide.test.ts`
Expected: FAIL — `hidden` doesn't round-trip yet (storage layer reads/writes haven't been updated).

- [ ] **Step 3: Update the storage layer**

In whichever file owns workspace queries:

- `SELECT id, name, path, sort_order, hidden, created_at, updated_at FROM workspaces …`
- Map `row.hidden === 1` → `true` when returning
- `INSERT INTO workspaces (…, hidden, …) VALUES (…, 0, …)` for `createWorkspace`
- New `updateWorkspace(db, id, { hidden })` that updates the column (preserve other patch shapes if the function is generic)

- [ ] **Step 4: Run the test again**

Run: `pnpm -F @gian/host exec node --test --import tsx test/workspace-hide.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/migrations/022_workspace_hidden.sql packages/host/src/storage packages/host/test/workspace-hide.test.ts
git commit -m "feat(host): workspaces.hidden column + storage round-trip"
```

---

### Task 3: `loadConfig` runtime sanitize + new defaults

**Files:**
- Modify: `packages/host/src/storage/config.ts`
- Create: `packages/host/test/config-sanitize.test.ts`

- [ ] **Step 1: Write failing test**

`packages/host/test/config-sanitize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.js';
import { loadConfig, saveConfig } from '../src/storage/config.js';

test('loadConfig falls back when accent is invalid', () => {
  const db = createTestDb();
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('accent', 'banana')`).run();
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('theme',  'dark')`).run();
  const cfg = loadConfig(db);
  assert.equal(cfg.accent, 'violet');               // THEME_DEFAULT_ACCENT.dark
});

test('loadConfig falls back when font scale is invalid', () => {
  const db = createTestDb();
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('font_scale_chat', 'huge')`).run();
  const cfg = loadConfig(db);
  assert.equal(cfg.font_scale_chat, 'md');
});

test('loadConfig keeps a legacy plum accent', () => {
  const db = createTestDb();
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('accent', 'plum')`).run();
  const cfg = loadConfig(db);
  assert.equal(cfg.accent, 'plum');                 // still in allowlist
});
```

Run: `pnpm -F @gian/host exec node --test --import tsx test/config-sanitize.test.ts`
Expected: FAIL — current `loadConfig` does no sanitization.

- [ ] **Step 2: Add allowlists and sanitize in `loadConfig`**

At the top of `packages/host/src/storage/config.ts`, after imports:

```ts
import type { Accent, FontScale, SystemConfig } from '@gian/shared';
import { THEME_DEFAULT_ACCENT } from '@gian/shared';

const VALID_ACCENTS: ReadonlySet<Accent> = new Set([
  'azure', 'amber', 'violet', 'teal', 'moss', 'ink', 'plum', 'ember',
]);
const VALID_SCALES: ReadonlySet<FontScale> = new Set(['sm', 'md', 'lg', 'xl']);
const VALID_THEMES: ReadonlySet<SystemConfig['theme']> = new Set(['light', 'warm', 'dark']);

function sanitizeScale(raw: string | undefined): FontScale {
  return raw && VALID_SCALES.has(raw as FontScale) ? (raw as FontScale) : 'md';
}
```

Inside `loadConfig`, replace the existing `theme` / `accent` lines with:

```ts
  const theme: SystemConfig['theme'] = VALID_THEMES.has(map.get('theme') as SystemConfig['theme'])
    ? (map.get('theme') as SystemConfig['theme'])
    : 'warm';
  const rawAccent = map.get('accent') ?? '';
  const accent: Accent = VALID_ACCENTS.has(rawAccent as Accent)
    ? (rawAccent as Accent)
    : THEME_DEFAULT_ACCENT[theme];
```

Then in the returned object:

```ts
  font_scale_chrome: sanitizeScale(map.get('font_scale_chrome')),
  font_scale_chat:   sanitizeScale(map.get('font_scale_chat')),
  font_scale_code:   sanitizeScale(map.get('font_scale_code')),
```

- [ ] **Step 3: Re-run the sanitize tests**

Run: `pnpm -F @gian/host exec node --test --import tsx test/config-sanitize.test.ts`
Expected: PASS.

- [ ] **Step 4: Re-run all host tests to check no regressions**

Run: `pnpm -F @gian/host test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/storage/config.ts packages/host/test/config-sanitize.test.ts
git commit -m "feat(host): runtime allowlist sanitize for theme/accent/font_scale"
```

---

## Phase 1 — Theme & accent

### Task 4: Token expansion (8 accents) and theme palette tweaks

**Files:**
- Modify: `packages/web/src/styles/tokens.css:64-71`

- [ ] **Step 1: Replace the accent presets block**

Replace lines 64–71 of `tokens.css`:

```css
/* ---------- Accent presets ----------
   Body fallback = azure (light theme default).
   Each theme's default is set on theme switch by SettingsBody, but the
   declarations live in one place so any preset is usable under any theme. */
body                        { --accent-h: 220; --accent-c: 0.13; }
body[data-accent="azure"]   { --accent-h: 220; --accent-c: 0.13; }
body[data-accent="amber"]   { --accent-h:  50; --accent-c: 0.14; }
body[data-accent="violet"]  { --accent-h: 300; --accent-c: 0.13; }
body[data-accent="teal"]    { --accent-h: 195; --accent-c: 0.10; }
body[data-accent="moss"]    { --accent-h: 150; --accent-c: 0.10; }
body[data-accent="ink"]     { --accent-h: 255; --accent-c: 0.11; }
body[data-accent="plum"]    { --accent-h: 310; --accent-c: 0.13; }
body[data-accent="ember"]   { --accent-h:  30; --accent-c: 0.13; }
```

- [ ] **Step 2: Manual visual check — start dev server**

```bash
pnpm -F @gian/web dev
```

Open <http://localhost:5191>, dev tools → set `document.body.setAttribute('data-accent', 'teal')`, confirm UI repaints with teal accent. Cycle through all 8 presets in light + warm + dark themes.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/styles/tokens.css
git commit -m "feat(web): expand accent palette to 8 presets"
```

---

### Task 5: SettingsBody — theme resets accent + 8-button accent row

**Files:**
- Modify: `packages/web/src/components/SettingsBody.tsx:74-104`
- Create: `packages/web/test/settings-appearance.test.tsx`

- [ ] **Step 1: Write failing test for theme-resets-accent**

Create `packages/web/test/settings-appearance.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsBody } from '../src/components/SettingsBody';
import { saveSettings } from '../src/api';

vi.mock('../src/api', () => ({
  saveSettings: vi.fn(async (p) => ({ ...baseConfig, ...p })),
  loadProxyModels: vi.fn(async () => []),
}));

const baseConfig = {
  host: '127.0.0.1', port: 8991, workspace_root: '~/Coding', public_url: '',
  tunnel_mode: 'none', tunnel_id: '', force_https: false,
  theme: 'warm', accent: 'amber', density: 'cozy', locale: 'zh-CN',
  font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
  default_claude_model: '', default_claude_effort: '',
  default_codex_model:  '', default_codex_effort:  '',
  auth_username: '', external_editors: [],
} as const;

describe('SettingsBody appearance', () => {
  beforeEach(() => vi.mocked(saveSettings).mockClear());

  it('switching theme resets accent to theme default', async () => {
    render(<SettingsBody config={baseConfig} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Dark/i }));
    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({ theme: 'dark', accent: 'violet' });
    });
  });
});
```

Run: `pnpm -F @gian/web test settings-appearance`
Expected: FAIL — current theme button only sends `{ theme }`.

- [ ] **Step 2: Update Theme button onClick**

In `SettingsBody.tsx`, import the constant:

```ts
import { THEME_DEFAULT_ACCENT } from '@gian/shared';
```

In the theme button block, change `onClick={() => patch({ theme: key })}` to:

```tsx
onClick={() => patch({ theme: key, accent: THEME_DEFAULT_ACCENT[key] })}
```

- [ ] **Step 3: Replace the 4-accent array with 8 presets**

Replace the `[['plum', …], ['moss', …], ['ink', …], ['ember', …]]` array with:

```tsx
{([
  ['ember',  'Ember',  'oklch(0.55 0.13  30)'],
  ['amber',  'Amber',  'oklch(0.55 0.14  50)'],
  ['plum',   'Plum',   'oklch(0.55 0.13 310)'],
  ['violet', 'Violet', 'oklch(0.55 0.13 300)'],
  ['ink',    'Ink',    'oklch(0.55 0.11 255)'],
  ['azure',  'Azure',  'oklch(0.55 0.13 220)'],
  ['teal',   'Teal',   'oklch(0.55 0.10 195)'],
  ['moss',   'Moss',   'oklch(0.55 0.10 150)'],
] as const).map(([k, name, c]) => (
  /* unchanged button JSX */
))}
```

- [ ] **Step 4: Re-run the test**

Run: `pnpm -F @gian/web test settings-appearance`
Expected: PASS.

- [ ] **Step 5: Visual check + commit**

Run dev server, manually click each accent on each theme, confirm switching theme overrides the accent button highlight.

```bash
git add packages/web/src/components/SettingsBody.tsx packages/web/test/settings-appearance.test.tsx
git commit -m "feat(web): theme switch resets accent; expose 8 accents in Settings"
```

---

## Phase 2 — Font scale

### Task 6: `--zone-scale` token redirect

**Files:**
- Modify: `packages/web/src/styles/tokens.css`

- [ ] **Step 1: Add scale variables on `body`**

Inside the existing `:root { … }` block, after `--gutter`, the existing `--fz-*` declarations stay where they are — but their *definitions* change. Replace the seven `--fz-*` lines:

```css
  --fz-11: calc(11px * var(--zone-scale, 1));
  --fz-12: calc(12px * var(--zone-scale, 1));
  --fz-13: calc(13px * var(--zone-scale, 1));
  --fz-14: calc(14px * var(--zone-scale, 1));
  --fz-16: calc(16px * var(--zone-scale, 1));
  --fz-20: calc(20px * var(--zone-scale, 1));
  --fz-28: calc(28px * var(--zone-scale, 1));
```

Then **outside** `:root`, add (above the theme blocks):

```css
body {
  --scale-chrome: 1; --scale-chat: 1; --scale-code: 1;
  --zone-scale: 1;
}
body[data-scale-chrome="sm"] { --scale-chrome: 0.875; }
body[data-scale-chrome="lg"] { --scale-chrome: 1.125; }
body[data-scale-chrome="xl"] { --scale-chrome: 1.25;  }
body[data-scale-chat="sm"]   { --scale-chat:   0.875; }
body[data-scale-chat="lg"]   { --scale-chat:   1.125; }
body[data-scale-chat="xl"]   { --scale-chat:   1.25;  }
body[data-scale-code="sm"]   { --scale-code:   0.875; }
body[data-scale-code="lg"]   { --scale-code:   1.125; }
body[data-scale-code="xl"]   { --scale-code:   1.25;  }

.sidebar, .topbar, .inspector, .settings-tab-body {
  --zone-scale: var(--scale-chrome);
}
.transcript, .composer, .composer-wrap, .approval, .evt {
  --zone-scale: var(--scale-chat);
}
.sheet, .tty, .gian-terminal, .sheet-file, .md-preview {
  --zone-scale: var(--scale-code);
}
```

- [ ] **Step 2: Visual check**

Run dev server. Devtools console: `document.body.setAttribute('data-scale-chat', 'lg')`. Confirm transcript text grows ~12%; sidebar / settings unchanged. Repeat for `chrome` and `code`. Cycle through sm/md/lg/xl on each. Toggle off → text returns to baseline.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/styles/tokens.css
git commit -m "feat(web): --zone-scale font scale tokens for chrome/chat/code"
```

---

### Task 7: SettingsBody font-scale controls + App.tsx body attributes + xterm refit

**Files:**
- Modify: `packages/web/src/components/SettingsBody.tsx`
- Modify: `packages/web/src/App.tsx:81-87`
- Modify: `packages/web/src/components/Terminal.tsx:91`

- [ ] **Step 1: Add three Font Scale rows in SettingsBody**

Inside the `<dl className="kv-grid">` Appearance block, just after the `Density` row and before `Font`:

```tsx
<dt>Font · 界面</dt>
<dd>
  <div className="segm">
    {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
      <button key={s}
              className={`segm-item ${config.font_scale_chrome === s ? 'active' : ''}`}
              onClick={() => patch({ font_scale_chrome: s })}>
        {s.toUpperCase()}
      </button>
    ))}
  </div>
</dd>
<dt>Font · 对话</dt>
<dd>
  <div className="segm">
    {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
      <button key={s}
              className={`segm-item ${config.font_scale_chat === s ? 'active' : ''}`}
              onClick={() => patch({ font_scale_chat: s })}>
        {s.toUpperCase()}
      </button>
    ))}
  </div>
</dd>
<dt>Font · 代码</dt>
<dd>
  <div className="segm">
    {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
      <button key={s}
              className={`segm-item ${config.font_scale_code === s ? 'active' : ''}`}
              onClick={() => patch({ font_scale_code: s })}>
        {s.toUpperCase()}
      </button>
    ))}
  </div>
</dd>
```

- [ ] **Step 2: Apply the body attributes in App.tsx**

In `App.tsx` lines 83–87, after `data-density`:

```ts
document.body.setAttribute('data-scale-chrome', systemConfig.font_scale_chrome);
document.body.setAttribute('data-scale-chat', systemConfig.font_scale_chat);
document.body.setAttribute('data-scale-code', systemConfig.font_scale_code);
```

Extend the dependency array:

```ts
}, [systemConfig?.theme, systemConfig?.accent, systemConfig?.density,
    systemConfig?.font_scale_chrome, systemConfig?.font_scale_chat,
    systemConfig?.font_scale_code, systemConfig?.locale]);
```

- [ ] **Step 3: Add `data-scale-code` to Terminal's MutationObserver**

In `Terminal.tsx:91`, change `attributeFilter`:

```ts
attributeFilter: ['data-theme', 'data-accent', 'data-scale-code'],
```

Inside the mutation handler, after the existing theme/accent re-read, read the new computed font size and apply it:

```ts
const computed = getComputedStyle(document.body).getPropertyValue('--fz-13').trim();
const px = parseFloat(computed);
if (px > 0 && Number.isFinite(px)) {
  term.options.fontSize = px;
  fitAddon?.fit();
}
```

(`fitAddon` and `term` are the existing locals — match their names in the actual file.)

- [ ] **Step 4: Visual check across zones**

Open dev server. Settings → cycle through SM/MD/LG/XL for each of the three zones. Verify:
- 界面 SM shrinks sidebar / topbar / settings only
- 对话 LG grows transcript only
- 代码 XL grows sheet/tty + xterm refits without visual glitch

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/SettingsBody.tsx packages/web/src/App.tsx packages/web/src/components/Terminal.tsx
git commit -m "feat(web): per-zone font scale controls + xterm refit"
```

---

## Phase 3 — Row layout

### Task 8: SessionRow — executor color bar, branch in row2, accessibility

**Files:**
- Modify: `packages/web/src/views/CodingView.tsx:659-698`
- Modify: `packages/web/src/styles/gian-v2.css` (around `.rail-item` at line 596–697)

- [ ] **Step 1: Rewrite `SessionRow` JSX**

Replace the function body (lines 659–698):

```tsx
function SessionRow({
  session, workspaceName, active, archived, onSelect,
}: {
  session: Session;
  workspaceName: string;
  active: boolean;
  archived?: boolean;
  onSelect: () => void;
}) {
  const execLabel = session.executor === 'claude' ? 'Claude' : 'Codex';
  return (
    <div
      className={`rail-item ${session.executor}${active ? ' active' : ''}${archived ? ' archived' : ''}`}
      data-testid={`session-row-${session.id}`}
      role="button"
      tabIndex={0}
      title={`${session.name ?? session.id.slice(0, 6)} — ${execLabel}`}
      aria-label={`${session.name ?? 'session'} — ${execLabel}`}
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
    >
      <div className="ri-body">
        <div className="ri-row1">
          <span className={`ri-exec-mini ${session.executor}`} aria-hidden="true">
            <SvgIcon d={session.executor === 'claude' ? ICON.flame : ICON.box} size={11} />
          </span>
          <span className="ri-title">{session.name || `session ${session.id.slice(0, 6)}`}</span>
        </div>
        <div className="ri-row2">
          {session.branch && (
            <>
              <span className="ri-branch">
                <SvgIcon d={ICON.branch} size={9} />
                <span className="ri-branch-name">{session.branch}</span>
              </span>
              <span className="ri-dot-sep">·</span>
            </>
          )}
          <span className="ri-sub">{workspaceName}</span>
        </div>
      </div>
      <span className="ri-age" title="Last activity">{relTime(session.updated_at)}</span>
      <StatusIcon status={session.status} />
    </div>
  );
}
```

> If `ICON.flame` / `ICON.box` / `ICON.branch` don't exist in the local `ICON` map yet, add the path strings to the `ICON` object — adjacent to where `ICON.search` / `ICON.group` are declared in the same file. Use Lucide path strings:
>
> ```ts
> branch: 'M5 3v10M11 6v7M5 6h6M11 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM5 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
> flame:  'M8 1.5c.8 2 2.7 3.2 2.7 5.5 0 1.8-1.2 3.5-2.7 3.5S5.3 8.8 5.3 7c0-2.3 1.9-3.5 2.7-5.5Z',
> box:    'M3 4l5-2 5 2v8l-5 2-5-2V4Z',
> ```

- [ ] **Step 2: Update `.rail-item` CSS to add the executor color bar + new bits**

In `gian-v2.css`, in or near the `.rail-item { … }` block (line 597):

```css
.rail-item { padding-left: 14px; }                  /* was 8px */
.rail-item::before {
  content: ""; position: absolute;
  left: 4px; top: 9px; bottom: 9px;
  width: 3px; border-radius: 2px;
  background: var(--exec-color, var(--text-3));
  pointer-events: none;
}
.rail-item.claude { --exec-color: var(--claude); }
.rail-item.codex  { --exec-color: var(--codex); }

.ri-row1 { gap: 6px; }
.ri-exec-mini {
  flex: none; width: 12px; height: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--text-3); opacity: 0.85;
}
.ri-exec-mini.claude { color: var(--claude); opacity: 1; }
.ri-exec-mini.codex  { color: var(--codex); opacity: 1; }

.ri-branch {
  display: inline-flex; align-items: center; gap: 3px;
  color: var(--text-2);
  overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 120px;
}
.ri-branch svg { width: 9px; height: 9px; flex: none; opacity: 0.7; }
.ri-branch-name { overflow: hidden; text-overflow: ellipsis; }
```

Remove the now-unused `.ri-exec { … }` / `.ri-exec.claude` / `.ri-exec.codex` text rules (they're at the same area).

- [ ] **Step 3: Visual check**

Open dev server. Confirm:
- Each row has a 3px color bar on the left (orange for claude, purple-blue for codex)
- A small icon precedes the title
- Row2 shows `⎇ branch · workspace` when branch exists, else just `workspace`
- Active row's accent background still works (bar shouldn't conflict)

- [ ] **Step 4: Run web tests**

Run: `pnpm -F @gian/web test`
Expected: PASS (no test relied on the `.ri-exec` text wrapper). If anything tied to `Claude · GianDev` text breaks, update the assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/views/CodingView.tsx packages/web/src/styles/gian-v2.css
git commit -m "feat(web): SessionRow executor color bar + branch in row2 + a11y label"
```

---

## Phase 4 — Grouping D

### Task 9: Collapsible `.sb-group` with count

**Files:**
- Modify: `packages/web/src/views/CodingView.tsx:403-468`
- Modify: `packages/web/src/styles/gian-v2.css:544-573`

- [ ] **Step 1: Update `.sb-group` CSS**

Replace the existing `.sb-group { … }` and `.sb-group .count { … }` blocks:

```css
.sb-group {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 8px 4px;
  font: 600 11px/1 var(--font-mono);
  color: var(--text-2);
  text-transform: none;
  letter-spacing: 0;
  cursor: pointer;
  user-select: none;
}
.sb-group .caret {
  width: 9px;
  color: var(--text-3);
  font-size: 9px;
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
}
.sb-group .count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  background: var(--surface-2);
  border-radius: 3px;
  padding: 1px 5px;
}
.sb-group.needs-you { cursor: default; }
.sb-group.needs-you .caret { display: none; }
```

- [ ] **Step 2: Add collapse state + localStorage in `Sidebar`**

Near the other `useState` calls (CodingView.tsx around line 322), add:

```tsx
const collapsedKey = `gian.sidebar.collapsed.${groupBy}`;
const [collapsed, setCollapsed] = useState<Set<string>>(() => {
  try {
    const raw = localStorage.getItem(collapsedKey);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
});

useEffect(() => {
  try { localStorage.setItem(collapsedKey, JSON.stringify(Array.from(collapsed))); } catch {}
}, [collapsed, collapsedKey]);

// Reset (re-read) when groupBy changes — different mode, different set.
useEffect(() => {
  try {
    const raw = localStorage.getItem(`gian.sidebar.collapsed.${groupBy}`);
    setCollapsed(new Set<string>(raw ? JSON.parse(raw) : []));
  } catch { setCollapsed(new Set()); }
}, [groupBy]);

function toggleGroup(key: string) {
  setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
}
```

- [ ] **Step 3: Wrap each group header in `renderGroups`**

For each of the three branches in `renderGroups()` (workspace / status / time), change the header markup:

```tsx
const isCollapsed = collapsed.has(key);
return (
  <div key={key}>
    <div className="sb-group" onClick={() => toggleGroup(key)}>
      <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
      <span>{headerLabel}</span>
      <span className="count">{list.length}</span>
    </div>
    {!isCollapsed && sorted.map(s => renderRow(s, wsName))}
  </div>
);
```

Use the group's natural identifier as `key`:
- workspace mode → `wsId`
- status mode → `status`
- time mode → `bucket`

Apply the same shape in all three branches. Leave `.sb-group.needs-you` block unchanged (no caret, not collapsible).

- [ ] **Step 4: Visual check**

Open dev server. Confirm each group header has caret + count, clicking toggles, refresh preserves state, switching groupBy resets to a clean (empty-collapsed) state for the new mode.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/views/CodingView.tsx packages/web/src/styles/gian-v2.css
git commit -m "feat(web): collapsible session groups with count + persisted state"
```

---

## Phase 5 — Workspace hide

### Task 10: API — PATCH workspace accepts `hidden`

**Files:**
- Modify: `packages/host/src/web/app.ts` (find `PATCH /api/workspaces/:id` or equivalent)
- Modify: `packages/host/test/workspace-hide.test.ts` (extend with route test)

- [ ] **Step 1: Find the existing workspace PATCH/update route**

Run: `Grep "PATCH" packages/host/src/web/app.ts | head`
Find the route that updates workspace fields (name / sort_order). If none exists, add a new route immediately after the existing `POST /api/workspaces` registration.

- [ ] **Step 2: Write failing test for the route**

Append to `packages/host/test/workspace-hide.test.ts`:

```ts
import { buildTestApp } from './helpers/app.js';                // existing helper

test('PATCH /api/workspaces/:id toggles hidden', async () => {
  const { app, db } = buildTestApp();
  const ws = createWorkspace(db, { name: 'wsA', path: '/tmp/a' });
  const res = await app.request(`/api/workspaces/${ws.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: true }),
  });
  assert.equal(res.status, 200);
  const after = listWorkspaces(db).find(w => w.id === ws.id);
  assert.equal(after?.hidden, true);
});
```

Run: FAIL — route doesn't accept `hidden` yet.

- [ ] **Step 3: Extend the route handler to read & save `hidden`**

In the PATCH workspace handler, accept `hidden: boolean` from the body, validate it's a bool, and call the storage layer's `updateWorkspace(db, id, { hidden })`. If you added a new route, register it via `app.patch('/api/workspaces/:id', …)` returning the updated workspace JSON.

- [ ] **Step 4: Run tests**

Run: `pnpm -F @gian/host exec node --test --import tsx test/workspace-hide.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/web/app.ts packages/host/test/workspace-hide.test.ts
git commit -m "feat(host): PATCH /api/workspaces/:id supports hidden"
```

---

### Task 11: Web client + Sidebar filter

**Files:**
- Modify: `packages/web/src/api.ts` — add `updateWorkspace(id, patch)`.
- Modify: `packages/web/src/views/CodingView.tsx` (Sidebar filter + NewSessionView greying)

- [ ] **Step 1: Add `updateWorkspace` API client**

In `packages/web/src/api.ts`, alongside existing workspace helpers:

```ts
export async function updateWorkspace(
  id: string,
  patch: { hidden?: boolean; name?: string },
): Promise<Workspace | null> {
  const res = await fetch(`/api/workspaces/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  return res.json();
}
```

- [ ] **Step 2: Sidebar — filter out hidden workspaces (except active session's)**

In `CodingView.tsx` Sidebar `filtered` computation (line 378), update:

```ts
const filtered = active.filter(s => {
  if (wsFilter !== 'all' && s.workspace_id !== wsFilter) return false;
  if (filterExec && s.executor !== filterExec) return false;
  const ws = wsById.get(s.workspace_id);
  // Hide sessions whose workspace is hidden — UNLESS this is the active session.
  if (ws?.hidden && s.id !== activeSessionId) return false;
  const wsName = ws?.name ?? '';
  return matchesSearch(s, wsName);
});
```

Apply the same filter to the archived loop (line 629-633).

- [ ] **Step 3: SessionRow — add hidden badge when applicable**

Extend `SessionRow` to accept `wsHidden?: boolean`, and in the JSX (next to `<StatusIcon>`):

```tsx
{wsHidden && (
  <span className="ri-hidden-badge" title="Workspace 已隐藏 — 在 Settings 里管理">
    <SvgIcon d={ICON.eyeOff} size={11} />
  </span>
)}
```

CSS in `gian-v2.css`:

```css
.ri-hidden-badge {
  position: absolute; top: 7px; right: 28px;
  width: 14px; height: 14px;
  color: var(--text-3); opacity: 0.7;
  display: inline-flex; align-items: center; justify-content: center;
}
```

Pass `wsHidden={wsById.get(s.workspace_id)?.hidden ?? false}` from each `renderRow` call.

> Add `eyeOff` to the `ICON` map:
>
> ```ts
> eyeOff: 'M2 2l12 12M6.5 6.5a2 2 0 0 0 2.8 2.8M3.5 4.5a8 8 0 0 0-1.5 3.5C3 11.5 5.5 13 8 13a8 8 0 0 0 4-1.1M9 3a8 8 0 0 1 5 5 8 8 0 0 1-1 2',
> ```

- [ ] **Step 4: NewSessionView — grey out hidden workspaces in the picker**

In `NewSessionView` (around line 824 onwards), in the `<select>` rendering workspaces:

```tsx
{workspaces.map(w => (
  <option key={w.id} value={w.id} disabled={w.hidden}>
    {w.name}{w.hidden ? ' (隐藏)' : ''}
  </option>
))}
```

If the currently-selected workspace (`selectedWs`) is hidden, fall back to the first non-hidden one in the initial `useState`:

```tsx
const [selectedWs, setSelectedWs] = useState(
  workspaces.find(w => !w.hidden)?.id ?? workspaces[0]?.id ?? ''
);
```

- [ ] **Step 5: Visual + smoke check**

Manually hide a workspace via dev tools fetch (or temporarily a button — Task 12 wires the real UI):

```js
fetch('/api/workspaces/<id>', { method:'PATCH', headers:{'content-type':'application/json'}, body:'{"hidden":true}' })
```

Reload. Confirm:
- Hidden workspace's sessions disappear from sidebar
- If you had it active, the row stays with an eye-off badge
- New session dropdown shows the workspace greyed out

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/views/CodingView.tsx packages/web/src/styles/gian-v2.css
git commit -m "feat(web): hide sessions of hidden workspaces; badge active row; grey picker"
```

---

### Task 12: Settings UI — Workspaces section + sidebar bottom recovery link

**Files:**
- Modify: `packages/web/src/components/SettingsBody.tsx` — new "Workspaces" section
- Modify: `packages/web/src/views/CodingView.tsx` — sidebar bottom hidden link
- Modify: `packages/web/src/styles/gian-v2.css` — `.sb-hidden-link` style
- Modify: `packages/web/test/settings-appearance.test.tsx` — assert toggle calls API

- [ ] **Step 1: Pass workspaces into SettingsBody**

The Settings panel needs the workspace list. Find `<SettingsBody … />` in App.tsx, pass `workspaces={workspaces}` and an `onUpdateWorkspace` callback. Type changes:

```tsx
interface Props {
  config: SystemConfig | null;
  onChange: (cfg: SystemConfig) => void;
  workspaces: Workspace[];
  onUpdateWorkspace: (id: string, patch: { hidden?: boolean }) => Promise<void>;
}
```

In App.tsx, supply:

```tsx
onUpdateWorkspace={async (id, patch) => {
  const ws = await updateWorkspace(id, patch);
  if (ws) setWorkspaces(prev => prev.map(w => w.id === id ? ws : w));
}}
```

- [ ] **Step 2: Add Workspaces section in SettingsBody**

After the Appearance section, before Executors:

```tsx
<div className="settings-eyebrow">Workspaces</div>
<div className="settings-section">
  {workspaces.length === 0
    ? <p className="settings-empty">尚未创建 workspace。</p>
    : (
      <ul className="ws-list">
        {workspaces.map(w => (
          <li key={w.id} className={`ws-row${w.hidden ? ' hidden' : ''}`}>
            <div className="ws-meta">
              <span className="ws-name">{w.name}</span>
              <span className="ws-path mono">{w.path}</span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={!w.hidden}
                onChange={e => void onUpdateWorkspace(w.id, { hidden: !e.target.checked })}
              />
              <span>{w.hidden ? '隐藏' : '显示'}</span>
            </label>
          </li>
        ))}
      </ul>
    )}
</div>
```

CSS — add to `gian-v2.css` or a settings stylesheet:

```css
.ws-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.ws-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
.ws-row.hidden .ws-name { color: var(--text-3); }
.ws-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ws-name { font: 500 var(--fz-13)/1.3 var(--font-sans); color: var(--text); }
.ws-path { font: 11px/1 var(--font-mono); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 3: Sidebar bottom recovery link**

In `CodingView.tsx` Sidebar, after the Archived button block (line ~648):

```tsx
{(() => {
  const hiddenCount = workspaces.filter(w => w.hidden).length;
  if (hiddenCount === 0) return null;
  return (
    <button
      type="button"
      className="sb-hidden-link"
      onClick={onOpenSettings /* prop wired from CodingView → App */}
    >
      ↳ {hiddenCount} hidden workspace{hiddenCount === 1 ? '' : 's'} · manage
    </button>
  );
})()}
```

CSS (sibling to `.sb-archived` block):

```css
.sb-hidden-link {
  display: flex; align-items: center;
  margin: 4px 6px 0;
  padding: 6px 8px;
  border-radius: var(--r-1);
  background: transparent; border: 0;
  font: 500 11px/1 var(--font-sans);
  color: var(--text-3);
  cursor: pointer;
  width: calc(100% - 12px);
  text-align: left;
}
.sb-hidden-link:hover { background: var(--surface-2); color: var(--text); }
```

`onOpenSettings` plumbing: thread a callback from App.tsx → CodingView → Sidebar that opens the settings workbench tab on the workspaces section. Existing pattern uses workbench tabs; reuse it (look at how `<FilesView onOpenSettings>` is wired — open-with PR already established this).

- [ ] **Step 4: Extend Settings test**

Add to `packages/web/test/settings-appearance.test.tsx`:

```tsx
it('toggling workspace visibility calls onUpdateWorkspace with hidden flag', async () => {
  const onUpdate = vi.fn(async () => {});
  const workspaces = [{ id: 'w1', name: 'A', path: '/tmp/a', sort_order: 0, hidden: false, created_at: '', updated_at: '' }];
  render(<SettingsBody config={baseConfig} onChange={() => {}} workspaces={workspaces} onUpdateWorkspace={onUpdate} />);
  fireEvent.click(screen.getByLabelText(/显示/));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('w1', { hidden: true }));
});
```

Run: `pnpm -F @gian/web test settings-appearance`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/SettingsBody.tsx packages/web/src/views/CodingView.tsx packages/web/src/styles/gian-v2.css packages/web/src/App.tsx packages/web/test/settings-appearance.test.tsx
git commit -m "feat(web): Settings Workspaces section + sidebar hidden-workspaces footer link"
```

---

## Phase 6 — Gian mascot

### Task 13: GianMascot component (static + animated Boombox-G)

**Files:**
- Create: `packages/web/src/components/GianMascot.tsx`
- Modify: `packages/web/src/styles/gian-v2.css` (add `.gian-mascot` styles + keyframes)

- [ ] **Step 1: Create the component**

Use the Boombox-G concept from `docs/mockups/2026-05-21-gian-mascot.html`. Copy the static + working SVG path content from that file's "Concept 1" section into the component.

`packages/web/src/components/GianMascot.tsx`:

```tsx
import type { JSX } from 'react';

export function GianMascot({
  size = 32,
  state = 'idle',
  title,
}: {
  size?: number;
  state?: 'idle' | 'working';
  title?: string;
}): JSX.Element {
  return state === 'working' ? (
    <GianWorking size={size} title={title ?? 'Working…'} />
  ) : (
    <GianStatic size={size} title={title ?? 'Gian'} />
  );
}

function GianStatic({ size, title }: { size: number; title: string }) {
  return (
    <svg className="gian-mascot" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <title>{title}</title>
      {/* paste Concept 1 STATIC paths from the mockup file here.
          Wrap all fills/strokes with currentColor or var(--accent) for theme adaptation. */}
    </svg>
  );
}

function GianWorking({ size, title }: { size: number; title: string }) {
  return (
    <svg className="gian-mascot working" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <title>{title}</title>
      {/* paste Concept 1 WORKING paths + animated <g> from the mockup file.
          Keep the CSS keyframes inside this component's matching .css rule
          (see Step 2) — not inline — so they're easy to tune. */}
    </svg>
  );
}
```

> Don't re-design the SVG — the mockup is the source of truth. Just port the markup faithfully. If a path uses a hardcoded color from the mockup, replace with `currentColor` / `var(--accent)` / `var(--text)` to follow the theme.

- [ ] **Step 2: Mascot styles + keyframes**

In `gian-v2.css`, add a section near the end:

```css
/* ---------- Gian mascot ---------- */
.gian-mascot { display: inline-block; vertical-align: middle; color: var(--text); }
.gian-mascot.working { /* shared offset / origin tweaks if needed */ }
.gian-mascot.working .g-mouth   { animation: gian-mouth   1.8s var(--ease) infinite; transform-origin: center; }
.gian-mascot.working .g-wave    { animation: gian-wave    1.2s linear infinite; }
.gian-mascot.working .g-shake   { animation: gian-shake   0.18s ease-in-out infinite alternate; }
@keyframes gian-mouth { 0%,40%,100% { transform: scaleY(0.6); } 20%,60%,80% { transform: scaleY(1.05); } }
@keyframes gian-wave  { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -24; } }
@keyframes gian-shake { from { transform: translate(-0.25px, 0); } to { transform: translate(0.25px, 0); } }
```

> Names like `.g-mouth` / `.g-wave` / `.g-shake` must match the class names you used inside the SVG when porting the mockup paths.

- [ ] **Step 3: Drop into a sandbox page to verify**

Easiest sanity check: temporarily render `<GianMascot size={96} state="working" />` in `App.tsx` somewhere visible, confirm animation runs smoothly on light/warm/dark.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/GianMascot.tsx packages/web/src/styles/gian-v2.css
git commit -m "feat(web): GianMascot component — Boombox-G static + working"
```

---

### Task 14: Mascot in main-head + kill per-card thinking

**Files:**
- Modify: `packages/web/src/views/CodingView.tsx:1283-1300` (MainPane main-head)
- Modify: `packages/web/src/transcript/apply.ts` and/or `packages/web/src/transcript/items.tsx`

- [ ] **Step 1: Add the mascot to main-head**

In `MainPane`, just inside `<div className="main-head">`, insert at the start of `main-head-l` (left side):

```tsx
<GianMascot
  size={24}
  state={(session.status === 'running' || session.status === 'pending') ? 'working' : 'idle'}
  title={session.status === 'running' ? 'Working…' : session.status === 'pending' ? 'Waiting for approval' : 'Idle'}
/>
```

Import: `import { GianMascot } from '../components/GianMascot.js';`

- [ ] **Step 2: Find the per-card "thinking" surface**

Run: `Grep -n "thinking" packages/web/src/transcript/`
Inspect each match. Anything that renders a string like "thinking…" or "Thinking…" purely as a transient label in the transcript should be removed. Keep:
- model-emitted reasoning content (proper thinking blocks)
- session-level status (already covered by mascot)

Edit the file(s) to no longer render the transient label. If it's a component that ONLY does that, delete the component and its import sites.

- [ ] **Step 3: Verify visually**

Run the dev server. Start a turn — the mascot animates while running, falls back to idle when done. Scroll the transcript; mascot stays put (it's in `.main-head`, outside the scroll container). No more flickering "thinking…" rows in between cards.

- [ ] **Step 4: Run the web test suite**

Run: `pnpm -F @gian/web test`
Expected: PASS. If any tests asserted on the "thinking" text, drop those assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/views/CodingView.tsx packages/web/src/transcript
git commit -m "feat(web): wire GianMascot to session.status; remove flicker thinking text"
```

---

## Phase 7 — Cleanup & docs

### Task 15: Update traceability + STATE + session log

**Files:**
- Modify: `docs/quality/traceability.md`
- Modify: `docs/ai/STATE.md`
- Modify: `docs/ai/SESSION_LOG.md`

- [ ] **Step 1: traceability — add rows per feature**

Append the following requirement rows (or adapt to the existing schema):

```
UI-FONT-001     | per-zone font scale            | packages/web/src/styles/tokens.css#zone-scale  | packages/web/test/settings-appearance.test.tsx
UI-ROW-001      | executor color bar + branch    | packages/web/src/views/CodingView.tsx (SessionRow) | manual
UI-GROUP-001    | collapsible session groups     | packages/web/src/views/CodingView.tsx (renderGroups) | manual
UI-WS-HIDE-001  | hide / unhide workspace        | packages/host/src/web/app.ts (PATCH workspace) | packages/host/test/workspace-hide.test.ts
UI-ACCENT-001   | 8 accents + theme reset        | packages/web/src/styles/tokens.css, SettingsBody.tsx | packages/web/test/settings-appearance.test.tsx
UI-MASCOT-001   | GianMascot driven by status    | packages/web/src/components/GianMascot.tsx, CodingView.tsx (MainPane) | manual
```

- [ ] **Step 2: STATE.md — replace the active work item**

Delete the stale Codex CLI block (the work is committed at `50d9e20`). Set:

```markdown
## Active work item

**Session UI polish — implementation in progress**
Spec: `docs/superpowers/specs/2026-05-21-session-ui-polish-design.md`
Plan: `docs/superpowers/plans/2026-05-21-session-ui-polish.md`
Phases 0–6 land independently; current progress in commit log.

## Blockers

_None._

## Next step

Run `pnpm -F @gian/web dev` and walk the QA checklist (per zone font, hide/unhide a workspace, every theme × every accent, start a turn and confirm the mascot animates).
```

- [ ] **Step 3: SESSION_LOG.md — append a new entry at the top**

```markdown
## 2026-05-21 — Session UI polish — landed

Bundle 6 UI improvements: per-zone font scale, executor color bar + branch
in session row, collapsible workspace groups with count, hide/unhide
workspaces with discovery footer, 8-color accent palette with theme-bound
defaults that reset on theme switch, original Gian "Boombox-G" mascot
animation replacing flickering per-card "thinking" text. Plan executed
across 14 tasks; data foundation (SystemConfig + Workspace.hidden +
runtime sanitize) in Phase 0, then five parallelizable visual phases.
```

- [ ] **Step 4: Commit**

```bash
git add docs/quality/traceability.md docs/ai/STATE.md docs/ai/SESSION_LOG.md
git commit -m "docs: traceability + STATE + session log for UI polish bundle"
```

---

## Self-review notes

- **Spec coverage:** Tasks map to spec sections — §3 (Task 6/7), §4 (Task 8), §5 (Task 9), §6 (Tasks 2/10/11/12), §7 (Tasks 4/5 + Task 3 sanitize), §8 (Tasks 13/14). §9 (model summary), §10 (compat/migration), §11 (testing) covered by Tasks 1–3 + test additions in 5/10/12.
- **No placeholders:** all code blocks contain the actual code to write. Where the SVG paths are non-trivial (Task 13), the source is referenced (the committed mockup file), not "TBD".
- **Type consistency:** `Accent` / `FontScale` / `THEME_DEFAULT_ACCENT` introduced in Task 1 and referenced consistently in Tasks 3, 5, 7.
- **Migration number:** 022 (latest existing is 021_runtime_mode.sql per `ls packages/host/migrations/`).
- **One identified handoff issue:** `onOpenSettings` plumbing in Task 12 step 3 references an existing pattern from the open-with PR — if that's been refactored, the implementer should grep for similar usage in `App.tsx` / `CodingView.tsx` and follow whatever is current.
