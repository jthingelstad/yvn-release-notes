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
// Where: a note's place from the city search, and a day's own place, set
// and cleared, its weather following.
// The standing address: shown in settings, copied, and replaced.
// Releases: the Timeline's index, and a release's page, oldest first.
import { test, expect } from '@playwright/test';

// A real 1 x 1 PNG, so the browser draws it, and a small PDF.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
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
  await form.locator('input[type=file]').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<p>hi</p>') });
  await form.getByRole('button', { name: /Add note|Save note/ }).click();
  await expect(form.locator('.error')).toHaveText('page.html isn’t a photo, recording or PDF, so it can’t be added.');
  await expect(page.locator('article.note', { hasText: words })).toHaveCount(0);
  await expect(form.locator('textarea')).toHaveValue(words);
});

test('search lists every tag, finds words, marks them, and the box clears back to the tags', async ({ page }) => {
  await page.goto('/search/');
  const tags = page.locator('#every-tag-list');
  await expect(tags.locator('a.tag').first()).toBeVisible();
  const words = `Lighthouse ${Date.now()}`;
  await page.request.post('/api/days/' + (await (await page.request.get('/api/today')).json()).date + '/notes',
    { data: { text: `${words} by the café. #maine` }, headers: { Origin: new URL(page.url()).origin } });

  const box = page.locator('#search-form input[type=search]');
  await box.fill(words.toLowerCase());
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#q=${encodeURIComponent(words.toLowerCase())}$`));
  await expect(page.locator('#search-lede')).toHaveText('1 note on 1 day.');
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
  await page.getByLabel('Write out what I say').uncheck();
  await expect(page.locator('#transcribe-saved')).toBeVisible();
});

test('turning on descriptions describes a photo, shown only where search found it', async ({ page }) => {
  await page.goto('/settings/');
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
  await expect(place).toHaveAttribute('href', /^https:\/\/maps\.apple\.com\/\?ll=48\.85,2\.35/);
  // The form starts over without a place.
  await expect(form.locator('#note-where')).toBeHidden();
  await expect(form.getByRole('button', { name: 'Where' })).toBeVisible();
});

test('a past day can have a place of its own, and its weather follows', async ({ page }) => {
  const day = new Date(Date.now() - 20 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  await page.goto(`/day/?d=${day}`);
  const where = page.locator('#day-where');
  await where.getByRole('button', { name: 'Where was this day?' }).click();
  await where.getByLabel('Where this day was').fill('Par');
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/days/${day}/place`) && r.request().method() === 'PUT');
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
  await expect(page.locator('#release-counts')).toHaveText('1 day with notes, 1 note.');
  await expect(page.locator('#release-days .tday')).toHaveCount(1);
  await expect(page.locator('#release-days')).toContainText('the day the new bike came');

  await page.goto('/release/?v=4.5');
  await expect(page.locator('#release-head')).toContainText('and still going');
  await expect(page.locator('#release-tags')).toContainText('#walks');
  const heads = page.locator('#release-days a.tday-head');
  await expect(heads.last()).toHaveAttribute('href', '/today/');
  await expect(heads.first()).not.toHaveAttribute('href', '/today/');

  // A release not begun goes back to the Timeline.
  await page.goto('/release/?v=9.9');
  await expect(page).toHaveURL(/\/timeline\/$/);
});

test('a release index that fails to load says so, and the days still show', async ({ page }) => {
  await page.route('**/api/releases', (route) => route.fulfill({ status: 500, json: { error: 'server' } }));
  await page.goto('/timeline/');
  await expect(page.locator('#releases')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Couldn’t load this just now. Reload to try again.');
  await expect(page.locator('.tday').first()).toBeVisible();
});
