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
  await expect(page.getByRole('heading',{name:'Alex',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Edit Alex',exact:true}).click();
  await page.getByLabel('Name',{exact:true}).fill('Alexa');
  await page.getByLabel('Include in my daily email').uncheck();
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await expect(page.getByLabel('Upcoming dates')).toContainText('Web only');
  await expect(page.getByRole('heading',{name:'Alexa',exact:true})).toBeVisible();

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
  await expect(page.getByRole('heading',{name:'Autumn trip',exact:true})).toBeVisible();
  await expect(page.getByLabel('Upcoming dates')).toContainText('Paris');
  expect((await (await context.request.get('/api/me')).json()).tz).toBe('America/Chicago');

  await page.getByRole('button',{name:'Add a date',exact:true}).click();
  await page.getByRole('combobox',{name:'Kind',exact:true}).selectOption('event');
  await page.getByLabel('Title',{exact:true}).fill('A concert');
  await page.getByLabel('Date',{exact:true}).fill('2026-01-01');
  await page.getByRole('button',{name:'Save date',exact:true}).click();
  await page.getByText('Past events (1)',{exact:true}).click();
  await expect(page.getByRole('heading',{name:'A concert',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText('Past events (1)',{exact:true})).toBeVisible();

  for(const [width,height,name] of [[320,740,'small-phone'],[390,844,'phone'],[768,1024,'tablet'],[1280,1000,'desktop'],[844,390,'landscape']]) {
    await page.setViewportSize({width,height});
    for(const colorScheme of ['light','dark']) {
      await page.emulateMedia({colorScheme,reducedMotion:'reduce'});
      await expect(page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Upcoming',exact:true})).toHaveAttribute('aria-current','page');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBeTruthy();
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
  await expect(page.getByRole('heading',{name:'Alexa',exact:true})).toHaveCount(0);
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
  await expect(page.getByRole('heading',{name:'Recovered edit',exact:true})).toBeVisible();
});
