import { expect, test, type BrowserContext } from '@playwright/test';

test.skip(process.env.GIAN_REMOTE_ACCEPTANCE !== '1',
  'Explicit deployed-Remote acceptance only; not part of the default E2E gate.');

const origin = process.env.GIAN_REMOTE_ACCEPTANCE_URL ?? 'https://gian-remote.fun';
const expectedBuild = process.env.GIAN_REMOTE_ACCEPTANCE_BUILD;
const nonce = 'acceptance-unclaimed-invitation-fixture';

async function rejectWrites(context: BrowserContext, attempts: string[]) {
  await context.route('**/api/**', async route => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      attempts.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await route.abort();
    } else await route.continue();
  });
}

test.beforeAll(async ({ request }, testInfo) => {
  const response = await request.get(new URL('/health', origin).href, { timeout: 15_000 });
  expect(response.ok()).toBe(true);
  const health = await response.json() as { ok: boolean; version: string; build_id: string };
  expect(health.ok).toBe(true);
  expect(health.build_id).toBe(expectedBuild);
  await testInfo.attach('remote-build', {
    body: JSON.stringify({ origin, version: health.version, build: health.build_id }),
    contentType: 'application/json',
  });
});

test('unclaimed invitation survives a second browser without consuming a real pairing', async ({ browser }) => {
  const scanner = await browser.newContext({ locale: 'en-US' });
  const target = await browser.newContext({ locale: 'en-US' });
  const writes: string[] = [];
  try {
    await rejectWrites(scanner, writes);
    await rejectWrites(target, writes);
    const scanPage = await scanner.newPage();
    const sourceUrl = new URL('/#nonce=' + nonce, origin).href;
    await scanPage.goto(sourceUrl);
    await expect(scanPage.locator('#pair-invitation-link')).toHaveValue(sourceUrl);
    const copiedLink = await scanPage.locator('#pair-invitation-link').inputValue();
    const targetPage = await target.newPage();
    await targetPage.goto(copiedLink);
    await expect(targetPage.locator('#pair-invitation-link')).toHaveValue(sourceUrl);
    await expect(targetPage.getByRole('button', { name: /Confirm pairing|确认配对/ })).toBeVisible();
    await targetPage.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
    const cancelled = targetPage.locator('[data-pair-failure="cancelled"]');
    await expect(cancelled).toBeVisible();
    expect(new URL(targetPage.url()).hash).not.toContain('nonce');
    await cancelled.getByRole('button', { name: /Start over|重新发起/ }).click();
    await expect(targetPage.locator('#pair-code')).toBeVisible();
    expect(new URL(targetPage.url()).hash).not.toContain('nonce');
    await expect(scanPage.locator('#pair-invitation-link')).toHaveValue(sourceUrl);
    expect(writes).toEqual([]);
  } finally { await scanner.close(); await target.close(); }
});

test('malformed invitations return to pairing without claiming or exposing the nonce', async ({ context, page }) => {
  const writes: string[] = [];
  await rejectWrites(context, writes);
  await page.goto(new URL('/#nonce=short', origin).href);
  await expect(page.locator('#pair-code')).toBeVisible();
  expect(new URL(page.url()).hash).not.toContain('nonce');
  await expect(page.locator('#pair-invitation-link')).toHaveCount(0);
  expect(writes).toEqual([]);
});
