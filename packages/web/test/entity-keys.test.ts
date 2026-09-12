import { describe, expect, it } from 'vitest';
import { agentEntityKey } from '../src/operations/agents.js';
import { browserExternalEntityKey } from '../src/operations/browser.js';
import { openExternalEntityKey } from '../src/operations/files.js';
import { gitAbortEntityKey, gitFetchEntityKey, gitIndexEntityKey } from '../src/operations/git.js';
import { gitHistoryFetchEntityKey } from '../src/operations/git-history.js';
import { nativeEntityKey } from '../src/operations/native.js';
import { sidechatEntityKey } from '../src/operations/sidechat.js';
import { scheduleConfirmationEntityKey, scheduleEntityKey } from '../src/operations/schedule.js';
import { taskEntityKey } from '../src/operations/task.js';
import { termEntityKey } from '../src/operations/terminal.js';
import { workspaceEntityKey } from '../src/operations/workspace.js';

describe('operation entity keys', () => {
  it('uses stable colon-separated prefixes', () => {
    expect(agentEntityKey('claude')).toBe('agent:claude');
    expect(taskEntityKey('t-1')).toBe('task:t-1');
    expect(workspaceEntityKey('ws-1')).toBe('workspace:ws-1');
    expect(sidechatEntityKey('sc-1')).toBe('sidechat:sc-1');
    expect(termEntityKey('term-9')).toBe('term:term-9');
    expect(nativeEntityKey('ws-1', 'codex', 'n-2')).toBe('native:ws-1:codex:n-2');
    expect(gitFetchEntityKey('ws-1')).toBe('git:ws-1:fetch');
    expect(gitAbortEntityKey('ws-1')).toBe('git:ws-1:abort');
    expect(gitIndexEntityKey('wt-1', 'src/a.ts')).toBe('git:wt-1:src/a.ts');
    expect(gitHistoryFetchEntityKey('wt-1')).toBe('git:wt-1:historyFetch');
    expect(browserExternalEntityKey('tab-9')).toBe('browser:external:tab-9');
    expect(scheduleEntityKey('sch-1')).toBe('schedule:sch-1');
    expect(scheduleConfirmationEntityKey('conf-1')).toBe('schedule-confirmation:conf-1');
  });

  it('openExternalEntityKey includes tree, path, and target tag', () => {
    expect(openExternalEntityKey({
      workingTreeId: 'wt-1',
      path: 'README.md',
      target: { kind: 'editor', editorId: 'ed-1' },
    })).toBe('files:open:wt-1:README.md:editor:ed-1');
    expect(openExternalEntityKey({
      workingTreeId: 'wt-1',
      path: '',
      target: { kind: 'reveal' },
    })).toBe('files:open:wt-1::reveal');
    expect(openExternalEntityKey({
      absolutePath: '/Users/me/.gian/attachments/s1/plan.html',
      target: { kind: 'builtin', builtin: 'default' },
    })).toBe('files:open:abs:/Users/me/.gian/attachments/s1/plan.html:builtin:default');
  });
});
