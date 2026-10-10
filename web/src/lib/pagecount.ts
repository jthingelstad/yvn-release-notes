// Page counts for Tinylytics site 3816 (Jamie, 2026-10-08), sent from here
// so no remote script runs (Tinylytics' own route for strict CSPs), once
// for each page shown. Only the path goes: query strings carry sign-in
// tokens and dates. No cookies, and another site's referrer goes as its
// origin only. ?tiny_ignore=true stops counting in this browser;
// ?tiny_ignore=false starts it again.

const COLLECTOR = 'https://tinylytics.app/collector/sGuEB7xpDqmsxbCyVK-B';

function ignored(): boolean {
  try {
    const ignore = new URLSearchParams(location.search).get('tiny_ignore');
    if (ignore === 'true') localStorage.setItem('tiny_ignore', '1');
    if (ignore === 'false') localStorage.removeItem('tiny_ignore');
    return !!localStorage.getItem('tiny_ignore');
  } catch {
    return false; // storage blocked: count anyway
  }
}

let first = true;
let last = '';

export function countPage(path: string) {
  if (location.hostname !== 'notes.yourversionnumber.com' || path === last) return;
  last = path;
  if (ignored()) return;
  // Only the first page in a visit came from somewhere else.
  let referrer = '';
  if (first) {
    try {
      const r = new URL(document.referrer);
      if (r.origin !== location.origin) referrer = r.origin + '/';
    } catch {
      /* no referrer */
    }
  }
  first = false;
  const q = new URLSearchParams({ url: location.origin + path, path, referrer });
  fetch(`${COLLECTOR}?${q}`, { method: 'POST', mode: 'no-cors', credentials: 'omit', keepalive: true }).catch(() => {});
}
