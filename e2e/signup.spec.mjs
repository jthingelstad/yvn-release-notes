// Sign-up as a person does it: the birthday first, the number explained,
// the email, the code or the link, then setup. The dev server keeps the
// newest email to each address at /dev-mail/. The number depends on today,
// so the expected one comes from /api/sample, never a fixed string.
import { test, expect } from '@playwright/test';

const TZ = 'America/Chicago';
const someone = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

async function mail(request, to) {
  const r = await request.get(`/dev-mail/?to=${encodeURIComponent(to)}`);
  expect(r.ok(), `an email to ${to}`).toBeTruthy();
  return r.text();
}
const codeIn = (text) => text.match(/type this code where you asked: (\d{6})/)[1];
const linkIn = (text) => text.match(/(http:\/\/\S+\/signin\/#t=\S+)/)[1];

async function sample(request, birthday) {
  const r = await request.get(`/api/sample?birthday=${birthday}&tz=${encodeURIComponent(TZ)}`);
  return r.json();
}

async function typeBirthday(page, month, day, year) {
  await page.locator('#birthday-form [name=month]').selectOption(String(month));
  await page.locator('#birthday-form [name=day]').fill(String(day));
  await page.locator('#birthday-form [name=year]').fill(String(year));
  await page.getByRole('button', { name: 'Show me my number' }).click();
}

async function sendLink(page, email) {
  await page.locator('#start-form [name=email]').fill(email);
  await page.getByRole('button', { name: 'Send me a link' }).click();
  await expect(page.locator('#check')).toBeVisible();
}

const waiting = (page) => page.evaluate(() => localStorage.getItem('rn-birthday'));

test('a new person sees their number, signs in with the code, and setup has the birthday', async ({ page, request }) => {
  const s = await sample(request, '1981-06-14');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What’s your version number?' })).toBeVisible();

  await typeBirthday(page, 6, 14, 1981);
  await expect(page.locator('#number')).toBeVisible();
  await expect(page.locator('#you-are')).toBeFocused();
  await expect(page.locator('#my-v')).toHaveText(s.version);
  await expect(page.locator('#v-minor-line')).toHaveText(`Together: ${s.age}.`);
  await expect(page.locator('#v-next')).toContainText(s.next.version);
  await expect(page.locator('#ask')).toBeHidden();

  const email = someone();
  await sendLink(page, email);
  await page.locator('#code-form [name=code]').fill(codeIn(await mail(request, email)));
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/setup\/$/);
  await expect(page.locator('#setup-head')).toHaveText('Two more things.');
  await expect(page.locator('#known-v')).toHaveText(s.version);
  await expect(page.locator('#known-date')).toHaveText('June 14, 1981');
  await expect(page.locator('#birthday-stack')).toBeHidden();

  await page.locator('[name=city]').fill('Minneapolis');
  await page.locator('.place').first().click();
  await page.getByRole('button', { name: 'Start my release notes' }).click();
  await expect(page).toHaveURL(/\/today\/$/);
  expect(await waiting(page)).toBeNull();
});

test('the emailed link opens in a new tab and still brings the birthday', async ({ page, context, request }) => {
  await page.goto('/');
  await typeBirthday(page, 2, 29, 2000);
  const email = someone();
  await sendLink(page, email);

  const tab = await context.newPage();
  await tab.goto(linkIn(await mail(request, email)));
  await tab.getByRole('button', { name: 'Sign in' }).click();
  await expect(tab).toHaveURL(/\/setup\/$/);
  await expect(tab.locator('#known-date')).toHaveText('February 29, 2000');

  // "Not right?" opens the fields, filled in, with the number under them.
  await tab.getByRole('button', { name: 'Not right?' }).click();
  await expect(tab.locator('#setup-head')).toHaveText('Three things, then you’re set.');
  await expect(tab.locator('#setup-form [name=month]')).toHaveValue('2');
  await expect(tab.locator('#setup-form [name=day]')).toHaveValue('29');
  await expect(tab.locator('#that-makes')).toBeVisible();
});

test('dates that are not real, or not yet, are refused', async ({ page }) => {
  await page.goto('/');
  const error = page.locator('#birthday-form .error');
  await typeBirthday(page, 2, 30, 1990);
  await expect(error).toBeVisible();
  await typeBirthday(page, 2, 29, 2001); // not a leap year
  await expect(error).toBeVisible();
  await typeBirthday(page, 1, 1, 2099); // the API says no
  await expect(error).toContainText('not in the future');
  await expect(page.locator('#number')).toBeHidden();
  expect(await waiting(page)).toBeNull();
});

test('someone returning signs in alone, and a waiting birthday is dropped', async ({ page, request }) => {
  await page.goto('/');
  await typeBirthday(page, 6, 14, 1981);
  await expect(page.locator('#number')).toBeVisible();
  expect(await waiting(page)).not.toBeNull();

  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.locator('#sign-in')).toBeVisible();
  await expect(page.locator('#number')).toBeHidden();
  await expect(page).toHaveURL(/#sign-in$/);

  await sendLink(page, 'ada@example.com');
  await page.locator('#code-form [name=code]').fill(codeIn(await mail(request, 'ada@example.com')));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/today\/$/);
  expect(await waiting(page)).toBeNull();
});

test('a slow number does not pull the page away from sign-in', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('rn-birthday', JSON.stringify({ b: '1981-06-14', at: Date.now() }));
    }
  });
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/sample?**', async (route) => { await held; await route.continue(); });

  await page.goto('/');
  await page.evaluate(() => { location.hash = '#sign-in'; });
  await expect(page.locator('#sign-in')).toBeVisible();
  release();
  await page.waitForResponse('**/api/sample?**');
  await page.waitForTimeout(200);
  await expect(page.locator('#sign-in')).toBeVisible();
  await expect(page.locator('#number')).toBeHidden();
});

test('after a reload on the code, a different address goes back to the number', async ({ page }) => {
  await page.goto('/');
  await typeBirthday(page, 6, 14, 1981);
  await sendLink(page, someone());
  await page.reload();
  await expect(page.locator('#check')).toBeVisible();

  await page.getByRole('link', { name: 'use a different address' }).click();
  await expect(page.locator('#number')).toBeVisible();
  await expect(page.locator('#my-v')).not.toBeEmpty();
  await expect(page.locator('#start-form [name=email]')).toBeFocused();
});

test('back and forward keep the address bar and the step together', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#ask')).toBeVisible();
  await page.goto('/#sign-in');
  await expect(page.locator('#sign-in')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#ask')).toBeVisible();
  await expect(page.locator('#sign-in')).toBeHidden();
  await page.goForward();
  await expect(page.locator('#sign-in')).toBeVisible();
});
