import { expect, test, type Page } from '@playwright/test';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openNewSession, waitForAppReady } from '../fixtures/navigation.js';

test.skip(
  process.env['GIAN_E2E_PROXY_MOCK'] !== '1',
  'Runs only through pnpm test:e2e:proxy-mock.',
);
test.describe.configure({ mode: 'serial' });

const dataDir = process.env['GIAN_E2E_DATA_DIR']!;
const providerId = process.env['GIAN_E2E_PROXY_PROVIDER'] ?? 'codex';
const agentId = process.env['GIAN_E2E_PROXY_AGENT_ID'] ?? `e2e-${providerId}-agent`;
const pluginId = process.env['GIAN_E2E_PROXY_PLUGIN_ID'] ?? providerId;
const processScope = process.env['GIAN_E2E_PROXY_PROCESS_SCOPE'] ?? 'shared';
const providerCapabilities = new Set<string>(JSON.parse(
  process.env['GIAN_E2E_PROXY_CAPABILITIES'] ?? '[]',
));
const workspacePath = join(dataDir, 'proxy-mock-workspace');
const screenshotDir = process.env['PROXY_MOCK_SCREENSHOT_DIR'];
const title = 'proxy-v2-mock-e2e';
let workspaceId = '';
let sessionId = '';
let agentName = providerId;

interface CapturedRequest {
  method: string;
  params?: Record<string, unknown>;
}

async function capturedRequests(): Promise<CapturedRequest[]> {
  const proxyRoot = join(dataDir, 'proxy');
  let entries: string[] = [];
  try {
    entries = await readdir(proxyRoot);
  } catch {
    return [];
  }
  const requests: CapturedRequest[] = [];
  for (const entry of entries) {
    try {
      const raw = await readFile(join(proxyRoot, entry, 'received.ndjson'), 'utf8');
      for (const line of raw.split('\n').filter(Boolean)) {
        requests.push(JSON.parse(line) as CapturedRequest);
      }
    } catch {
      // A process can exit between directory discovery and the read.
    }
  }
  return requests;
}

async function controlMockSession(command: Record<string, unknown>): Promise<void> {
  const proxyRoot = join(dataDir, 'proxy');
  const entries = await readdir(proxyRoot);
  for (const entry of entries) {
    try {
      const descriptor = JSON.parse(
        await readFile(join(proxyRoot, entry, 'mock-control.json'), 'utf8'),
      ) as { controlFile: string; requestLog: string };
      const requests = (await readFile(descriptor.requestLog, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as CapturedRequest);
      const ownsSession = requests.some(request => (
        request.method === 'session.create'
        && request.params?.sessionId === sessionId
      ));
      if (!ownsSession) continue;
      await appendFile(descriptor.controlFile, `${JSON.stringify({
        requestId: `e2e-${Date.now()}`,
        sessionId,
        ...command,
      })}\n`);
      return;
    } catch {
      // A per-session process can exit while its descriptor is inspected.
    }
  }
  throw new Error(`No live Mock Proxy owns session ${sessionId}`);
}

async function switchToSessions(page: Page): Promise<void> {
  // The Repos section header always renders in the Sessions rail (2026-09-07:
  // it replaced the top-row sb-new-session button as the mode marker).
  if (await page.getByTestId('sb-section-projects').count() === 0) {
    if (await page.getByTestId('sb-list-switch').count()) {
      await page.getByTestId('sb-list-switch').click();
      await page.getByTestId('sb-mode-project').click();
    } else {
      await page.getByTestId('rail-nav-chat').click();
      await page.getByTestId('sb-list-switch').click();
      await page.getByTestId('sb-mode-project').click();
    }
  }
}

async function openSession(page: Page, name = title): Promise<void> {
  await waitForAppReady(page);
  await switchToSessions(page);
  await page.getByText(name, { exact: true }).first().click();
  await expect(sessionComposer(page)).toBeVisible();
}

function sessionComposer(page: Page) {
  return page.getByRole('textbox', {
    name: /Input message|输入消息|message will be queued|消息将加入队列/,
  });
}

async function send(page: Page, text: string): Promise<void> {
  const composer = sessionComposer(page);
  await expect(composer).toBeEnabled();
  await composer.fill(text);
  await page.getByRole('button', { name: /Send|发送/ }).click();
}

async function selectCertificationAgent(page: Page): Promise<void> {
  const picker = page.getByTestId('ns-agent-picker');
  await expect(picker).toContainText(agentName);
  if (await picker.evaluate(element => element.tagName !== 'BUTTON')) return;
  await picker.click();
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('dialog').getByRole('button', {
    name: new RegExp(escaped, 'i'),
  }).click();
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: join(screenshotDir, `${name}.png`),
    fullPage: true,
  });
}

test.beforeAll(async ({ request }) => {
  await mkdir(workspacePath, { recursive: true });
  const response = await request.post('/api/workspaces', {
    data: {
      name: 'proxy-mock-workspace',
      path: workspacePath,
    },
  });
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { workspace: { id: string } };
  workspaceId = payload.workspace.id;
});

test('1. catalog drives new-session config and the exact create/start payload', async ({ page }) => {
  await page.goto('/');
  const agentStatus = await page.request.get(`/api/agents/${encodeURIComponent(agentId)}?refresh=1`);
  const agent = await agentStatus.json() as { name?: string; ready?: boolean };
  expect(agent.ready, JSON.stringify(agent)).toBe(true);
  agentName = agent.name ?? agentId;
  await switchToSessions(page);
  await openNewSession(page);
  await selectCertificationAgent(page);
  await expect(page.getByTestId('ns-agent-option-grok')).toHaveCount(0);

  await page.getByLabel('Workspace Mock').selectOption('strict');
  if (providerId === 'dsh') {
    await page.getByLabel('Mock Model').selectOption('mock-vision');
  } else {
    await page.getByTestId('ns-model-chip').click();
    await expect(page.getByRole('button', { name: /Mock Vision/ })).toBeVisible();
    await page.getByRole('button', { name: /Mock Vision/ }).click();
  }
  const newSessionOptions = providerId === 'dsh'
    ? page.getByTestId('ns-session-config')
    : page.getByTestId('ns-model-chip');
  const newSessionOptionText = await newSessionOptions.textContent();
  if (providerId === 'dsh') {
    expect(newSessionOptionText).toMatch(/Workspace Mock.*Mock Model/);
    expect(newSessionOptionText).not.toMatch(/Verbosity|Trace|Agent/);
  } else {
    expect(newSessionOptionText).not.toMatch(/Verbosity|Trace|Agent|Workspace Mock/);
  }
  if (processScope === 'shared' && providerCapabilities.has('catalog.resolve')) {
    await expect.poll(async () => (
      (await capturedRequests()).some(request => (
        request.method === 'catalog.resolve'
        && ((request.params?.sessionConfig as Record<string, unknown> | undefined)?.model
          ?? (request.params?.turnConfig as Record<string, unknown> | undefined)?.model) === 'mock-vision'
        && (request.params?.turnConfig as Record<string, unknown> | undefined)?.mock_trace === true
      ))
    )).toBe(true);
    await expect(page.getByTestId('ns-catalog-options')).toContainText('Mock Trace: true');
  }
  await page.getByTestId('ns-title-input').fill(title);
  await page.getByTestId('ns-message-input').fill('/mock gallery');
  await screenshot(page, '01-catalog-before-send');
  await page.getByTestId('ns-send').click();

  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Mock text content', { exact: false })).toBeVisible();
  await expect(page.getByText('/mock gallery', { exact: true })).toHaveCount(1);
  await expect.poll(async () => (
    (await capturedRequests()).some(request => request.method === 'turn.start')
  )).toBe(true);
  const requests = await capturedRequests();
  const create = requests.find(request => request.method === 'session.create')!;
  sessionId = String(create.params?.sessionId);
  expect(create.params?.config).toMatchObject(providerId === 'dsh'
    ? { workspace_mode: 'strict', model: 'mock-vision' }
    : { workspace_mode: 'strict' });
  const start = requests.find(request => request.method === 'turn.start')!;
  expect(start.params?.config).toMatchObject(providerId === 'dsh'
    ? { mock_trace: true }
    : processScope === 'shared' && providerCapabilities.has('catalog.resolve')
      ? { model: 'mock-vision', mock_trace: true }
      : { model: 'mock-vision' });
  const sessionModel = page.getByTestId('composer-model-chip');
  const sessionThinking = page.getByTestId('composer-thinking-chip');
  if (providerId === 'dsh') await expect(sessionModel).toHaveCount(0);
  else await expect(sessionModel).toContainText('Mock Vision');
  await expect(sessionThinking).toContainText('Medium');
  for (const hiddenOption of ['Mock Verbosity', 'Mock Trace', 'Mock Execution', 'Workspace Mock']) {
    await expect(page.getByText(hiddenOption, { exact: true })).toHaveCount(0);
  }
  await screenshot(page, '01-catalog-create-start-result');
  if (providerId !== 'dsh') {
    await sessionModel.click();
    await expect(page.getByRole('dialog')).not.toContainText('Mock Trace');
    await page.keyboard.press('Escape');
  }
});

test('2. the event gallery reaches real transcript cards', async ({ page }) => {
  await openSession(page);
  await expect(page.getByText('Mock text content', { exact: false })).toBeVisible();
  const turnSummary = page.locator('.turnsum').last();
  await expect(turnSummary).toBeVisible();
  // 2026-08-27: Working blocks default expanded, terminal blocks default
  // collapsed — expand only when the body is not already visible.
  if (await page.getByTestId('turn-work-preview').count() === 0
    && await page.locator('.turnsum-body').count() === 0) {
    await turnSummary.click();
  }
  for (const label of [
    'pnpm mock:test',
    'README.md',
    'gian.proxy/2.0',
    'Mock subagent',
    'Mock warning',
    'Mock tool',
    'Unknown activity',
  ]) {
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
  }
  if (providerCapabilities.has('event.plan')) {
    await expect(page.locator('.plan-chip')).toBeVisible();
  } else {
    await expect(page.locator('.plan-chip')).toHaveCount(0);
  }
  if (providerCapabilities.has('event.step') && providerCapabilities.has('event.request')) {
    await send(page, '/mock step-request');
    await expect(page.getByText('Step-linked mock response', { exact: true })).toBeVisible();
  }
  await screenshot(page, '02-event-gallery-expanded');
  await page.getByRole('button', { name: 'Trace', exact: true }).click();
  await expect(page.getByTestId('trace-view')).toBeVisible();
  await screenshot(page, '02-trace-view');
  await page.locator('[data-testid^="trace-row-"]').first().click();
  await expect(page.locator('.chat-context-panel')).toBeVisible();
  await screenshot(page, '02-trace-detail');
});

test('3. permission Interaction shows exact approval actions', async ({ page }) => {
  test.skip(!providerCapabilities.has('interaction'), 'Proxy does not advertise interaction.');
  await openSession(page);
  const responsesBefore = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond').length;
  await send(page, '/mock interaction-permission');
  await expect(page.getByText('src/mock.ts', { exact: true })).toBeVisible();
  await expect(page.getByText('Mock Proxy wants to update src/mock.ts.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow for this session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
  await screenshot(page, '03-interaction-permission-requested');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();

  await expect.poll(async () => (
    (await capturedRequests()).filter(request => request.method === 'interaction.respond').length
  )).toBe(responsesBefore + 1);
  const response = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond')
    .at(-1)!;
  expect(response.params).toMatchObject({ actionId: 'allow-once', values: {} });
  await expect(page.getByText('Mock action received: allow-once', { exact: true })).toHaveCount(1);
  await expect(page.locator('.msg.user.pending')).toHaveCount(0);
  await screenshot(page, '03-interaction-permission-resolved');
});

test('4. question Interaction collects one free-form answer', async ({ page }) => {
  test.skip(!providerCapabilities.has('interaction'), 'Proxy does not advertise interaction.');
  await openSession(page);
  const responsesBefore = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond').length;
  await send(page, '/mock interaction-question');
  await expect(page.getByText('What should the mock change?', { exact: true })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Submit answer', exact: true });
  await expect(submit).toBeDisabled();
  await screenshot(page, '04-interaction-question-requested');
  await page.getByLabel('Answer').fill('Keep the interaction concise.');
  await expect(submit).toBeEnabled();
  await screenshot(page, '04-interaction-question-filled');
  await submit.click();

  await expect.poll(async () => (
    (await capturedRequests()).filter(request => request.method === 'interaction.respond').length
  )).toBe(responsesBefore + 1);
  const response = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond')
    .at(-1)!;
  expect(response.params).toMatchObject({
    actionId: 'submit-answer',
    values: { answer: 'Keep the interaction concise.' },
  });
  await expect(page.getByText('Mock action received: submit-answer', { exact: true })).toHaveCount(1);
  await screenshot(page, '04-interaction-question-resolved');
});

test('5. choice Interaction returns one Proxy-owned option value', async ({ page }) => {
  test.skip(!providerCapabilities.has('interaction'), 'Proxy does not advertise interaction.');
  await openSession(page);
  const responsesBefore = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond').length;
  await send(page, '/mock interaction-choice');
  await expect(page.getByText('Choose a validation target', { exact: true })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(submit).toBeDisabled();
  await screenshot(page, '05-interaction-choice-requested');
  await page.getByRole('radio', { name: 'Packaged app', exact: true }).check();
  await expect(submit).toBeEnabled();
  await screenshot(page, '05-interaction-choice-selected');
  await submit.click();

  await expect.poll(async () => (
    (await capturedRequests()).filter(request => request.method === 'interaction.respond').length
  )).toBe(responsesBefore + 1);
  const response = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond')
    .at(-1)!;
  expect(response.params).toMatchObject({
    actionId: 'submit-choice',
    values: { environment: 'packaged' },
  });
  await expect(page.getByText('Mock action received: submit-choice', { exact: true })).toHaveCount(1);
  await screenshot(page, '05-interaction-choice-resolved');
});

test('6. confirmation Interaction needs actions but no form inputs', async ({ page }) => {
  test.skip(!providerCapabilities.has('interaction'), 'Proxy does not advertise interaction.');
  await openSession(page);
  const responsesBefore = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond').length;
  await send(page, '/mock interaction-confirmation');
  await expect(page.getByText('output/mock-artifacts', { exact: true })).toBeVisible();
  await expect(page.getByText('This removes only files created by the Mock Proxy.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Answer')).toHaveCount(0);
  await expect(page.getByLabel('Environment')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep artifacts', exact: true })).toBeVisible();
  await screenshot(page, '06-interaction-confirmation-requested');
  await page.getByRole('button', { name: 'Delete artifacts', exact: true }).click();

  await expect.poll(async () => (
    (await capturedRequests()).filter(request => request.method === 'interaction.respond').length
  )).toBe(responsesBefore + 1);
  const response = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond')
    .at(-1)!;
  expect(response.params).toMatchObject({ actionId: 'confirm', values: {} });
  await expect(page.getByText('Mock action received: confirm', { exact: true })).toHaveCount(1);
  await expect(page.locator('.msg.user.pending')).toHaveCount(0);
  await screenshot(page, '06-interaction-confirmation-resolved');
});

test('6b. an unadvertised Interaction has no approval UI or response call', async ({ page }) => {
  test.skip(providerCapabilities.has('interaction'), 'Proxy advertises interaction.');
  await openSession(page);
  const responsesBefore = (await capturedRequests())
    .filter(request => request.method === 'interaction.respond').length;
  await send(page, '/mock interaction-permission');
  await expect(page.getByText('Interaction capability unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0);
  expect((await capturedRequests())
    .filter(request => request.method === 'interaction.respond')).toHaveLength(responsesBefore);
  await screenshot(page, '06b-interaction-not-advertised');
});

test('7. steer capability gates mid-turn injection and interrupt reaches a terminal event', async ({ page }) => {
  await openSession(page);
  await send(page, '/mock running');
  await expect(page.getByText('Mock turn is waiting for steer or stop')).toBeVisible();
  await screenshot(page, '07-running-before-steer');
  const composer = sessionComposer(page);
  await composer.fill('continue carefully');
  await composer.press('Control+Enter');
  if (providerCapabilities.has('turn.steer')) {
    await expect(page.getByText('Mock steer received: continue carefully')).toBeVisible();
    await screenshot(page, '07-steer-received');
  } else {
    const queue = page.locator('.queue-drawer');
    await expect(queue).toContainText('continue carefully');
    await expect(page.getByText('Mock steer received: continue carefully')).toHaveCount(0);
    await screenshot(page, '07-steer-not-advertised-queued');
  }

  const stop = page.getByRole('button', { name: /Stop|停止/ });
  await stop.click();
  await expect(stop).toBeVisible();
  await expect(stop).toBeHidden({ timeout: 5_000 });
  if (providerCapabilities.has('turn.steer')) {
    await expect(page.getByText('Mock steer received: continue carefully', { exact: true })).toHaveCount(1);
  } else {
    const queue = page.locator('.queue-drawer');
    await expect(queue).toContainText('continue carefully');
    await queue.getByRole('button', { name: /Remove|移除/ }).click();
    await expect(queue).toHaveCount(0);
  }
  await expect(page.locator('.msg.user.pending')).toHaveCount(0);
  const methods = (await capturedRequests()).map(request => request.method);
  if (providerCapabilities.has('turn.steer')) expect(methods).toContain('turn.steer');
  else expect(methods).not.toContain('turn.steer');
  expect(methods).toContain('turn.interrupt');
  await screenshot(page, '07-interrupt-terminal');
});

test('8. a normal send while busy queues, renders, and drains into the next turn', async ({ page }) => {
  await openSession(page);
  const startsBefore = (await capturedRequests())
    .filter(request => request.method === 'turn.start').length;

  await send(page, '/mock running');
  await expect(page.getByText('Mock turn is waiting for steer or stop')).toBeVisible();

  const composer = sessionComposer(page);
  await composer.fill('queued follow-up');
  await composer.press('Enter');
  const queue = page.locator('.queue-drawer');
  await expect(queue).toBeVisible();
  await expect(queue).toContainText('queued follow-up');
  await screenshot(page, '08-queue-visible');

  await controlMockSession({ action: 'scenario', name: 'finish-running' });
  await expect(page.getByText('Mock Proxy received: finish-running')).toBeVisible();
  await expect(page.getByText('Mock Proxy received: echo')).toBeVisible();
  await expect(queue).toHaveCount(0);
  await expect.poll(async () => (
    (await capturedRequests()).filter(request => request.method === 'turn.start').length
  )).toBe(startsBefore + 2);

  const queuedStart = (await capturedRequests())
    .filter(request => request.method === 'turn.start')
    .at(-1)!;
  expect(queuedStart.params?.input).toEqual([{ type: 'text', text: 'queued follow-up' }]);
  await expect(page.getByText('queued follow-up', { exact: true })).toHaveCount(1);
  await expect(page.locator('.msg.user.pending')).toHaveCount(0);
  await screenshot(page, '08-queue-drained');
});

test('9. rename plus native adopt/replay cross the generic Proxy client', async ({ page }) => {
  await openSession(page);
  await page.locator('.path-seg.session').click();
  await page.getByText(/Rename|重命名/, { exact: true }).click();
  const input = page.locator('.path-rename-input');
  await input.fill('proxy-v2-mock-renamed');
  await input.press('Enter');
  await expect(page.getByText('proxy-v2-mock-renamed', { exact: true }).first()).toBeVisible();
  if (providerCapabilities.has('session.rename')) {
    await expect.poll(async () => (
      (await capturedRequests()).some(request => (
        request.method === 'session.rename'
        && request.params?.name === 'proxy-v2-mock-renamed'
      ))
    )).toBe(true);
  } else {
    await page.waitForTimeout(250);
    expect((await capturedRequests()).some(request => request.method === 'session.rename')).toBe(false);
  }
  await screenshot(page, '09-session-renamed');

  if (await page.getByTestId('settings-body').count() === 0) {
    await page.getByTestId('dock-settings').click();
  }
  await expect(page.getByTestId('settings-body')).toBeVisible();
  const adoptNavigation = page.locator('.s2-navitem').filter({ hasText: /Adopt|接入会话/ });
  await expect(adoptNavigation).toBeVisible();
  await adoptNavigation.evaluate((element: HTMLElement) => element.click());
  await expect(page.getByTestId('settings-adopt-page')).toBeVisible();
  const loading = page.getByText('Loading…', { exact: true });
  await expect(loading).toBeHidden({ timeout: 20_000 });
  const providerFilter = page.getByLabel(/Filter native sessions by provider|按 Provider 筛选原生会话/);
  if (!providerCapabilities.has('session.native.list')) {
    await expect(providerFilter.locator(`option[value="${pluginId}"]`)).toHaveCount(0);
    expect((await capturedRequests()).some(request => request.method === 'session.native.list')).toBe(false);
    await screenshot(page, '09-native-list-not-advertised');
    return;
  }
  await providerFilter.selectOption(pluginId);
  await page.getByLabel(/Filter native sessions by Repo|按 Repo 筛选原生会话/)
    .selectOption(workspaceId);
  const refreshed = page.waitForResponse(response => (
    response.request().method() === 'GET'
    && response.url().endsWith(`/api/workspaces/${workspaceId}/native-sessions`)
  ));
  await page.getByTestId('settings-adopt-page')
    .getByRole('button', { name: /Refresh|刷新/ })
    .click();
  const refreshResponse = await refreshed;
  expect(refreshResponse.ok()).toBe(true);
  const refreshPayload = await refreshResponse.json() as {
    sessions?: Array<{ executor?: string; firstUserMessage?: string }>;
  };
  expect(
    refreshPayload.sessions?.some(session => (
      session.executor === pluginId
      && session.firstUserMessage === 'Existing mock native session'
    )),
    JSON.stringify(refreshPayload),
  ).toBe(true);
  await expect(loading).toBeHidden({ timeout: 20_000 });
  const nativeRow = page.locator('.native-management-row').filter({
    hasText: 'Existing mock native session',
  });
  await expect(nativeRow).toBeVisible({ timeout: 20_000 });
  await nativeRow.getByRole('button', { name: /Adopt|接入/ }).click();
  const adoptDialog = page.locator('.adopt-dialog');
  await adoptDialog.getByPlaceholder('auto-generated').fill('proxy-v2-mock-adopted');
  await adoptDialog.getByRole('button', { name: /Adopt|接入/ }).click();
  await expect(page.getByText('Historical mock question')).toBeVisible();
  await expect(page.getByText('Historical mock answer')).toBeVisible();
  const methods = (await capturedRequests()).map(request => request.method);
  if (processScope === 'shared') expect(methods).toContain('session.native.list');
  expect(methods).toContain('session.replay');
  await screenshot(page, '09-native-adopt-replay');
});

test('10. catalog/history invalidation refetches catalog and replay', async ({ page }) => {
  await openSession(page, 'proxy-v2-mock-renamed');
  const before = await capturedRequests();
  const catalogsBefore = before.filter(request => request.method === 'catalog.list').length;
  const replaysBefore = before.filter(request => request.method === 'session.replay').length;
  await send(page, '/mock catalog-change');
  await expect(page.getByText(/Catalog revision 2/)).toBeVisible();
  await expect.poll(async () => (
    (await capturedRequests()).filter(request => request.method === 'catalog.list').length
  )).toBeGreaterThan(catalogsBefore);
  await screenshot(page, '10-catalog-invalidation');
  await send(page, '/mock history-change');
  await expect(page.getByText('History refresh requested')).toBeVisible();
  await expect.poll(async () => (
    (await capturedRequests()).filter(request => request.method === 'session.replay').length
  )).toBeGreaterThan(replaysBefore);
  await expect(page.getByText('Catalog revision 2', { exact: true })).toHaveCount(1);
  await expect(page.getByText('History refresh requested', { exact: true })).toHaveCount(1);
  await expect(page.locator('.msg.user.pending')).toHaveCount(0);
  await screenshot(page, '10-history-invalidation');
});

test('11. one protocol-faulted session does not prevent a fresh Proxy session', async ({ page }) => {
  await openSession(page, 'proxy-v2-mock-renamed');
  await send(page, '/mock fault');
  await expect.poll(async () => (
    (await capturedRequests()).some(request => (
      request.method === 'session.close'
      && request.params?.sessionId === sessionId
    ))
  )).toBe(true);
  await expect(page.getByTestId(`session-row-${sessionId}`)).not.toContainText('running');
  await expect(page.getByRole('button', { name: /Stop|停止/ })).toBeHidden();
  await screenshot(page, '11-session-protocol-fault');

  await openNewSession(page);
  await selectCertificationAgent(page);
  await page.getByTestId('ns-title-input').fill('proxy-v2-mock-after-fault');
  await page.getByTestId('ns-message-input').fill('echo');
  await page.getByTestId('ns-send').click();
  await expect(page.getByText('Mock Proxy received: echo')).toBeVisible();
  await expect(page.getByText('echo', { exact: true })).toHaveCount(1);
  expect(workspaceId).not.toBe('');
  await screenshot(page, '11-fresh-session-after-fault');
});
