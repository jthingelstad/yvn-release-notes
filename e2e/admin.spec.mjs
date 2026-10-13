// Admin draft -> saved preview -> schedule -> cancellation, in fictional services.
import { test, expect } from '@playwright/test';
test('product updates can be reviewed and scheduled at phone, tablet and desktop widths', async ({ page, context }) => {
  const baseURL = test.info().project.use.baseURL;
  const headers = { Origin: baseURL };
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
  expect((await context.request.post('/api/auth/start',{data:{email:'ada@example.com'},headers})).status()).toBe(202);
  const mail=await (await context.request.get('/dev-mail/?to=ada@example.com')).text();
  const code=mail.match(/type this code where you asked: (\d{6})/)[1];
  expect((await context.request.post('/api/auth/verify',{data:{email:'ada@example.com',code},headers})).ok()).toBeTruthy();
  for(const [width,name] of [[390,'phone'],[768,'tablet'],[1280,'desktop']]) {
    await page.setViewportSize({width,height:1000});
    await page.goto('/settings/');
    await page.getByRole('link',{name:'Manage product updates'}).click();
    await expect(page).toHaveURL(/\/admin\/$/);
    await expect(page).toHaveTitle(/Product updates/);
    await expect(page.getByRole('heading',{name:'Product updates',exact:true})).toBeVisible();
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
