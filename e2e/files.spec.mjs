// Files from the web: a photo with a new note, then a PDF added to it, as a
// person does it. The dev server takes the signed form at /dev-upload/ the
// way S3 would (FakeS3.form_upload), so this runs the page's whole path.
import { test, expect } from '@playwright/test';

// A real 1 x 1 PNG, so the browser draws it, and a small PDF.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

// Both sign in as Ada, and a second code replaces the first: one at a time.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page, baseURL }) => {
  const post = (path, data) => page.request.post(path, { data, headers: { Origin: baseURL } });
  await post('/api/auth/start', { email: 'ada@example.com' });
  const mail = await (await page.request.get('/dev-mail/?to=ada@example.com')).text();
  const code = mail.match(/type this code where you asked: (\d{6})/)[1];
  expect((await post('/api/auth/verify', { email: 'ada@example.com', code })).ok()).toBeTruthy();
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
