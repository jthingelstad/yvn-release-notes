// front.html, the front page drawn in at build time for readers that run no
// script (web/src/prerender.tsx), served for / alone (the CloudFront function
// and tools/dev-server.ts). Anyone running the app sees the app alone, signed
// in or out: the drawn copy is never on screen. Fictional local data only.
import { test, expect } from '@playwright/test';
import { stubTurnstile } from './turnstile-stub.mjs';

const QUESTION = 'What’s your version number?';
const OTHER_ADDRESSES = ['/signin/', '/today/', '/day/?d=2026-10-25', '/settings/', '/no-such-page/'];

// In every frame the browser draws, whether the drawn copy is in the page
// and whether it is on screen.
function watchPrerender() {
  window.__prerender = { seen: false, shown: false };
  const look = () => {
    const copy = document.querySelector('main[data-prerendered]');
    if (copy) {
      window.__prerender.seen = true;
      if (copy.getClientRects().length > 0) window.__prerender.shown = true;
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

// Errors in the console, but for /api/me's 401 to someone signed out, which
// Chrome logs as it always has (the app asks as every page opens).
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url } = message.location();
    if (new URL(url || 'http://x/').pathname === '/api/me' && /status of 401/.test(message.text())) return;
    errors.push(message.text());
  });
  return errors;
}

test.describe('without scripts', () => {
  test.use({ javaScriptEnabled: false });

  test('/ shows the front page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main[data-prerendered]')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(QUESTION);
    await expect(page.getByRole('button', { name: 'Show me my number' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The easiest journal you’ll ever keep.' })).toBeVisible();
    await expect(page.locator('#home-foot')).toContainText('A hobby by Jamie Thingelstad');
    // What the opening view hides is not there to show.
    await expect(page.locator('#app [hidden]')).toHaveCount(0);
  });

  test('every other address is the empty app, with none of the front page’s words', async ({ page }) => {
    for (const address of OTHER_ADDRESSES) {
      await page.goto(address);
      expect(await page.locator('#app').innerHTML(), address).toBe('');
      expect(await page.locator('body').innerText(), address).not.toContain(QUESTION);
    }
  });
});

test.describe('with scripts', () => {
  test.beforeEach(async ({ context }) => {
    await stubTurnstile(context);
    await context.addInitScript(watchPrerender);
  });

  test('signed out, / is the app’s own front page, as it was, and the drawn copy says the same', async ({
    page,
    browser
  }, info) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(QUESTION);
    await expect(page.locator('#tour')).toBeVisible();
    await expect(page.locator('main[data-prerendered]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__prerender.shown)).toBe(false);
    const app = await page.locator('#app > main').innerText();

    // The words a reader without scripts gets are the app's own.
    const off = await browser.newContext({ baseURL: info.project.use.baseURL, javaScriptEnabled: false });
    const plain = await off.newPage();
    await plain.goto('/');
    expect(await plain.locator('#app > main').innerText()).toBe(app);
    await off.close();
    expect(errors).toEqual([]);
  });

  test('before the app has run, the drawn copy is out of sight', async ({ page }) => {
    // The app's script never arrives: the page as it is until it runs.
    await page.route(/\/assets\/.*\.js$/, (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('main[data-prerendered]')).toBeAttached();
    await expect(page.locator('main[data-prerendered]')).toBeHidden();
    expect(await page.evaluate(() => window.__prerender)).toEqual({ seen: true, shown: false });
  });

  test('signed in, / goes straight on and the front page is never on screen', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/#sign-in');
    const address = `front-${Date.now()}@example.com`;
    await page.locator('#start-form [name=email]').fill(address);
    await page.getByRole('button', { name: 'Send me a link' }).click();
    await expect(page.locator('#code-form')).toBeVisible();
    const email = await (await page.request.get(`/dev-mail/?to=${encodeURIComponent(address)}`)).text();
    await page.locator('#code-form [name=code]').fill(email.match(/type this code where you asked: (\d{6})/)[1]);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/setup\/$/);

    await page.goto('/');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/setup/');
    expect(await page.evaluate(() => window.__prerender.shown)).toBe(false);
    await expect(page.getByText(QUESTION)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('hinted as signed in with no session, the front page comes once /api/me says so, never the copy', async ({
    page,
    context
  }) => {
    const errors = collectErrors(page);
    await context.addInitScript(() => localStorage.setItem('rn-in', '1'));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(QUESTION);
    expect(await page.evaluate(() => window.__prerender.shown)).toBe(false);
    expect(errors).toEqual([]);
  });
});
