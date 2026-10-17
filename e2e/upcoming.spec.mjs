// Real owner API, fake mail/storage: create each kind, edit, reminder preference,
// past-event retention and responsive navigation. No live sign-in or writes.
import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});
let cookies;
test.beforeAll(async ({browser},info) => {
  const context=await browser.newContext({baseURL:info.project.use.baseURL});
  const headers={Origin:info.project.use.baseURL};
  expect((await context.request.post('/api/auth/start',{headers,data:{email:'ada@example.com'}})).status()).toBe(202);
  const mail=await (await context.request.get('/dev-mail/?to=ada@example.com')).text();
  const code=mail.match(/type this code where you asked: (\d{6})/)[1];
  expect((await context.request.post('/api/auth/verify',{headers,data:{email:'ada@example.com',code}})).ok()).toBeTruthy();
  cookies=await context.cookies();
  await context.close();
});
test.beforeEach(async ({context}) => {await context.addCookies(cookies);});

test('Upcoming dates persist and remain usable on phone, tablet, desktop and landscape', async ({page,context}) => {
  test.setTimeout(60_000);
  const headers={Origin:test.info().project.use.baseURL},errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
  await page.setViewportSize({width:390,height:844});
  await page.goto('/today/');
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Upcoming',exact:true}).click();
  await expect(page).toHaveURL(/\/upcoming\/$/);
  await expect(page).toHaveTitle('Upcoming: Release Notes');
  await expect(page.getByRole('heading',{name:'Upcoming',exact:true})).toBeVisible();
  const {today}=await (await context.request.get('/api/upcoming')).json();
  const [year,month,day]=today.split('-');
  await page.getByRole('button',{name:'Add a date',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Add a date',exact:true})).toBeFocused();
  await page.getByLabel('Name',{exact:true}).fill('Alex');
  await page.getByRole('combobox',{name:'Month',exact:true}).selectOption(String(Number(month)));
  await page.getByLabel('Day',{exact:true}).fill(String(Number(day)));
  await page.getByLabel('Birth year (optional)',{exact:true}).fill(String(Number(year)-50));
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Date saved.'})).toBeVisible();
  await expect(page.getByLabel('Upcoming dates')).toContainText('Alex turns 5.0.0. A major release.');
  await page.reload();
  await expect(page.getByRole('rowheader',{name:'Alex',exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Edit Alex',exact:true}).click();
  await page.getByLabel('Name',{exact:true}).fill('Alexa');
  await page.getByLabel('Include in my daily email').uncheck();
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByLabel('Upcoming dates')).toContainText('Web only');
  await expect(page.getByRole('rowheader',{name:'Alexa',exact:false})).toBeVisible();

  await page.getByRole('button',{name:'Add a date',exact:true}).click();
  await page.getByRole('combobox',{name:'Kind',exact:true}).selectOption('anniversary');
  await page.getByLabel('Title',{exact:true}).fill('A project');
  await page.getByLabel('Original year (optional)').fill(String(Number(year)-10));
  await page.getByLabel('Remind me before (days)').fill('3, 1, 0');
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByLabel('Upcoming dates')).toContainText('A project — 10 years.');
  await page.getByRole('button',{name:'Edit A project',exact:true}).click();
  await page.getByLabel('Include in my daily email').uncheck();
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await page.getByRole('button',{name:'Edit A project',exact:true}).click();
  await page.getByLabel('Include in my daily email').check();
  await expect(page.getByLabel('Remind me before (days)')).toHaveValue('3, 1, 0');
  await page.getByRole('button',{name:'Save date',exact:true}).click();

  await page.getByRole('button',{name:'Add a date',exact:true}).click();
  await page.getByRole('combobox',{name:'Kind',exact:true}).selectOption('trip');
  await page.getByLabel('Title',{exact:true}).fill('Autumn trip');
  await page.getByLabel('Start date').fill(today);
  await page.getByLabel('End date').fill(today);
  await page.getByLabel('Destination',{exact:true}).fill('Paris');
  await page.getByRole('listbox',{name:'Places'}).getByRole('option').first().click();
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('rowheader',{name:'Autumn trip',exact:false})).toBeVisible();
  await expect(page.getByLabel('Upcoming dates')).toContainText('Paris');
  expect((await (await context.request.get('/api/me')).json()).tz).toBe('America/Chicago');
  await expect(page.getByRole('img',{name:'Birthday (every year)',exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'Anniversary (every year)',exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'Trip',exact:true})).toBeVisible();

  await page.getByRole('button',{name:'Add a date',exact:true}).click();
  await page.getByRole('combobox',{name:'Kind',exact:true}).selectOption('event');
  await page.getByLabel('Title',{exact:true}).fill('A concert');
  await page.getByLabel('Date',{exact:true}).fill('2026-01-01');
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await page.getByText('Past events (1)',{exact:true}).click();
  await expect(page.getByRole('rowheader',{name:'A concert',exact:false})).toBeVisible();
  await page.reload();
  await expect(page.getByText('Past events (1)',{exact:true})).toBeVisible();

  for(const [width,height,name] of [[320,740,'small-phone'],[390,844,'phone'],[768,1024,'tablet'],[1280,1000,'desktop'],[844,390,'landscape']]) {
    await page.setViewportSize({width,height});
    for(const colorScheme of ['light','dark']) {
      await page.emulateMedia({colorScheme,reducedMotion:'reduce'});
      await expect(page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Upcoming',exact:true})).toHaveAttribute('aria-current','page');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBeTruthy();
      for (const action of ['Edit Autumn trip','Delete Autumn trip']) {
        const button = page.getByRole('button',{name:action,exact:true});
        const bounds = await button.boundingBox();
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({path:`/tmp/yvn-upcoming-${name}-${colorScheme}.png`,fullPage:true});
      await page.getByRole('button',{name:'Edit Autumn trip',exact:true}).click();
      await expect(page.getByLabel('Start date')).toHaveValue(today);
      await expect(page.getByText('Destination: Paris',{exact:false})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBeTruthy();
      await page.screenshot({path:`/tmp/yvn-upcoming-editor-${name}-${colorScheme}.png`,fullPage:true});
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
    }
  }
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Delete Alexa',exact:true}).click();
  await expect(page.getByRole('rowheader',{name:'Alexa',exact:false})).toHaveCount(0);
  const exported=await (await context.request.get('/api/export')).json();
  expect(exported.upcoming.map(e=>e.title)).toEqual(expect.arrayContaining(['A project','Autumn trip','A concert']));
  expect(exported.upcoming).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('a stale revision, invalid reminder and network failure retain the editable form', async ({page,context}) => {
  const headers={Origin:test.info().project.use.baseURL};
  const {today}=await (await context.request.get('/api/upcoming')).json();
  const entry=await (await context.request.post('/api/upcoming',{headers,data:{kind:'event',title:'Conflict test',date:today}})).json();
  await page.goto('/upcoming/');
  await page.getByRole('button',{name:'Edit Conflict test',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Locally edited');
  expect((await context.request.put('/api/upcoming/'+entry.id,{headers,data:{kind:'event',title:'Remote edit',date:today,revision:1}})).ok()).toBeTruthy();
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'changed in another window'})).toBeVisible();
  await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Locally edited');
  await page.getByRole('button',{name:'Reload list',exact:true}).click();
  await page.getByRole('button',{name:'Edit Remote edit',exact:true}).click();
  await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Remote edit');
  await page.getByLabel('Remind me before (days)').fill('0, 0');
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'six different numbers'})).toBeVisible();
  await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Remote edit');
  await page.getByLabel('Remind me before (days)').fill('7, 1, 0');
  await page.route('**/api/upcoming/'+entry.id,route=>route.abort());
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Please try again'})).toBeVisible();
  await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Remote edit');
  await page.unroute('**/api/upcoming/'+entry.id);
  await page.getByLabel('Title',{exact:true}).fill('Recovered edit');
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('rowheader',{name:'Recovered edit',exact:false})).toBeVisible();
});


test('event tables order occurrence dates ascending even when the response is unordered', async ({ page, context }) => {
  const headers = { Origin: test.info().project.use.baseURL };
  const { today } = await (await context.request.get('/api/upcoming')).json();
  const offset = (days) => new Date(Date.parse(today + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  for (const [title, days] of [['Later event', 30], ['Earlier event', 7], ['Older event', -30], ['Recent past event', -7]]) {
    expect((await context.request.post('/api/upcoming', { headers, data: { kind: 'event', title, date: offset(days) } })).ok()).toBeTruthy();
  }
  const snapshot = await (await context.request.get('/api/upcoming')).json();
  await page.route('**/api/upcoming', route => route.fulfill({ json: { ...snapshot, entries: snapshot.entries.toReversed() } }));
  await page.goto('/upcoming/');
  const future = page.getByRole('table', { name: 'Upcoming events', exact: true });
  await expect(future.getByRole('rowheader', { name: 'Earlier event', exact: true })).toBeVisible();
  const dates = await future.locator('tbody tr td:first-child time:first-child').evaluateAll(nodes => nodes.map(n => n.dateTime));
  expect(dates).toEqual(dates.toSorted());
  await page.locator('.upcoming-past summary').click();
  const past = page.getByRole('table', { name: 'Past events', exact: true });
  const pastDates = await past.locator('tbody tr td:first-child time:first-child').evaluateAll(nodes => nodes.map(n => n.dateTime));
  expect(pastDates.length).toBeGreaterThan(1);
  expect(pastDates).toEqual(pastDates.toSorted());
  await page.getByRole('button', { name: 'Edit Earlier event', exact: true }).click();
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(offset(7));
});

test('kind and tag filters combine, survive reloads and carry a tag into an existing note draft', async ({page, context}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const headers = { Origin: test.info().project.use.baseURL };
  const {today} = await (await context.request.get('/api/upcoming')).json();
  for (const entry of [
    {kind:'anniversary',title:'Team milestone',date:today.slice(5),tag:'#SPS'},
    {kind:'birthday',title:'Team birthday',date:today.slice(5),tag:'sps'},
    {kind:'anniversary',title:'Family milestone',date:today.slice(5),tag:'family'},
    {kind:'event',title:'Past team event',date:'2026-01-02',tag:'sps'},
    {kind:'event',title:'Untagged event',date:today}
  ]) expect((await context.request.post('/api/upcoming',{headers,data:entry})).status()).toBe(201);
  await page.goto('/upcoming/');
  await expect(page).toHaveTitle('Upcoming: Release Notes');
  await page.getByRole('combobox',{name:'Filter by kind',exact:true}).selectOption('anniversary');
  await page.getByRole('combobox',{name:'Filter by tag',exact:true}).selectOption('sps');
  await expect(page.getByRole('rowheader',{name:'Team milestone',exact:false})).toBeVisible();
  await expect(page.getByRole('rowheader',{name:'Family milestone',exact:false})).toHaveCount(0);
  await expect(page.getByRole('rowheader',{name:'Team birthday',exact:false})).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('combobox',{name:'Filter by kind',exact:true})).toHaveValue('anniversary');
  await expect(page.getByRole('combobox',{name:'Filter by tag',exact:true})).toHaveValue('sps');
  for (const [width,height,name] of [[390,844,'phone'],[768,1024,'tablet'],[1280,1000,'desktop'],[844,390,'landscape']]) {
    await page.setViewportSize({width,height});
    for (const colorScheme of ['light','dark']) {
      await page.emulateMedia({colorScheme,reducedMotion:'reduce'});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1)).toBeTruthy();
      await page.screenshot({path:`/tmp/yvn-upcoming-filter-${name}-${colorScheme}.png`,fullPage:true});
    }
  }
  await page.getByRole('button',{name:'Add a date',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Kind',exact:true})).toHaveValue('anniversary');
  await expect(page.getByLabel('Tag (optional)',{exact:true})).toHaveValue('sps');
  await page.getByLabel('Title',{exact:true}).fill('Second team milestone');
  await page.getByLabel('Tag (optional)',{exact:true}).fill('#sps #family');
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Use one tag'})).toBeVisible();
  await page.getByLabel('Tag (optional)',{exact:true}).fill('#SPS');
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('rowheader',{name:'Second team milestone',exact:false})).toContainText('#sps');
  const edit = page.getByRole('button',{name:'Edit Second team milestone',exact:true});
  await edit.focus();
  await expect(edit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Tag (optional)',{exact:true})).toHaveValue('sps');
  await page.getByLabel('Tag (optional)',{exact:true}).fill('');
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByRole('rowheader',{name:'Second team milestone',exact:false})).toHaveCount(0);
  await page.getByRole('combobox',{name:'Filter by kind',exact:true}).selectOption('trip');
  await expect(page.getByText('No dates match these filters.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await page.getByRole('combobox',{name:'Filter by tag',exact:true}).selectOption('-');
  await expect(page.getByRole('rowheader',{name:'Untagged event',exact:true})).toBeVisible();
  await expect(page.getByRole('rowheader',{name:'Second team milestone',exact:false})).toBeVisible();
  await page.getByRole('combobox',{name:'Filter by tag',exact:true}).selectOption('sps');
  // Search combines with the selects, survives a reload in the fragment, and clears with them.
  await page.getByRole('searchbox',{name:'Search dates',exact:true}).fill('MILESTONE');
  await expect(page.getByRole('rowheader',{name:'Team milestone',exact:false})).toBeVisible();
  await expect(page.getByRole('rowheader',{name:'Team birthday',exact:false})).toHaveCount(0);
  await expect(page).toHaveURL(/#.*q=MILESTONE/);
  await page.reload();
  await expect(page.getByRole('searchbox',{name:'Search dates',exact:true})).toHaveValue('MILESTONE');
  await page.getByRole('searchbox',{name:'Search dates',exact:true}).fill('"family milestone"');
  await expect(page.getByText('No dates match these filters.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await expect(page.getByRole('searchbox',{name:'Search dates',exact:true})).toHaveValue('');
  await page.getByRole('combobox',{name:'Filter by tag',exact:true}).selectOption('sps');
  await page.locator('.upcoming-past summary').click();
  await expect(page.getByRole('table',{name:'Past events',exact:true})).toContainText('Past team event');
  await page.evaluate(day => sessionStorage.setItem(`rn-draft-${day}`,'Already writing about today.'),today);
  const write = () => page.getByRole('link',{name:'Write a note tagged #sps for Team milestone',exact:true});
  await write().click();
  await expect(page).toHaveURL(/\/today\/#tag=sps$/);
  await expect(page.getByRole('textbox',{name:'Add to today',exact:true})).toHaveValue('Already writing about today.\n\n#sps');
  await page.getByRole('textbox',{name:'Add to today',exact:true}).fill('Celebrated a milestone. #sps');
  await page.goto('/upcoming/');
  await write().click();
  await expect(page.getByRole('textbox',{name:'Add to today',exact:true})).toHaveValue('Celebrated a milestone. #sps');
  await page.getByRole('button',{name:'Save note',exact:true}).click();
  await expect(page.locator('#notes')).toContainText('Celebrated a milestone.');
  const tagged = await (await context.request.get('/api/tags/sps')).json();
  expect(JSON.stringify(tagged)).toContain('Celebrated a milestone.');
  // The intentional invalid-tag request above is the only console error.
  expect(errors).toEqual(['Failed to load resource: the server responded with a status of 400 (Bad Request)']);
});
