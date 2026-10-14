// Admin draft -> saved preview -> schedule -> cancellation, in fictional services.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
let cookies;
test.beforeAll(async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL });
  const headers = { Origin: info.project.use.baseURL };
  expect((await context.request.post('/api/auth/start', { headers, data: { email: 'ada@example.com' } })).status()).toBe(202);
  const mail = await (await context.request.get('/dev-mail/?to=ada@example.com')).text();
  const code = mail.match(/type this code where you asked: (\d{6})/)[1];
  expect((await context.request.post('/api/auth/verify', { headers, data: { email: 'ada@example.com', code } })).ok()).toBeTruthy();
  cookies = await context.cookies();
  await context.close();
});
test.beforeEach(async ({ context }) => { await context.addCookies(cookies); });
test('product updates can be reviewed and scheduled at phone, tablet and desktop widths', async ({ page, context }) => {
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
  for(const [width,name] of [[390,'phone'],[768,'tablet'],[1280,'desktop']]) {
    await page.setViewportSize({width,height:1000});
    await page.goto('/settings/');
    await page.getByRole('link',{name:'Administration'}).click();
    await expect(page).toHaveURL(/\/admin\/$/);
    await expect(page).toHaveTitle(/Product updates/);
    await expect(page.getByRole('heading',{name:'Product updates',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'Users',exact:true}).click();
    await expect(page).toHaveURL(/\/admin-users\/$/);
    await expect(page.getByRole('heading',{name:'Users',exact:true})).toBeVisible();
    await expect(page.getByRole('rowheader',{name:'ada@example.com',exact:true})).toBeVisible();
    await expect(page.getByLabel('User totals')).toContainText('receiving emails');
    const response=await context.request.get('/api/admin/users');
    const overview=await response.json();
    expect(overview.users.find(u=>u.email==='ada@example.com').entries).toBeGreaterThan(0);
    expect(JSON.stringify(overview)).not.toMatch(/\"(?:text|media|tags|links|place|birthday|inbox|pk|sk)\"/);
    await page.getByLabel('Find an email address').fill('no-match@example.com');
    await expect(page.getByRole('status')).toContainText('Showing 0');
    await expect(page.getByText('No users match these filters.')).toBeVisible();
    await page.getByLabel('Find an email address').fill('ada@example.com');
    await page.getByLabel('Email status',{exact:true}).selectOption('stopped');
    await expect(page.getByRole('status')).toContainText('Showing 0');
    await page.getByLabel('Email status',{exact:true}).selectOption('active');
    await expect(page.getByRole('rowheader',{name:'ada@example.com',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Reload users'}).click();
    await expect(page.getByRole('button',{name:'Reload users'})).toBeEnabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({path:`/tmp/yvn-admin-users-${name}.png`,fullPage:true});
    await page.getByRole('link',{name:'Product updates',exact:true}).click();
    await page.getByLabel('Title',{exact:true}).fill(`Agent connections · ${name}`);
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('A fictional product update.\n\nRead the setup guide at https://example.com/connect.');
    await expect(page.getByRole('region',{name:'Email section preview'})).toContainText('Release Notes about Release Notes');
    await page.getByRole('button',{name:'Create draft'}).click();
    await expect(page.getByRole('status')).toContainText('Draft saved');
    await expect(page.getByRole('region',{name:'Email section preview'}).getByRole('link')).toHaveText('A page at example.com');
    // The default date must submit the same date displayed in the field.
    const date=await page.getByLabel('Email date').inputValue();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await page.getByRole('button',{name:'Schedule update',exact:true}).click();
    await expect(page.getByRole('heading',{name:`Scheduled for ${date}`})).toBeVisible();
    await expect(page.getByRole('textbox',{name:'Message',exact:true})).toHaveAttribute('readonly','');
    await expect(page.getByRole('status')).toContainText(`Scheduled for ${date}`);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({path:`/tmp/yvn-product-updates-${name}.png`,fullPage:true});
    await page.getByRole('button',{name:'Cancel schedule'}).click();
    await expect(page.getByRole('status')).toContainText('Schedule cancelled');
    await expect(page.getByRole('textbox',{name:'Message',exact:true})).not.toHaveAttribute('readonly','');
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'Delete draft'}).click();
    await expect(page.getByRole('status')).toContainText('Draft deleted');
  }
  expect(errors).toEqual([]);
});


test('Users columns sort in both directions and keep filtering the sorted rows', async ({ page }) => {
  const base = { stopped_reason: null, pause_through: null, tz: 'America/Chicago', last_sent_date: null, last_added_at: null, joined_at: null, send_time: '06:00' };
  const users = [
    { ...base, email: 'zoe@example.com', status: 'stopped', entries: 10, days: 9, last_added_at: '2026-10-12T14:00:00Z', last_sent_date: '2026-10-10', joined_at: '2026-09-01T10:00:00Z', send_time: '18:00' },
    { ...base, email: 'ada@example.com', status: 'active', entries: 2, days: 1, last_added_at: '2026-10-12T12:00:00Z', last_sent_date: '2026-10-12', joined_at: '2026-10-01T10:00:00Z', send_time: '09:00', tz: 'Europe/Paris' },
    { ...base, email: 'bea@example.com', status: 'paused', entries: 0, days: 0, pause_through: '2026-10-20', send_time: '07:00' }
  ];
  await page.route('**/api/admin/users', route => route.fulfill({ json: { users, as_of: '2026-10-13T15:00:00Z' } }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.goto('/admin-users/');
  await expect(page).toHaveTitle('Users: Release Notes');
  const table = page.getByRole('table', { name: 'Users', exact: true });
  const emails = () => table.locator('tbody th').allTextContents();
  await expect(table.locator('tbody tr')).toHaveCount(3);
  expect(await emails()).toEqual(['ada@example.com', 'bea@example.com', 'zoe@example.com']);
  const sequences = [
    ['Email address', ['zoe@example.com', 'bea@example.com', 'ada@example.com'], ['ada@example.com', 'bea@example.com', 'zoe@example.com'], 'descending'],
    ['Email status', ['bea@example.com', 'ada@example.com', 'zoe@example.com'], ['zoe@example.com', 'ada@example.com', 'bea@example.com'], 'ascending'],
    ['Entries', ['bea@example.com', 'ada@example.com', 'zoe@example.com'], ['zoe@example.com', 'ada@example.com', 'bea@example.com'], 'ascending'],
    ['Days', ['bea@example.com', 'ada@example.com', 'zoe@example.com'], ['zoe@example.com', 'ada@example.com', 'bea@example.com'], 'ascending'],
    ['Last added', ['ada@example.com', 'zoe@example.com', 'bea@example.com'], ['zoe@example.com', 'ada@example.com', 'bea@example.com'], 'ascending'],
    ['Last email', ['zoe@example.com', 'ada@example.com', 'bea@example.com'], ['ada@example.com', 'zoe@example.com', 'bea@example.com'], 'ascending'],
    ['Daily send', ['bea@example.com', 'ada@example.com', 'zoe@example.com'], ['zoe@example.com', 'ada@example.com', 'bea@example.com'], 'ascending'],
    ['Joined', ['zoe@example.com', 'ada@example.com', 'bea@example.com'], ['ada@example.com', 'zoe@example.com', 'bea@example.com'], 'ascending']
  ];
  for (const [label, first, second, direction] of sequences) {
    const heading = table.getByRole('columnheader', { name: label, exact: true });
    const button = heading.getByRole('button', { name: label, exact: true });
    await button.click();
    await expect(heading).toHaveAttribute('aria-sort', direction);
    expect(await emails()).toEqual(first);
    await button.click();
    await expect(heading).toHaveAttribute('aria-sort', direction === 'ascending' ? 'descending' : 'ascending');
    expect(await emails()).toEqual(second);
  }
  await page.getByLabel('Find an email address').fill('bea');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Email status', { exact: true }).selectOption('stopped');
  await expect(page.getByText('No users match these filters.')).toBeVisible();
  await page.getByLabel('Find an email address').fill('');
  await page.getByLabel('Email status', { exact: true }).selectOption('all');
  for (const [width, height, name] of [[320, 740, 'small-phone'], [390, 844, 'phone'], [768, 1024, 'tablet'], [1440, 1000, 'desktop'], [844, 390, 'landscape']]) {
    await page.setViewportSize({ width, height });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
      const scroll = page.getByRole('region', { name: 'Users table' });
      await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; });
      await table.getByRole('columnheader', { name: 'Joined', exact: true }).getByRole('button').click();
      await scroll.evaluate(node => { node.scrollLeft = 0; });
      await page.screenshot({ path: `/tmp/yvn-users-table-${name}-${colorScheme}.png`, fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});
