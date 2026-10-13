// Rendered responsive/appearance checks against fictional local data only.
import { test, expect } from '@playwright/test';
test.describe.configure({mode:'serial'});
let cookies;
test.beforeAll(async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL });
  const page = await context.newPage();
  await page.goto('/#sign-in');
  const address = `design-${Date.now()}@example.com`;
  await page.locator('#start-form [name=email]').fill(address);
  await page.getByRole('button', { name: 'Send me a link' }).click();
  const email = await (await context.request.get(`/dev-mail/?to=${encodeURIComponent(address)}`)).text();
  await page.locator('#code-form [name=code]').fill(email.match(/type this code where you asked: (\d{6})/)[1]);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/$/);
  await page.locator('#setup-form [name=month]').selectOption('6');
  await page.locator('#setup-form [name=day]').fill('14');
  await page.locator('#setup-form [name=year]').fill('1981');
  await page.locator('[name=city]').fill('Minneapolis');
  await page.locator('.place').first().click();
  await page.getByRole('button',{name:'Start my release notes'}).click();
  await expect(page).toHaveURL(/\/today\/$/);
  await page.locator('#note-form textarea').fill('An ordinary morning. #outside');
  await page.getByRole('button',{name:'Save note',exact:true}).click();
  await expect(page.locator('article.note',{hasText:'An ordinary morning.'})).toBeVisible();
  cookies = await context.cookies();
  await context.close();
});
test.beforeEach(async ({ context }) => { await context.addCookies(cookies); });
for (const size of [{width:320,height:740},{width:390,height:844},{width:768,height:1024},{width:844,height:390},{width:1440,height:1000}]) {
  for (const colorScheme of ['light', 'dark']) {
    test(`writing and navigation at ${size.width}px in ${colorScheme}`, async ({ page }, info) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const [url, selected] of [['/today/', 'Today'], ['/timeline/', 'Archive'], ['/search/', 'Search'], ['/settings/', 'Settings']]) {
        await page.goto(url);
        const nav = page.getByRole('navigation', { name: 'Main navigation' });
        await expect(nav.getByRole('link', { name: selected, exact: true })).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('h1').first()).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        expect(overflow, `${url} must fit the viewport`).toBe(false);
        if (url === '/settings/') {
          await expect(page.locator('#daily-email')).toHaveAttribute('open', '');
          await expect(page.locator('#writing-settings')).not.toHaveAttribute('open');
          await expect(page.locator('#account-settings')).not.toHaveAttribute('open');
          await page.screenshot({path: info.outputPath(`settings-${size.width}-${colorScheme}.png`),fullPage:true});
          for (const id of ['writing-settings', 'agent-connections', 'account-settings']) {
            await page.locator(`#${id} > summary`).press('Enter');
            await expect(page.locator(`#${id}`)).toHaveAttribute('open', '');
          }
          await page.locator('#change-city').click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
          await page.locator('#cancel-city').click();
          await expect(page.locator('#transcribe')).not.toBeChecked();
          await expect(page.locator('#describe')).not.toBeChecked();
          await expect(page.locator('#delete-link')).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
          await page.screenshot({path: info.outputPath(`settings-expanded-${size.width}-${colorScheme}.png`),fullPage:true});
        }
        if (url === '/today/') {
          await expect(page.locator('.dots span')).toHaveCount(24);
          await expect(page.getByRole('textbox', { name: 'Add to today' })).toBeVisible();
          await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeVisible();
          const measurements = await page.locator('.primary-nav').evaluate(el => {
            const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};
          });
          if (size.width <= 760) expect(measurements.y).toBeGreaterThan(size.height - 120);
          else expect(measurements.x).toBeLessThan(70);
          await page.screenshot({path: info.outputPath(`today-${size.width}-${colorScheme}.png`),fullPage:true});
        }
      }
      expect(errors).toEqual([]);
    });
  }
}

test('everyday Settings changes save and city cancellation restores focus', async ({ page }) => {
  await page.goto('/settings/');
  await page.locator('#send-time').selectOption('07:15');
  await expect(page.locator('#send-time-saved')).toBeVisible();
  await page.reload();
  await expect(page.locator('#send-time')).toHaveValue('07:15');
  await expect(page.locator('#daily-email > summary')).toContainText('7:15 AM');
  await page.locator('#change-city').click();
  await expect(page.locator('#city-picker [name=city]')).toBeFocused();
  await page.locator('#cancel-city').click();
  await expect(page.locator('#change-city')).toBeFocused();
  await expect(page.locator('[data-field=city]')).toHaveText('Minneapolis');
  await page.locator('#send-time').selectOption('06:00');
  await expect(page.locator('#send-time-saved')).toBeVisible();
});

test('a refused setting keeps the stored value and returns focus to the field', async ({ page }) => {
  await page.goto('/settings/');
  await page.route('**/api/me', route => route.request().method() === 'PUT'
    ? route.fulfill({status: 500, json: {error: 'server'}}) : route.continue());
  await page.locator('#send-time').selectOption('09:00');
  await expect(page.locator('#send-time')).toHaveValue('06:00');
  await expect(page.locator('#send-time')).toBeFocused();
  await expect(page.getByText('Something went wrong. Try again.', {exact: true})).toBeVisible();
});
