// Signed-in pages, as Ada, the dev server's subscriber.
//
// Files from the web: a photo with a new note, then a PDF added to it, as a
// person does it. The dev server takes the signed form at /dev-upload/ the
// way S3 would (FakeS3.form_upload), so this runs the page's whole path.
// Recording: Chromium's made-up microphone, kept with a new note.
// Search: the tags, then words, found and marked.
// Transcripts: the setting, a recording written out, and found by search.
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
  await form.getByRole('button', { name: 'Add note' }).click();

  const note = page.locator('article.note', { hasText: words });
  await expect(note.locator('.media img')).toHaveJSProperty('naturalWidth', 1);
  await expect(form.locator('.chosen')).toBeHidden();

  const chooser = page.waitForEvent('filechooser');
  await note.getByRole('button', { name: 'Add files' }).click();
  await (await chooser).setFiles({ name: 'Menu.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(note.locator('.media a.file')).toHaveText('Menu.pdf');
  await expect(note.locator('.media img')).toHaveCount(1);
});

test('a file that is not a photo, recording or PDF is refused by name, and nothing is saved', async ({ page }) => {
  await page.goto('/today/');
  const form = page.locator('#note-form');
  const words = `Not a page ${Date.now()}`;
  await form.locator('textarea').fill(words);
  await form.locator('input[type=file]').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<p>hi</p>') });
  await form.getByRole('button', { name: 'Add note' }).click();
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
  await form.getByRole('button', { name: 'Add note' }).click();
  const note = page.locator('article.note', { hasText: words });
  await expect(note.locator('.media audio')).toHaveCount(1);
  await expect(form.locator('.recordings audio')).toHaveCount(0);
});

test('turning on transcripts writes out a recording, and search finds what was said', async ({ page }) => {
  await page.goto('/settings/');
  const box = page.getByLabel('Write out what I say');
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(page.locator('#transcribe-saved')).toBeVisible();

  // The dev server writes it out five seconds after (transcribe.py's stand-in).
  await page.goto('/timeline/');
  await expect(page.getByText('Writing this out.').first()).toBeVisible();
  await page.waitForTimeout(6000);
  await page.reload();
  await expect(page.locator('.media .said', { hasText: 'loons were out' }).first()).toBeVisible();

  await page.goto('/search/#q=loons');
  await expect(page.locator('.media .said mark').first()).toHaveText('loons');

  await page.goto('/settings/');
  await page.getByLabel('Write out what I say').uncheck();
  await expect(page.locator('#transcribe-saved')).toBeVisible();
});
