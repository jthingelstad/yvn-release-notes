// Sign-up as a person does it: the birthday first, the number explained,
// the email, the code or the link, then setup. The dev server keeps the
// newest email to each address at /dev-mail/. The number depends on today,
// so the expected one comes from /api/sample, never a fixed string.
import { test, expect } from '@playwright/test';
import { STUB_TOKEN, stubTurnstile } from './turnstile-stub.mjs';

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
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/auth/start'));
  await page.getByRole('button', { name: 'Send me a link' }).click();
  expect((await sent).postDataJSON(), 'the sign-in email request carries the Turnstile token').toEqual({
    email,
    turnstile_token: STUB_TOKEN,
    turnstile_wait_ms: expect.any(Number)
  });
  await expect(page.locator('#check')).toBeVisible();
}

const waiting = (page) => page.evaluate(() => localStorage.getItem('rn-birthday'));

test.beforeEach(({ context }) => stubTurnstile(context));

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

  // Before a first note, the Timeline still lists the current release.
  await page.goto('/timeline/');
  const release = s.version.split('.').slice(0, 2).join('.');
  await expect(page.locator('#releases li')).toHaveCount(1);
  await expect(page.locator('#releases a[aria-current]')).toHaveAttribute('href', `/release/?v=${release}`);
});

test('the sample email is drawn with the number once a birthday is typed', async ({ page, request }) => {
  const s = await sample(request, '1981-06-14');
  await page.goto('/');
  await expect(page.locator('#sample-v')).toHaveText('5.2.113');
  await expect(page.locator('#gate-line')).toContainText('Free with a Weekly Thing subscription.');
  await typeBirthday(page, 6, 14, 1981);
  await expect(page.locator('#sample-v')).toHaveText(s.version);
  await expect(page.locator('#sample-cap')).toHaveText('Your morning’s email');
  await expect(page.locator('#sample-next')).toHaveText(`${s.next.version} ${s.next.days === 1 ? 'ships tomorrow' : `ships in ${s.next.days} days`}.`);
  const [major, minor, patch] = s.version.split('.').map(Number);
  const age = major * 10 + minor;
  await expect(page.locator('#sample')).toContainText(`${Math.floor((age - 1) / 10)}.${(age - 1) % 10}.${patch}`);
  // Back to the question, the sample is made up again.
  await page.getByRole('button', { name: 'Change birthday' }).click();
  await expect(page.locator('#sample-v')).toHaveText('5.2.113');
});

test('a link carrying a birthday shows its number as if typed, then clears it', async ({ page, request }) => {
  const s = await sample(request, '1981-06-14');
  const counted = [];
  // Only the number's own request carries the birthday, as when it is typed.
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (r.url().includes('1981-06-14') && url.pathname !== '/api/sample') counted.push(r.url());
  });
  await page.goto('/#birthday=1981-06-14');
  await expect(page.locator('#number')).toBeVisible();
  await expect(page.locator('#my-v')).toHaveText(s.version);
  await expect(page.locator('#sample-v')).toHaveText(s.version);
  await expect(page).toHaveURL(/\/$/);
  expect(JSON.parse(await waiting(page)).b).toBe('1981-06-14');
  await page.getByRole('button', { name: 'Change birthday' }).click();
  await expect(page.locator('#birthday-form [name=month]')).toHaveValue('6');
  await expect(page.locator('#birthday-form [name=day]')).toHaveValue('14');
  await expect(page.locator('#birthday-form [name=year]')).toHaveValue('1981');
  expect(counted, 'no other request carries the birthday').toEqual([]);
});

test('a link with a malformed or future birthday opens on the question, without a word', async ({ page }) => {
  for (const hash of ['#birthday=1981-02-30', '#birthday=2099-01-01', '#birthday=1981-6-14', '#birthday=1981-06-14&x=1']) {
    await page.goto(`/${hash}`);
    await expect(page.locator('#ask'), hash).toBeVisible();
    await expect(page.locator('#birthday-form .error'), hash).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    expect(await waiting(page), hash).toBeNull();
    await page.goto('about:blank');
  }
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

// A fresh address, since Ada's sign-ins are limited and other suites need them.
test('someone signed in who follows a birthday link goes on to Today', async ({ page, request }) => {
  await page.goto('/');
  await typeBirthday(page, 6, 14, 1981);
  const email = someone();
  await sendLink(page, email);
  await page.locator('#code-form [name=code]').fill(codeIn(await mail(request, email)));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/setup\/$/);
  await page.locator('[name=city]').fill('Minneapolis');
  await page.locator('.place').first().click();
  await page.getByRole('button', { name: 'Start my release notes' }).click();
  await expect(page).toHaveURL(/\/today\/$/);
  await page.goto('/#birthday=1990-01-01');
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

// The dev server's made-up Weekly Thing list: an address starting
// "not-subscribed" isn't on it, one starting "unconfirmed" hasn't confirmed
// and one starting "flagged" is held for review when it asks to be added.
// Everyone else gets the issues, so the tests above sign up.
async function signUpAs(page, request, email) {
  await page.goto('/');
  await typeBirthday(page, 6, 14, 1981);
  await sendLink(page, email);
  await page.locator('#code-form [name=code]').fill(codeIn(await mail(request, email)));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/setup\/$/);
}

test('the front page tells what Release Notes is, until someone signs in', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#tour')).toBeVisible();
  await expect(page.locator('#tour-subscribe')).toHaveAttribute('href', 'https://weekly.thingelstad.com/?ref=release-notes');
  await typeBirthday(page, 6, 14, 1981);
  await expect(page.locator('#tour')).toBeVisible();
  await page.locator('#to-sign-in').click();
  await expect(page.locator('#sign-in')).toBeVisible();
  await expect(page.locator('#tour')).toBeHidden();
});

test('an address without the Weekly Thing is offered it, and can start again', async ({ page, request }) => {
  const email = `not-subscribed-${someone()}`;
  await signUpAs(page, request, email);
  await expect(page.locator('#weekly-gate')).toHaveAttribute('data-gate', 'none');
  await expect(page.locator('#gate-email')).toHaveText(email);
  await expect(page.locator('#setup-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Subscribe to the Weekly Thing' })).toBeVisible();

  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('#gate-still')).toBeVisible();

  // Another address: signed out, back at the number, the birthday kept.
  await page.getByRole('button', { name: 'Use that one' }).click();
  await expect(page.locator('#number')).toBeVisible();
  await expect(page.locator('#start-form [name=email]')).toBeVisible();
  expect(JSON.parse(await waiting(page)).b).toBe('1981-06-14');
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

test('an unconfirmed Weekly Thing subscription is asked to confirm first', async ({ page, request }) => {
  await signUpAs(page, request, `unconfirmed-${someone()}`);
  await expect(page.locator('#weekly-gate')).toHaveAttribute('data-gate', 'unconfirmed');
  await expect(page.getByRole('heading', { name: 'Confirm your Weekly Thing subscription.' })).toBeVisible();
  await expect(page.locator('#setup-form')).toHaveCount(0);
});

test('the address can be added to the Weekly Thing from Release Notes', async ({ page, request }) => {
  await signUpAs(page, request, `not-subscribed-${someone()}`);
  await page.getByRole('button', { name: 'Subscribe to the Weekly Thing' }).click();
  await expect(page.locator('#weekly-gate')).toHaveAttribute('data-gate', 'unconfirmed');
  await expect(page.locator('#weekly-gate .lede')).toContainText('Nearly there.');
  // The confirmation again, for an inbox that didn't get it.
  await page.getByRole('button', { name: 'Send it again' }).click();
  await expect(page.locator('#weekly-gate')).toHaveAttribute('data-gate', 'unconfirmed');
  await expect(page.locator('#weekly-gate .error')).toBeHidden();
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('#gate-still')).toHaveText(/Not confirmed yet/);
  await expect(page.locator('#setup-form')).toHaveCount(0);
});

test('an address the list holds for review is told to email Jamie', async ({ page, request }) => {
  await signUpAs(page, request, `flagged-${someone()}`);
  await page.getByRole('button', { name: 'Subscribe to the Weekly Thing' }).click();
  await expect(page.locator('#weekly-gate .error')).toContainText('holding this address for review');
  await expect(page.locator('#weekly-gate')).toHaveAttribute('data-gate', 'none');
});
