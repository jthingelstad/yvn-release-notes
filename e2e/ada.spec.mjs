// Signed-in pages, as Ada, the dev server's subscriber.
//
// Files from the web: a photo with a new note, then a PDF added to it, as a
// person does it. The dev server takes the signed form at /dev-upload/ the
// way S3 would (FakeS3.form_upload), so this runs the page's whole path.
// Recording: Chromium's made-up microphone, kept with a new note.
// Search: the tags, then words, found and marked.
// Transcripts: the setting, a recording written out, and found by search.
// Descriptions: the setting, a photo described, shown only where search
// found it.
// Where: a note's place from the city search, or Here from the browser's
// (made-up) location, changed and cleared on the saved note; and a day's own
// place, set and cleared, its weather following.
// The standing address: shown in settings, copied, and replaced.
// Releases: the Timeline's index, and a release's page, oldest first.
// Books: one made from a release's page, and its PDF.
// Badges: reached from Today, the release's album, the tracks and the shelf;
// a save's unlock line, and what a day and a release collected.
// Activity: what the steps above did, reached from settings, and from the
// mail log's old address.
import { test, expect } from '@playwright/test';

// A real 1 x 1 PNG, so the browser draws it, and a small PDF.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

// One sign-in as Ada, shared: a second code would replace the first, and
// an address gets five sign-in emails an hour.
test.describe.configure({ mode: 'serial' });
let session;

test.beforeAll(async ({ browser }) => {
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ baseURL });
  const post = (path, data) => context.request.post(path, { data, headers: { Origin: baseURL } });
  await post('/api/auth/start', { email: 'ada@example.com' });
  const mail = await (await context.request.get('/dev-mail/?to=ada@example.com')).text();
  const code = mail.match(/type this code where you asked: (\d{6})/)[1];
  expect((await post('/api/auth/verify', { email: 'ada@example.com', code })).ok()).toBeTruthy();
  session = await context.storageState();
  await context.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session.cookies);
});

test('a photo goes with a new note, and a PDF joins it later', async ({ page }) => {
  await page.goto('/today/');
  const form = page.locator('#note-form');
  const words = `Bagels at ${Date.now()}`;
  await form.locator('textarea').fill(words);
  await form.locator('input[type=file]').setInputFiles({ name: 'bagels.png', mimeType: 'image/png', buffer: PNG });
  await expect(form.locator('.chosen')).toHaveText('With bagels.png');
  await form.getByRole('button', { name: /Add note|Save note/ }).click();

  const note = page.locator('article.note', { hasText: words });
  await expect(note.locator('.media img')).toHaveJSProperty('naturalWidth', 1);
  await expect(form.locator('.chosen')).toBeHidden();

  const chooser = page.waitForEvent('filechooser');
  await note.getByRole('button', { name: 'Add files' }).click();
  await (await chooser).setFiles({ name: 'Menu.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(note.locator('.media a.file')).toHaveText('Menu.pdf');
  // A file's name keeps a line height of its own, so a long one wraps
  // without its lines drawn over each other (photo links have none).
  const lineHeight = await note.locator('.media a.file').evaluate((a) => parseFloat(getComputedStyle(a).lineHeight));
  expect(lineHeight).toBeGreaterThan(15);
  await expect(note.locator('.media img')).toHaveCount(1);
  // Each opens from its signed link (the dev server's /dev-media/), not an API call.
  await expect(note.locator('.media img')).toHaveAttribute('src', /^\/dev-media\/media\//);
  await expect(note.locator('.media a').first()).toHaveAttribute('href', /^\/dev-media\/media\//);
  await expect(note.locator('.media a.file')).toHaveAttribute('href', /^\/dev-media\/media\/.*\.pdf$/);
});

test('note glyph actions support keyboard editing and explicit delete confirmation', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/today/');
  await page.getByRole('textbox', { name: 'Add to today', exact: true }).fill('A note for glyph controls.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  const note = page.locator('article.note', { hasText: 'A note for glyph controls.' });
  await expect(note).toBeVisible();
  for (const action of ['Edit', 'Where', 'Add files', 'Delete']) {
    const button = note.getByRole('button', { name: action, exact: true });
    await expect(button).toHaveAttribute('title', action);
    const bounds = await button.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  await note.getByRole('button', { name: 'Edit', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(note.getByRole('textbox', { name: 'Edit this note', exact: true })).toBeFocused();
  await note.getByRole('textbox', { name: 'Edit this note', exact: true }).fill('A note for glyph controls. Edited.');
  await note.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(note.locator('.text')).toContainText('Edited.');
  await page.screenshot({ path: '/tmp/yvn-lucide-note-actions.png', fullPage: true });
  await note.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(note.getByText('Delete this note?', { exact: true })).toBeVisible();
  await note.getByRole('button', { name: 'Keep it', exact: true }).click();
  await expect(note.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await note.getByRole('button', { name: 'Delete', exact: true }).click();
  await note.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(note).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a photo opens over the page and closes back to it', async ({ page }) => {
  await page.goto('/timeline/');
  const photo = page.locator('.media img').first();
  await expect(photo).toBeVisible();
  const url = page.url();
  await photo.click();
  const viewer = page.getByRole('dialog', { name: 'Photo' });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img')).toHaveAttribute('src', /^\/dev-media\/media\//);
  await expect(viewer.locator('img')).not.toHaveJSProperty('naturalWidth', 0);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();
  expect(page.url()).toBe(url);
  expect(page.context().pages()).toHaveLength(1);
  // Escape closes it too, and so does a click outside the photo.
  await photo.click();
  await expect(viewer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await photo.click();
  await page.mouse.click(5, 5);
  await expect(viewer).toBeHidden();
});

test('a file that is not a photo, recording or PDF is refused by name, and nothing is saved', async ({ page }) => {
  await page.goto('/today/');
  const form = page.locator('#note-form');
  const words = `Not a page ${Date.now()}`;
  await form.locator('textarea').fill(words);
  await form
    .locator('input[type=file]')
    .setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<p>hi</p>') });
  await form.getByRole('button', { name: /Add note|Save note/ }).click();
  await expect(form.locator('.error')).toHaveText('page.html isn’t a photo, recording or PDF, so it can’t be added.');
  await expect(page.locator('article.note', { hasText: words })).toHaveCount(0);
  await expect(form.locator('textarea')).toHaveValue(words);
});

test('search lists every tag, finds words, marks them, and the box clears back to the tags', async ({ page }) => {
  // The header's search opens the page with the box ready.
  await page.goto('/today/');
  await page.getByRole('link', { name: 'Search notes', exact: true }).click();
  await expect(page).toHaveURL(/\/search\/$/);
  await expect(page.locator('#search-form input[type=search]')).toBeFocused();
  const tags = page.locator('#every-tag-list');
  await expect(tags.locator('a.tag').first()).toBeVisible();
  const words = `Lighthouse ${Date.now()}`;
  await page.request.post('/api/days/' + (await (await page.request.get('/api/today')).json()).date + '/notes', {
    data: { text: `${words} by the café. #maine` },
    headers: { Origin: new URL(page.url()).origin }
  });

  const box = page.locator('#search-form input[type=search]');
  await box.fill(words.toLowerCase());
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#q=${encodeURIComponent(words.toLowerCase())}$`));
  await expect(page.locator('#search-lede')).toHaveText(`1 note for “${words.toLowerCase()}”, newest first`);
  await expect(page.locator('#results mark').first()).toHaveText('Lighthouse');
  await expect(tags).toBeHidden();

  await box.fill('cafe "by the" #maine');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.locator('#results .text', { hasText: words })).toHaveCount(1);

  await page.goBack();
  await expect(box).toHaveValue(words.toLowerCase());
  await box.fill('');
  await box.dispatchEvent('search');
  await expect(tags).toBeVisible();
  await expect(page.locator('#results')).toBeEmpty();
  const first = tags.locator('a.tag').first();
  const name = await first.textContent();
  await first.click();
  await expect(page.locator('#tag-title')).toHaveText(name);
});

test('a recording made on the page plays back, then goes with the note', async ({ page }) => {
  await page.goto('/today/');
  const form = page.locator('#note-form');
  const record = form.locator('button.record'); // its name becomes the timer
  await record.click();
  await expect(record).toHaveAttribute('aria-pressed', 'true');
  await expect(record).toHaveText('Stop · 0:02', { timeout: 5000 });
  await record.click();
  await expect(record).toHaveText('Record');
  const preview = form.locator('.recordings audio');
  await expect(preview).toHaveCount(1);
  expect(await preview.getAttribute('src')).toMatch(/^blob:/);

  const words = `Said aloud ${Date.now()}`;
  await form.locator('textarea').fill(words);
  await form.getByRole('button', { name: /Add note|Save note/ }).click();
  const note = page.locator('article.note', { hasText: words });
  await expect(note.locator('.media audio')).toHaveCount(1);
  await expect(note.locator('.media audio')).toHaveAttribute('src', /^\/dev-media\/media\//);
  await expect(form.locator('.recordings audio')).toHaveCount(0);
});

test('turning on transcripts writes out a recording, and search finds what was said', async ({ page }) => {
  await page.goto('/settings/');
  await page.locator('#writing-settings > summary').click();
  const box = page.getByLabel('Write out what I say');
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(page.locator('#transcribe-saved')).toBeVisible();

  // The dev harness writes it out five seconds after, standing in for the transcription worker.
  await page.goto('/timeline/');
  await expect(page.getByText('Writing this out.').first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.locator('.media .said', { hasText: 'loons were out' }).first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20000 });

  await page.goto('/search/#q=loons');
  await expect(page.locator('.media .said mark').first()).toHaveText('loons');

  await page.goto('/settings/');
  await page.locator('#writing-settings > summary').click();
  await page.getByLabel('Write out what I say').uncheck();
  await expect(page.locator('#transcribe-saved')).toBeVisible();
});

test('turning on descriptions describes a photo, shown only where search found it', async ({ page }) => {
  await page.goto('/settings/');
  await page.locator('#writing-settings > summary').click();
  const box = page.getByLabel('Describe my photos');
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(page.locator('#describe-saved')).toBeVisible();

  // The dev harness describes it five seconds after, standing in for the description worker;
  // on the day it is the photo's alt text, never words on the page.
  await page.goto('/today/');
  const photo = page.locator('article.note', { hasText: 'Bagels at' }).locator('.media img').first();
  await expect(async () => {
    await page.reload();
    await expect(photo).toHaveAttribute('alt', /red canoe/, { timeout: 1000 });
  }).toPass({ timeout: 20000 });
  await expect(page.locator('.media .said', { hasText: 'canoe' })).toHaveCount(0);

  await page.goto('/search/#q=canoe');
  await expect(page.locator('.media .said mark').first()).toHaveText('canoe');
  await page.goto('/search/#q=bagels');
  await expect(page.locator('.tday mark').first()).toBeVisible();
  await expect(page.locator('.media .said', { hasText: 'canoe' })).toHaveCount(0);

  await page.goto('/settings/');
  await page.locator('#writing-settings > summary').click();
  await page.getByLabel('Describe my photos').uncheck();
  await expect(page.locator('#describe-saved')).toBeVisible();
});

test('a note says where it was, by name, linking to the map', async ({ page }) => {
  await page.goto('/today/');
  const form = page.locator('#note-form');
  const words = `Croissants at ${Date.now()}`;
  await form.locator('textarea').fill(words);
  await form.getByRole('button', { name: 'Where' }).click();
  await form.getByLabel('Where (optional)').fill('Par');
  await form.getByRole('option', { name: /Paris/ }).click();
  await expect(form.locator('#note-where')).toHaveText(/At Paris, Ile-de-France\./);
  await form.getByRole('button', { name: /Add note|Save note/ }).click();

  const note = page.locator('article.note', { hasText: words });
  const place = note.getByRole('link', { name: 'Paris, Ile-de-France' });
  // Our own map, opened on this note; the day and id ride in the #.
  await expect(place).toHaveAttribute('href', /^\/map\/#d=\d{4}-\d{2}-\d{2}&n=[^&]+$/);
  // The form starts over without a place.
  await expect(form.locator('#note-where')).toBeHidden();
  await expect(form.getByRole('button', { name: 'Where' })).toBeVisible();
});

test("Here names where the browser is, and a saved note's place changes after", async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 48.856613, longitude: 2.352222, accuracy: 10 });
  // "Add where I am" off for this page only, so Here waits for a tap.
  await page.route('**/api/me', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch(),
      me = await res.json();
    await route.fulfill({ response: res, json: { ...me, here: false } });
  });
  await page.goto('/today/');
  const form = page.locator('#note-form');
  const words = `Coffee at ${Date.now()}`;
  await form.locator('textarea').fill(words);
  await form.getByRole('button', { name: 'Here', exact: true }).click();
  // The neighbourhood first; a business near is one tap, and one more back.
  await expect(form.locator('#note-where')).toHaveText(/At Old Town, Paris\./);
  const cafe = form.getByRole('group', { name: 'Were you at' }).getByRole('button', { name: 'Corner Café' });
  await cafe.click();
  await expect(cafe).toHaveAttribute('aria-pressed', 'true');
  await expect(form.locator('#note-where')).toHaveText(/At Corner Café, Paris\./);
  await form.getByRole('button', { name: 'Save note' }).click();
  // Saving reads /api/me again; none of it may outlive the test.
  await page.unrouteAll({ behavior: 'wait' });

  // The spot itself, not the city's middle, on the map.
  const note = page.locator('article.note', { hasText: words });
  await expect(note.getByRole('link', { name: 'Corner Café, Paris' })).toHaveAttribute('href', /^\/map\/#d=.+&n=/);

  // Here again on the saved note: saved at the neighbourhood, then named
  // by what was near until Done.
  await note.getByRole('button', { name: 'Where', exact: true }).click();
  await note.getByRole('button', { name: 'Here', exact: true }).click();
  await expect(note.getByRole('link', { name: 'Old Town, Paris' })).toBeVisible();
  await note.getByRole('button', { name: 'Reading Room' }).click();
  await expect(note.getByRole('link', { name: 'Reading Room, Paris' })).toBeVisible();
  await note.getByRole('button', { name: 'Done' }).click();

  // Taken off, then a city from the search instead.
  await note.getByRole('button', { name: 'Where', exact: true }).click();
  await note.getByRole('button', { name: 'No place' }).click();
  await expect(note.getByRole('link', { name: /Paris/ })).toHaveCount(0);
  await note.getByRole('button', { name: 'Where', exact: true }).click();
  await note.getByLabel('Where this note was').fill('Minn');
  await note.getByRole('option', { name: /Minneapolis.*Minnesota/ }).click();
  await expect(note.getByRole('link', { name: 'Minneapolis, Minnesota' })).toHaveAttribute('href', /^\/map\/#d=.+&n=/);
  await expect(note.getByRole('button', { name: 'Where', exact: true })).toBeFocused();
});

test('"Add where I am" asks only as a note is saved, and "Not there" leaves it off', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 48.856613, longitude: 2.352222, accuracy: 10 });
  // Every time the page asks the browser where it is, answered after
  // `window.slow` milliseconds.
  await page.addInitScript(() => {
    const ask = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    window.asked = 0;
    window.slow = 0;
    navigator.geolocation.getCurrentPosition = (...args) => (
      window.asked++,
      setTimeout(() => ask(...args), window.slow)
    );
  });
  const asked = () => page.evaluate(() => window.asked);
  // On unless turned off, so nothing to set. Opening Today asks nothing.
  await page.goto('/today/');
  await page.waitForLoadState('networkidle');
  const form = page.locator('#note-form');
  await expect(form.getByRole('button', { name: 'Here', exact: true })).toBeVisible();
  await expect(form.locator('#note-where')).toBeHidden();
  expect(await asked()).toBe(0);

  // Saving asks, and the note keeps where it was written. While the
  // browser looks, the draft being saved can't be changed.
  const there = `Somewhere at ${Date.now()}`;
  await form.locator('textarea').fill(there);
  await page.evaluate(() => (window.slow = 1500));
  await form.getByRole('button', { name: 'Save note' }).click();
  await expect(form.getByText('Finding where you are…')).toBeVisible();
  await expect(form.locator('textarea')).toHaveAttribute('readonly', '');
  await expect(form.locator('input[type=file]')).toBeDisabled();
  await page.evaluate(() => (window.slow = 0));
  await expect(
    page.locator('article.note', { hasText: there }).getByRole('link', { name: 'Old Town, Paris' })
  ).toBeVisible();
  expect(await asked()).toBe(1);
  await expect(form.locator('textarea')).toHaveValue('');
  await expect(form.locator('textarea')).not.toHaveAttribute('readonly');

  // "Not there" after a Here: saved with no place, and not asked again.
  await form.getByRole('button', { name: 'Here', exact: true }).click();
  await expect(form.locator('#note-where')).toHaveText(/At Old Town, Paris\./);
  await form.getByRole('button', { name: 'Not there' }).click();
  const nowhere = `Nowhere at ${Date.now()}`;
  await form.locator('textarea').fill(nowhere);
  await form.getByRole('button', { name: 'Save note' }).click();
  // Saved, not still "Saving…": a saved note has its Where.
  const note = page.locator('article.note', { hasText: nowhere });
  await expect(note.getByRole('button', { name: 'Where', exact: true })).toBeVisible();
  await expect(note.getByRole('link', { name: /Paris/ })).toHaveCount(0);
  expect(await asked()).toBe(2);
});

test('a past day can have a place of its own, and its weather follows', async ({ page }) => {
  const day = new Date(Date.now() - 20 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  await page.goto(`/day/?d=${day}`);
  const where = page.locator('#day-where');
  await where.getByRole('button', { name: 'Where was this day?' }).click();
  await where.getByLabel('Where this day was').fill('Par');
  const answered = page.waitForResponse(
    (r) => r.url().endsWith(`/api/days/${day}/place`) && r.request().method() === 'PUT'
  );
  await where.getByRole('option', { name: /Paris/ }).click();
  const body = await (await answered).json();
  expect(body.where).toBe('Paris, Ile-de-France');
  await expect(where.locator('#where')).toHaveText('Where: Paris, Ile-de-France');
  expect(body.weather).toBeTruthy();
  await expect(page.locator('#weather')).toHaveText(body.weather);

  await where.getByRole('button', { name: 'Clear' }).click();
  await expect(where.getByRole('button', { name: 'Where was this day?' })).toBeVisible();
  await expect(where.locator('#where')).toHaveCount(0);
});

test('settings shows the standing address, copies it, and a new one replaces it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/settings/');
  await page.locator('#writing-settings > summary').click();
  const box = page.locator('#inbox');
  const address = box.locator('[data-field=inbox]');
  const pattern = /^[a-z2-7]{24}@in\.yourversionnumber\.com$/;
  // Ada, made by the dev server, may have none yet.
  if (await box.getByRole('button', { name: 'Make my address' }).isVisible()) {
    await box.getByRole('button', { name: 'Make my address' }).click();
  }
  await expect(address).toHaveText(pattern);
  const first = await address.textContent();

  await box.getByRole('button', { name: 'Copy' }).click();
  await expect(box.locator('#inbox-copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);

  page.once('dialog', (d) => d.accept());
  await box.getByRole('button', { name: 'New address' }).click();
  await expect(address).not.toHaveText(first);
  await expect(address).toHaveText(pattern);
  // It is the profile's now, after a reload too.
  const second = await address.textContent();
  await page.reload();
  await page.locator('#writing-settings > summary').click();
  await expect(page.locator('#inbox [data-field=inbox]')).toHaveText(second);
});

test('the timeline lists the releases, and a release shows its days oldest first', async ({ page }) => {
  // Ada (born 1981-06-14) is 4.5: notes this release, one in 4.4, one in 3.5.
  await page.goto('/timeline/');
  const releases = page.locator('#releases');
  await expect(releases.locator('li')).toHaveCount(3);
  await expect(releases.locator('a[aria-current]')).toHaveAttribute('href', '/release/?v=4.5');
  await releases.getByRole('link', { name: 'Version 4.4' }).click();
  await expect(page).toHaveURL(/\/release\/\?v=4\.4$/);
  await expect(page.locator('#release-title')).toHaveText('Release 4.4');
  await expect(page.locator('#release-counts li')).toHaveText(['1 day with notes', '1 note']);
  await expect(page.getByRole('navigation', { name: 'Other releases' })).toContainText('Release 3.5');
  await expect(page.locator('#release-days .tday')).toHaveCount(1);
  await expect(page.locator('#release-days')).toContainText('the day the new bike came');

  await page.goto('/release/?v=4.5');
  await expect(page.locator('#release-head')).toContainText('and still going');
  await expect(page.locator('#release-tags')).toContainText('#walks');
  const heads = page.locator('#release-days a.tday-head');
  await expect(heads.last()).toHaveAttribute('href', '/today/');
  await expect(heads.first()).not.toHaveAttribute('href', '/today/');
  // A day's link goes to the day: the release page, still drawn while the
  // day loads, doesn't take the new address for a missing ?v= and go back.
  await heads.first().click();
  await expect(page).toHaveURL(/\/day\/\?d=\d{4}-\d{2}-\d{2}$/);

  // A release not begun goes back to the Timeline.
  await page.goto('/release/?v=9.9');
  await expect(page).toHaveURL(/\/timeline\/$/);
});

test('a release makes a book of its days, a PDF to download', async ({ page }) => {
  await page.goto('/release/?v=4.4');
  await page.getByRole('link', { name: 'Make a book of this release' }).click();
  await expect(page).toHaveURL(/\/book\/\?from=\d{4}-06-14&to=\d{4}-06-13$/);
  await expect(page.locator('select[name=release]')).toHaveValue('4.4');
  await expect(page.locator('#book-plan')).toHaveText('1 day · 1 note');
  await expect(page.locator('input[name=title]')).toHaveAttribute('placeholder', '4.4');
  await page.locator('input[name=title]').fill('The bike');
  await expect(page.getByRole('radio', { name: /^6 by 9 inches/ })).toBeChecked();
  await page.getByRole('radio', { name: /^US Letter/ }).check();
  await page.getByRole('button', { name: 'Make the book' }).click();
  await expect(page.locator('#book-status')).toContainText('Ready: “The bike”', { timeout: 20_000 });
  await expect(page.locator('#book-status')).toContainText('US Letter');
  await expect(page.locator('#book-form')).toBeVisible();
  const file = await page.request.get(await page.locator('#book-file').getAttribute('href'));
  expect(file.headers()['content-type']).toBe('application/pdf');
  expect((await file.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('badges open from Today, with this release, the tracks and the shelf', async ({ page }) => {
  await page.goto('/today/');
  const link = page.locator('#badges-link');
  await expect(link).toHaveText(/^\d+ badges?$/);
  await link.click();
  await expect(page).toHaveURL(/\/badges\/$/);
  await expect(page.locator('h1')).toHaveText('Badges');
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'You', exact: true })
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#badges-lede')).toContainText('Latest:');
  await expect(page.locator('#coverage')).toContainText('with notes in 4.5 so far');
  await expect(page.locator('#tracks .track')).toHaveCount(4);
  await expect(page.locator('#track-delivery .tiers')).toHaveAttribute('aria-label', /^\d of 5 tiers$/);
  await expect(page.locator('#collected')).toContainText('Hello, world');
  // A secret still to find shows its hint, never its name.
  await expect(page.locator('#missing .locked', { hasText: 'Secret' }).first()).toBeVisible();
  await expect(page.locator('#missing')).not.toContainText('Don’t panic');
});

test('a release index that fails to load says so, and the days still show', async ({ page }) => {
  await page.route('**/api/releases', (route) => route.fulfill({ status: 500, json: { error: 'server' } }));
  await page.goto('/timeline/');
  await expect(page.locator('#releases')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Couldn’t load this just now. Reload to try again.');
  await expect(page.locator('.tday').first()).toBeVisible();
});

test('a note that earns a badge says so under the form, and the count goes up', async ({ page }) => {
  await page.goto('/today/');
  const link = page.locator('#badges-link');
  await expect(link).toHaveText(/^\d+ badges?$/);
  const had = Number((await link.textContent()).split(' ')[0]);
  const unlock = page.locator('#unlock');
  await expect(unlock).toBeHidden();
  // More than 1,000 words in a day earns RFC.
  await page
    .getByRole('textbox', { name: 'Add to today' })
    .fill(Array.from({ length: 1001 }, (_, i) => `word${i}`).join(' '));
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(unlock).toHaveText(/^Unlocked: RFC, \d+\.\d+\.\d+\. See your badges$/);
  await expect(unlock.locator('svg')).toBeVisible();
  await expect(link).toHaveText(`${had + 1} badges`);
  await unlock.getByRole('link', { name: 'See your badges' }).click();
  await expect(page).toHaveURL(/\/badges\/$/);
  await expect(page.locator('#badges-lede')).toContainText('Latest: RFC');
});

test('a past special day: the unlock, the Day page line and the release head', async ({ page }) => {
  const me = await (await page.request.get('/api/me')).json();
  // This release's first day, Ada's birthday: Release day.
  let first = me.today.slice(0, 4) + me.birthday.slice(4);
  if (first > me.today) first = String(Number(first.slice(0, 4)) - 1) + first.slice(4);
  await page.goto(`/day/?d=${first}`);
  await expect(page.locator('#collected-here')).toHaveCount(0);
  await page.locator('#note-form textarea').fill('Cake for breakfast.');
  await page.locator('#note-form button[type=submit]').click();
  await expect(page.locator('#unlock')).toContainText('Release day');
  await expect(page.locator('#collected-here')).toHaveText('Collected here: Release day.');
  await page.goto('/release/?v=4.5');
  await expect(page.locator('#release-badges')).toContainText('Collected: Release day');
});
test('"Show badges" off hides their links and lines, and on brings them back', async ({ page }) => {
  const me = await (await page.request.get('/api/me')).json();
  let first = me.today.slice(0, 4) + me.birthday.slice(4);
  if (first > me.today) first = String(Number(first.slice(0, 4)) - 1) + first.slice(4);
  const setting = async (on) => {
    await page.goto('/settings/');
    await page.locator('#writing-settings > summary').click();
    const box = page.getByLabel('Show badges');
    await expect(box).toBeChecked({ checked: !on });
    await box.setChecked(on);
    await expect(page.locator('#badges-saved')).toBeVisible();
  };
  await setting(false);
  await page.goto('/today/');
  await expect(page.locator('#streak')).toBeVisible();
  await expect(page.locator('#badges-link')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Add to today' }).fill('A quiet note.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.locator('article.note', { hasText: 'A quiet note.' })).toBeVisible();
  await expect(page.locator('#unlock')).toBeHidden();
  await page.goto('/timeline/');
  await expect(page.getByRole('link', { name: 'Tags' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Badges', exact: true })).toHaveCount(0);
  await page.goto('/you/');
  await expect(page.locator('#you-activity')).toBeVisible();
  await expect(page.locator('#you-badges')).toHaveCount(0);
  await page.goto(`/day/?d=${first}`);
  await expect(page.locator('article.note', { hasText: 'Cake for breakfast.' })).toBeVisible();
  await expect(page.locator('#collected-here')).toHaveCount(0);
  await page.goto('/release/?v=4.5');
  await expect(page.locator('#release-counts')).toBeVisible();
  await expect(page.locator('#release-badges')).toHaveCount(0);
  await setting(true);
  await page.goto('/today/');
  await expect(page.locator('#badges-link')).toHaveText(/^\d+ badges?$/);
  await page.goto('/you/');
  await expect(page.locator('#you-badges')).toContainText(/\d+ badges? so far/);
  await page.goto(`/day/?d=${first}`);
  await expect(page.locator('#collected-here')).toHaveText('Collected here: Release day.');
});

test('the activity log opens from You, and the mail log address lands on it', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await page.goto('/today/');
  await nav.getByRole('link', { name: 'You', exact: true }).click();
  await page.locator('#you-activity').click();
  await expect(page).toHaveURL(/\/activity\/$/);
  await expect(nav.getByRole('link', { name: 'You', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('h1')).toHaveText('Activity');
  // What the steps above did, each one sentence, from the web.
  const log = page.locator('#activity');
  await expect(log).toBeVisible();
  for (const what of [
    /^Signed in$/,
    /^Added a note to /,
    /^Earned /,
    /^Changed settings$/,
    /^Replaced your standing address$/
  ])
    await expect(log.locator('.activity-what', { hasText: what }).first()).toBeVisible();
  await expect(log.locator('.event.settings .hint').first()).toHaveText(/ to /);
  await expect(log.locator('.event .activity-via', { hasText: 'on the web' }).first()).toBeVisible();
  await expect(log.locator('h2.activity-day').first()).toHaveText(/^Today · /);
  await page.goto('/mail-log/');
  await expect(page).toHaveURL(/\/activity\/$/);
  await expect(page.locator('h1')).toHaveText('Activity');
});

test('the map pins notes with a place of their own, and a pin lists its notes', async ({ page }) => {
  const refused = [];
  page.on('console', (m) => /Content Security Policy|Refused to/.test(m.text()) && refused.push(m.text()));
  // One pin, so the map centres on it whatever other tests have saved.
  await page.route('**/api/map/notes', (route) =>
    route.fulfill({
      json: {
        notes: 3,
        pins: [
          {
            date: '2026-10-06',
            id: 'w-map',
            lat: 48.856613,
            lon: 2.352222,
            place: 'Le Marais, Paris',
            exact: true,
            tags: [],
            release: '4.5',
            version: '4.5.114',
            text: 'Croissants on the bench'
          }
        ]
      }
    })
  );
  await page.goto('/timeline/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('link', { name: 'Map', exact: true }).click();
  await expect(page).toHaveURL(/\/map\/$/);
  await expect(nav.getByRole('link', { name: 'Map', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('h1')).toHaveText('Map');
  await expect(page.locator('.lede')).toHaveText('1 note with a place of its own.');
  const map = page.getByRole('region', { name: 'Map of your notes' });
  await expect(map.locator('canvas')).toBeVisible();
  await expect(
    page.getByText('Choose a pin or a group to list its notes here. Each version number opens its day.')
  ).toBeVisible();
  // The pin is drawn at the centre once the map has settled.
  const box = await map.boundingBox();
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2 + 14, box.y + box.height / 2 + 10);
    await expect(page.getByRole('heading', { name: 'Le Marais, Paris' })).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
  const picked = page.locator('.map-notes li');
  await expect(picked).toHaveCount(1);
  await expect(picked).toContainText('Croissants on the bench');
  await expect(picked.locator('a.tday-head')).toHaveAttribute('href', '/day/?d=2026-10-06');

  // A note's place link opens the map on its spot, its notes already listed.
  await page.goto('/today/');
  await page.goto('/map/#d=2026-10-06&n=w-map');
  await expect(page.getByRole('heading', { name: 'Le Marais, Paris' })).toBeVisible();
  await expect(page.locator('.map-notes li')).toContainText('Croissants on the bench');
  await expect(map.locator('canvas')).toBeVisible();
  // The email's link for a day's own place opens on it with that day's notes,
  await page.goto('/today/');
  await page.goto('/map/#d=2026-10-06&ll=48.85%2C2.35');
  await expect(page.getByRole('heading', { name: 'Le Marais, Paris' })).toBeVisible();
  // and on the place alone when none of that day's notes has a spot.
  await page.goto('/today/');
  await page.goto('/map/#d=2026-10-07&ll=44.98%2C-93.26');
  await expect(map.locator('canvas')).toBeVisible();
  await expect(
    page.getByText('Choose a pin or a group to list its notes here. Each version number opens its day.')
  ).toBeVisible();
  expect(refused).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
});

test('the map narrows by words, tag and release, and a group lists every note in it', async ({ page }) => {
  const refused = [],
    asked = [];
  page.on('console', (m) => /Content Security Policy|Refused to/.test(m.text()) && refused.push(m.text()));
  // Two notes 800 m apart in Paris, one group at the zoom the map fits them
  // to (11) but 32px either side of it, too far for one tap to reach both
  // pins, and one in Minneapolis two releases before.
  const pin = (date, id, release, lat, lon, place, tags, text) => ({
    date,
    id,
    release,
    version: release + '.100',
    lat,
    lon,
    place,
    exact: true,
    tags,
    text
  });
  await page.route('**/api/map/notes', (route) =>
    route.fulfill({
      json: {
        notes: 3,
        pins: [
          pin('2026-10-06', 'w-a', '4.5', 48.8566, 2.3522, 'Le Marais, Paris', ['bakery'], 'Croissants on the bench'),
          pin('2026-10-05', 'w-b', '4.5', 48.8566, 2.3631, 'Le Marais, Paris', [], 'Rain on the Seine'),
          pin('2024-01-12', 'w-c', '4.3', 44.9778, -93.265, 'Minneapolis', ['lake'], 'First snow on the lake')
        ]
      }
    })
  );
  await page.route('**/api/map/search', (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: { terms: ['snow'], found: [{ date: '2024-01-12', id: 'w-c' }] } });
  });
  await page.goto('/map/');
  const lede = page.locator('.lede'),
    releases = page.getByRole('combobox', { name: 'Release' }),
    tags = page.getByRole('combobox', { name: 'Tag' }),
    map = page.getByRole('region', { name: 'Map of your notes' });
  await expect(lede).toHaveText('3 notes with a place of their own.');
  await expect(releases.locator('option')).toHaveText(['All releases', '4.5 (2)', '4.3 (1)']);
  await expect(tags.locator('option')).toHaveText(['All tags', '#bakery (1)', '#lake (1)']);

  // A release keeps its pins, and the tags menu offers what that release has.
  await releases.selectOption('4.5');
  await expect(page).toHaveURL(/\/map\/#v=4\.5$/);
  await expect(lede).toHaveText('2 of 3 notes with a place of their own.');
  await expect(tags.locator('option')).toHaveText(['All tags', '#bakery (1)']);

  // The map fits the two, which stay one group at its middle: choosing it
  // lists both, newest first. (Opened on the release, so no move is under way:
  // a tap stops one where it is.)
  await page.reload();
  await expect(lede).toHaveText('2 of 3 notes with a place of their own.');
  await expect(map.locator('canvas')).toBeVisible();
  const box = await map.boundingBox();
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole('heading', { name: 'Le Marais, Paris' })).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await expect(page.locator('#map-picked')).toHaveText('2 notes in Le Marais, Paris');
  await expect(page.locator('.map-notes li')).toHaveText([/Croissants on the bench/, /Rain on the Seine/]);

  // A tag, then the words: found by POST, and kept in the # alone.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(lede).toHaveText('3 notes with a place of their own.');
  await expect(
    page.getByText('Choose a pin or a group to list its notes here. Each version number opens its day.')
  ).toBeVisible();
  await tags.selectOption('lake');
  await expect(lede).toHaveText('1 of 3 notes with a place of their own.');
  await expect(releases).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await releases.selectOption('4.5');
  await page.getByRole('searchbox', { name: 'Words' }).fill('snow');
  await expect(lede).toHaveText('None of your 3 notes with a place of their own match.');
  await expect(page).toHaveURL(/\/map\/#q=snow&v=4\.5$/);
  expect(asked).toEqual([{ q: 'snow' }]);
  // The release that keeps nothing stays to be undone.
  await expect(releases.locator('option')).toHaveText(['All releases', '4.5 (0)', '4.3 (1)']);
  await releases.selectOption('');
  await expect(lede).toHaveText('1 of 3 notes with a place of their own.');
  expect(refused).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
});

test('You says Release Notes comes with the Weekly Thing', async ({ page }) => {
  // Ada gets the issues on the dev server's made-up list.
  await page.goto('/you/');
  await expect(page.locator('#you-weekly')).toHaveAttribute('data-standing', 'reader');
  await expect(page.locator('#you-weekly')).toContainText('Free with your Weekly Thing subscription.');
});
