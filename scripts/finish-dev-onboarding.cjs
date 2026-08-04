// One-off: finish GianDev onboarding (Agents -> Directory) via CDP.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().startsWith('http://127.0.0.1:5191'));
  if (!page) throw new Error('gian web page not found');

  for (let step = 0; step < 6; step++) {
    await page.waitForTimeout(1000);
    const url_state = await page.evaluate(() => document.body.innerText.slice(0, 400));
    console.log(`--- step ${step} ---`);
    console.log(url_state.replace(/\n+/g, ' | ').slice(0, 300));

    const continueBtn = page.getByRole('button', { name: /continue|finish|get started|完成|继续/i });
    if (await continueBtn.count() > 0) {
      // If there is a directory input, log its value before continuing.
      const input = page.locator('input[type="text"], input:not([type])').first();
      if (await input.count() > 0) {
        console.log('input value:', await input.inputValue().catch(() => '?'));
      }
      await continueBtn.first().click();
      console.log('clicked continue');
      continue;
    }

    // No continue button -> likely past onboarding (main shell) or on GitHub step.
    if (/continue with github/i.test(url_state)) {
      console.log('still on GitHub step, stopping');
      break;
    }
    console.log('no continue button; assuming done');
    break;
  }

  await page.waitForTimeout(1500);
  const finalText = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log('=== final ===');
  console.log(finalText.replace(/\n+/g, ' | ').slice(0, 300));
  await browser.close();
})().catch(err => { console.error(err.message); process.exit(1); });
