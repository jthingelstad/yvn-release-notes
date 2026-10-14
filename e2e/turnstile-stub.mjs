// Cloudflare's real Turnstile script refuses localhost with a 400 (the widget
// lists only notes.yourversionnumber.com), so every page here gets a stand-in
// that hands out a fixed token. Nothing reaches Cloudflare from a test.
export const STUB_TOKEN = 'e2e-turnstile-token';

// Pass the browser context, so tabs a test opens get it too.
export async function stubTurnstile(context) {
  await context.route(/^https:\/\/challenges\.cloudflare\.com\//, (route) =>
    new URL(route.request().url()).pathname === '/turnstile/v0/api.js'
      ? route.fulfill({
          contentType: 'text/javascript',
          body: `window.turnstile = {
            render: (el, opts) => { setTimeout(() => opts.callback(${JSON.stringify(STUB_TOKEN)}), 10); return 'e2e'; },
            reset: () => {}
          };
          setTimeout(() => window.releaseNotesTurnstileLoaded(), 0);`
        })
      : route.abort()
  );
}
