// Release Notes: one script for every page, chosen by <body data-page>.
// Vanilla, no build step. The API is same-origin at /api; the one other
// request is the page count at the bottom.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    return { status: 0, ok: false, data: { error: 'network' } };
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* an empty or non-JSON answer */ }
  if (path === '/api/me' && method === 'GET') {
    if (res.ok) signedIn.set(); else if (res.status === 401) signedIn.drop();
  }
  return { status: res.status, ok: res.ok, data };
}

// A hint, kept in this browser, that it was signed in last time. The
// session cookie is HttpOnly, so the home page cannot see it; with the hint
// it waits for /api/me instead of showing the sign-in form first.
const signedIn = {
  get() { try { return localStorage.getItem('rn-in') === '1'; } catch (e) { return false; } },
  set() { try { localStorage.setItem('rn-in', '1'); } catch (e) { /* private mode */ } },
  drop() { try { localStorage.removeItem('rn-in'); } catch (e) { /* private mode */ } },
};

// Cobalt digits, tangerine dots. A number standing on its own says
// "Version" to a screen reader, in text only it hears; one inside a
// sentence ("That makes you 5.4.279 today") reads as it is.
function vnum(el, v, named = false) {
  el.textContent = '';
  if (named) {
    const vh = document.createElement('span');
    vh.className = 'vh';
    vh.textContent = 'Version ';
    el.append(vh);
  }
  v.split('.').forEach((part, i) => {
    if (i) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '.';
      el.append(dot);
    }
    el.append(part);
  });
}

function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function clock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const SAY = {
  email: 'That doesn’t look like an email address.',
  limited: 'That’s a lot of sign-in emails for one hour. Try again a little later.',
  'mail-failed': 'We couldn’t send the email just now. Try again in a minute.',
  'email-and-code': 'Type the six digits from the email.',
  'wrong-code': 'That code doesn’t match.',
  'too-many-tries': 'Too many wrong codes. Send yourself a new one.',
  'code-expired': 'That code has expired. Send yourself a new one.',
  'code-used': 'That code has been used. Send yourself a new one.',
  'link-used-or-expired': 'This link has been used or has expired. Links work once, for 15 minutes.',
  network: 'Couldn’t reach Release Notes. Check your connection and try again.',
  birthday: 'Type your birthday: a real date, not in the future.',
  place: 'Pick your city from the list.',
  'send-time': 'Pick a time for your email.',
  'places-failed': 'The city search isn’t answering. Try again in a minute.',
  token: ['This link isn’t one we sent. ', { href: '/#sign-in', text: 'Sign in to manage your emails' }, '.'],
  origin: 'That came from outside notes.yourversionnumber.com. Open Release Notes there and try again.',
  date: 'Pick a day between your birthday and today.',
  text: 'Write something first.',
  'too-long': 'That’s longer than one note can hold. Split it in two.',
  'too-large': 'That’s longer than one note can hold. Split it in two.',
  note: 'That note isn’t here any more. Reload the page.',
  days: 'Pick how long to pause.',
  through: 'Pick a day within the next 60.',
  stopped: 'Your emails are stopped. Start them again in settings first.',
  'delete-failed': 'Couldn’t delete everything just now. Nothing is lost; try again in a minute.',
};

// Signed out mid-write (the session ran out in another tab, or a sign-out
// elsewhere). `draft` says what happened to what was being written: 'kept'
// (the note form keeps it in this tab) or 'copy' (an edit, which doesn't).
function signedOutLine(draft) {
  const again = (t) => ({ href: '/#sign-in', text: t, back: true });
  if (draft === 'kept') return ['You’ve been signed out. Your note is kept here; ', again('sign in again'), '.'];
  if (draft === 'copy') return ['You’ve been signed out. ', again('Sign in again'), '; copy your note first if you were writing one.'];
  return ['You’ve been signed out. ', again('Sign in again'), '.'];
}

// Text, or a list of strings and {href, text} links, into a line.
function lineOf(line, text) {
  line.textContent = '';
  for (const part of [].concat(text)) {
    if (typeof part === 'string') { line.append(part); continue; }
    const a = el('a', '', part.text);
    a.href = part.href;
    if (part.back) {
      // Come back here after signing in again, with the signed-in hint
      // dropped so the home page shows its form at once.
      a.addEventListener('click', () => { store.set('rn-back', location.pathname + location.search); signedIn.drop(); });
    }
    line.append(a);
  }
}

// Show an error in root's .error line, then put focus back where the person
// was typing: `field` if given, else the root's first field, else its
// button. (The submit button is disabled while busy, which drops focus.)
function say(root, data, field) {
  const line = $('.error', root);
  let text = data.error === 'signed-out' ? signedOutLine(data.draft)
    : SAY[data.error] || 'Something went wrong. Try again.';
  if (data.error === 'wrong-code' && data.tries_left !== undefined) {
    text += data.tries_left === 1 ? ' One try left.' : ` ${data.tries_left} tries left.`;
  }
  lineOf(line, text);
  line.hidden = false;
  const target = field || root.querySelector(
    'input:not([type=radio]):not([type=hidden]):not([disabled]), textarea, select',
  ) || $('button[type=submit]', root) || $('button', root);
  // After busy() gives the button back, so a button can take focus too.
  if (target && !target.closest('[hidden]')) setTimeout(() => target.focus(), 0);
}

function quiet(root) {
  $('.error', root).hidden = true;
}

// Where a signed-in person lands: back where they were signed out, if
// that was in this tab, or Today.
function home(isNew) {
  if (isNew) return '/setup/';
  pendingBirthday.drop();
  const back = store.get('rn-back');
  store.drop('rn-back');
  return back && /^\/[a-z]/.test(back) ? back : '/today/';
}

// Every quarter hour, as the sender allows.
function sendTimes(select, value) {
  for (let m = 0; m < 24 * 60; m += 15) {
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    select.add(new Option(clock(v), v, false, v === value));
  }
  select.value = value;
}

// A city search over /api/places. Calls onPick(place) with the choice, and
// onClear() when the text changes after a pick. "No city by that name" and
// failures go to the picker's status line, outside the listbox.
function placePicker(root, onPick, onClear = () => {}) {
  const input = $('input[type=search]', root), list = $('.places', root);
  const status = $('.places-status', root);
  let timer = null, asked = 0, chosen = false;

  const show = (places, picked) => {
    list.textContent = '';
    for (const p of places) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'place';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(p === picked));
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = p === picked ? '\u2022' : '';
      const text = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = [p.region, p.country].filter(Boolean).join(', ');
      text.append(name, where);
      b.append(mark, text);
      b.addEventListener('click', () => { show(places, p); chosen = true; onPick(p); });
      list.append(b);
    }
  };

  const tell = (text) => { status.textContent = text; };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (chosen) { chosen = false; onClear(); }
    tell('');
    const q = input.value.trim();
    if (q.length < 2) { ++asked; list.textContent = ''; return; }
    timer = setTimeout(async () => {
      const mine = ++asked;
      const r = await api('GET', '/api/places?q=' + encodeURIComponent(q));
      if (mine !== asked) return; // a later search has gone out
      if (!r.ok) {
        list.textContent = '';
        return lineOf(status, r.data.error === 'signed-out' ? signedOutLine() : SAY[r.data.error] || SAY['places-failed']);
      }
      if (!r.data.places.length) { list.textContent = ''; return tell('No city by that name. Try the nearest larger one.'); }
      show(r.data.places, null);
    }, 300);
  });
  return {
    reset() { clearTimeout(timer); ++asked; chosen = false; input.value = ''; list.textContent = ''; tell(''); },
  };
}

// --- notes -------------------------------------------------------------------

// "Thursday, October 8", with the year when it isn't this one.
function dayName(iso, thisYear) {
  const [y, m, d] = iso.split('-').map(Number);
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  if (thisYear && y !== thisYear) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}

// A stored UTC time, read in the subscriber's zone.
function zoneTime(at, tz) {
  return new Date(at).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
}
function zoneShortDate(at, tz) {
  return new Date(at).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function noteText(n) {
  if (n.text) return n.text;
  if (n.media && n.media.length) return '';
  return n.source === 'email' ? 'Attachments only. They are in the original email.' : 'Nothing written.';
}

// A note's photos and recordings. Each address is the API's, which checks
// the session and redirects to a link that lasts ten minutes; the page
// never sees the bucket's own key.
function noteMedia(day, n, version) {
  const box = el('div', 'media');
  for (const m of n.media || []) {
    const src = `/api/days/${day}/notes/${encodeURIComponent(n.id)}/media/${m.n}`;
    if (m.kind === 'image') {
      const a = el('a');
      a.href = src;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const img = el('img');
      img.alt = version ? `Photo from ${version}` : 'Photo';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = src;
      // A signed link that has run out, a session that has, or a HEIC
      // outside Safari: say so rather than show a broken image.
      img.addEventListener('error', () => a.replaceWith(el('p', 'hint',
        'This photo couldn’t load. Reload, or sign in again if you’ve been signed out.' +
        (n.source === 'email' || !n.source ? ' It’s also in the original email.' : ''))));
      a.append(img);
      box.append(a);
    } else if (m.kind === 'file') {
      // A PDF or any other file: a link that opens it.
      const a = el('a', 'file', m.name || (m.type === 'application/pdf' ? 'PDF' : 'File'));
      a.href = src;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      box.append(a);
    } else {
      const audio = el('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = src;
      audio.setAttribute('aria-label', 'Recording');
      box.append(audio);
    }
  }
  return box;
}

// A note's text as a paragraph, links by name: the API's `parts` (strings
// and {url, label, site}), the same as the email's (links.segments). Bare
// web addresses still link if `parts` is missing. Built from text nodes,
// never HTML.
const URL_RE = /https?:\/\/[^\s<>"]+/gi;
function linkTo(url, label) {
  const a = el('a', '', label);
  a.href = url;
  a.rel = 'noopener noreferrer';
  a.target = '_blank';
  return a;
}

function noteBody(n, cls = 'text') {
  const p = el('p', cls);
  p.hidden = !noteText(n);
  if (n.text && Array.isArray(n.parts)) {
    for (const part of n.parts) {
      if (typeof part === 'string') {
        p.append(part);
      } else if (part.tag) {
        // A hashtag: its tag's page (tags.py).
        const a = el('a', 'tag', part.text);
        a.href = `/tag/?t=${encodeURIComponent(part.tag)}`;
        p.append(a);
      } else if (/^https?:\/\//i.test(part.url || '')) {
        p.append(linkTo(part.url, part.label || part.url));
        if (part.site) p.append(el('span', 'site', ` · ${part.site}`));
      }
    }
    return p;
  }
  const text = noteText(n);
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?'")\]}]+$/, '');
    p.append(text.slice(last, m.index));
    p.append(linkTo(url, url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')));
    last = m.index + url.length;
  }
  p.append(text.slice(last));
  return p;
}

// Where a note came from, as the note's line says it.
function sourceName(n) {
  if (n.source === 'web') return 'on the web';
  if (n.source === 'import') return `from ${n.from || 'an import'}`;
  return 'by email';
}

// The time reads in the zone the note was written in (n.tz), named when it
// isn't the subscriber's own.
function noteMeta(n, tz) {
  const zone = n.tz || tz;
  let when = '';
  if (n.at && !n.all_day) {
    when = n.late ? `${zoneShortDate(n.at, zone)}, ${zoneTime(n.at, zone)}` : zoneTime(n.at, zone);
    if (zone !== tz) {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(new Date(n.at)).find((x) => x.type === 'timeZoneName');
      if (name) when += ` ${name.value}`;
    }
  }
  const parts = [when, n.place, sourceName(n)];
  if (n.attachments) parts.push(n.attachments === 1 ? '1 attachment in the email' : `${n.attachments} attachments in the email`);
  if (n.edited_at) parts.push('edited');
  return parts.filter(Boolean).join(' · ');
}

// A day's notes, each with Edit and Delete. onChange() runs after either.
function renderNotes(root, day, notes, tz, onChange, version) {
  root.textContent = '';
  for (const n of notes) {
    const item = el('article', 'note');
    const meta = el('p', 'meta', noteMeta(n, tz));
    const text = noteBody(n);
    const actions = el('div', 'actions');
    const path = `/api/days/${day}/notes/${encodeURIComponent(n.id)}`;

    const edit = () => {
      const form = el('form', 'edit');
      form.noValidate = true;
      const area = el('textarea');
      area.name = 'text';
      area.rows = Math.min(12, Math.max(3, n.text.split('\n').length + 1));
      area.value = n.text;
      area.setAttribute('aria-label', 'Edit this note');
      const save = el('button', 'go small', 'Save');
      save.type = 'submit';
      const row = el('div', 'row');
      row.append(save, button('Cancel', 'quiet', () => renderNotes(root, day, notes, tz, onChange, version)));
      const err = el('p', 'error');
      err.setAttribute('role', 'alert');
      err.hidden = true;
      form.append(area, row, err);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        busy(form, async () => {
          quiet(form);
          const r = await api('PUT', path, { text: area.value });
          if (!r.ok) return say(form, { ...r.data, draft: 'copy' }, area);
          onChange();
        });
      });
      text.replaceWith(form);
      actions.hidden = true;
      area.focus();
    };

    const ask = () => {
      actions.textContent = '';
      const files = n.media && n.media.length;
      const q = el('span', 'confirm', n.source === 'email'
        ? (files ? 'Delete this note and the email it came in, with its photos and recordings?' : 'Delete this note and the email it came in?')
        : (files ? 'Delete this note, with its photos and recordings?' : 'Delete this note?'));
      const yes = button('Delete', 'quiet danger', async () => {
        yes.disabled = true;
        const r = await api('DELETE', path);
        if (!r.ok && r.status !== 404) {
          yes.disabled = false;
          lineOf(q, r.data.error === 'signed-out' ? signedOutLine() : SAY[r.data.error] || 'That didn’t work. Try again.');
          yes.focus();
          return;
        }
        onChange();
      });
      actions.append(q, yes, button('Keep it', 'quiet', () => renderNotes(root, day, notes, tz, onChange, version)));
    };

    actions.append(button('Edit', 'quiet', edit), button('Delete', 'quiet', ask));
    item.append(meta, text);
    if (n.media && n.media.length) item.append(noteMedia(day, n, version));
    item.append(actions);
    root.append(item);
  }
}

// The form that adds a note to a day. onAdded() runs after. What is being
// written is kept in this tab, by day, until it is saved, so a sign-out
// mid-note (or a reload) doesn't lose it; restore(day) puts it back.
function noteForm(form, getDay, onAdded) {
  const key = () => `rn-draft-${getDay()}`;
  form.text.addEventListener('input', () => {
    quiet(form);
    if (form.text.value.trim()) store.set(key(), form.text.value); else store.drop(key());
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form, async () => {
      quiet(form);
      if (!form.text.value.trim()) return say(form, { error: 'text' }, form.text);
      // The zone it is being written in, so its time reads as it did here.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await api('POST', `/api/days/${getDay()}/notes`, { text: form.text.value, tz });
      if (!r.ok) {
        store.set(key(), form.text.value);
        return say(form, { ...r.data, draft: 'kept' }, form.text);
      }
      store.drop(key());
      form.text.value = '';
      onAdded();
    });
  });
  return {
    restore() { form.text.value = store.get(key()) || ''; },
  };
}

function streakLine(root, s) {
  root.textContent = '';
  const days = (n) => (n === 1 ? '1 day' : `${n} days`);
  let head, tail = '';
  if (!s.current) {
    head = 'Every note starts a streak.';
    if (s.longest) tail = `Your longest is ${days(s.longest)}.`;
  } else if (s.current >= s.longest && s.current > 1 && s.today) {
    head = `${days(s.current)} in a row, your longest yet.`;
  } else {
    head = `${days(s.current)} in a row.`;
    if (s.longest > s.current) tail = `Your longest is ${days(s.longest)}.`;
    if (!s.today) tail = (tail ? tail + ' ' : '') + `A note today makes it ${s.current + 1}.`;
  }
  root.append(el('strong', '', head));
  if (tail) root.append(' ', el('span', 'aside', tail));
}

// Send anyone without an account where they belong. Returns true if sent.
function bounce(r) {
  if (r.status === 401) {
    store.set('rn-back', location.pathname + location.search);
    location.replace('/#sign-in');
    return true;
  }
  if (r.status === 403 && r.data.error === 'no-account') { location.replace(home(true)); return true; }
  return false;
}

// "Couldn't load", once, just before `before` (an element), however many
// times a load fails; ok(before) takes it away again.
function failed(before) {
  let line = before.previousElementSibling;
  if (!line || !line.classList.contains('failed')) {
    line = el('p', 'hint loading failed');
    line.setAttribute('role', 'status');
    before.before(line);
  }
  line.textContent = 'Couldn’t load this just now. Reload to try again.';
}
function ok(before) {
  const line = before.previousElementSibling;
  if (line && line.classList.contains('failed')) line.remove();
}

// A quiet "Loading…" just before `before`, shown only if the answer takes
// longer than `wait` ms (a cold API start). Call the result when it comes.
function loading(before, text = 'Loading…', wait = 300) {
  let line = null;
  const timer = setTimeout(() => {
    line = el('p', 'hint loading', text);
    line.setAttribute('role', 'status');
    before.before(line);
  }, wait);
  return () => { clearTimeout(timer); if (line) line.remove(); };
}

// --- pausing -------------------------------------------------------------------

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// "Paused through Thursday, October 15." or, not yet begun, from and through.
function pauseLine(p) {
  const { from, through } = p.pause;
  const year = Number(p.today.slice(0, 4)), on = (iso) => dayName(iso, year);
  if (from > p.today) return `Paused from ${on(from)} through ${on(through)}.`;
  return `Paused through ${on(through)}. They start again ${on(addDays(through, 1))} at ${clock(p.send_time)}.`;
}

// --- the zip export ------------------------------------------------------------
// Everything, photos and recordings too, built in the background
// (export_job.py): start it, ask every few seconds, then offer the link.

function megabytes(n) {
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  return n < 1e9 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${(n / 1e9).toFixed(1)} GB`;
}

function zipExport(root) {
  const start = $('[data-zip-start]', root), file = $('[data-zip-file]', root), status = $('[data-zip-status]', root);
  let timer;
  const show = (z) => {
    clearTimeout(timer);
    start.hidden = z.status === 'building';
    file.hidden = z.status !== 'ready';
    start.className = z.status === 'ready' ? 'quiet' : 'go';
    start.textContent = z.status === 'ready' ? 'Make a fresh one' : z.status === 'failed' ? 'Try again' : 'Export everything';
    status.hidden = z.status === 'none';
    if (z.status === 'building') {
      status.textContent = 'Putting it together. With lots of photos it can take a few minutes, and you can leave this page and come back.';
      timer = setTimeout(check, 3000);
    } else if (z.status === 'ready') {
      const t = new Date(z.until);
      const until = `${t.toLocaleDateString('en-US', { weekday: 'long' })} at ${t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      const files = z.files ? `, with ${z.files} ${z.files === 1 ? 'photo or recording' : 'photos and recordings'}` : '';
      status.textContent = `Ready: ${megabytes(z.size)}${files}. The download is here until ${until}.`;
    } else if (z.status === 'failed') {
      status.textContent = 'That export didn’t finish.';
    }
  };
  const check = async () => {
    const r = await api('GET', '/api/export/zip');
    if (r.ok) show(r.data);
    else timer = setTimeout(check, 10000);
  };
  start.addEventListener('click', async () => {
    start.disabled = true;
    const r = await api('POST', '/api/export/zip');
    start.disabled = false;
    if (r.status === 202) return show(r.data);
    status.hidden = false;
    status.textContent = 'Couldn’t start the export just now. Try again in a minute.';
  });
  check();
}

const STOPPED = {
  unsubscribed: 'Stopped, because you unsubscribed.',
  bounce: 'Stopped, because an email to this address bounced.',
  complaint: 'Stopped, because an email was marked as spam.',
};

async function busy(form, fn) {
  const button = $('button[type=submit]', form);
  if (button.disabled) return; // an autofilled code can submit twice
  button.disabled = true;
  try { await fn(); } finally { button.disabled = false; }
}

const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  drop(k) { try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ } },
};

// A birthday typed on the front page, waiting for setup to save it after
// sign-in. localStorage rather than the tab's sessionStorage, since the
// emailed link often opens in a new tab. Kept a day at most; dropped once
// setup saves it, or when the sign-in turns out to be an existing account.
const pendingBirthday = {
  get() {
    try {
      const p = JSON.parse(localStorage.getItem('rn-birthday'));
      if (p && /^\d{4}-\d{2}-\d{2}$/.test(p.b) && Date.now() - p.at < 86400000) return p.b;
    } catch (e) { /* none, or storage blocked */ }
    return null;
  },
  set(b) { try { localStorage.setItem('rn-birthday', JSON.stringify({ b, at: Date.now() })); } catch (e) { /* private mode */ } },
  drop() { try { localStorage.removeItem('rn-birthday'); } catch (e) { /* private mode */ } },
};

// Month, day and year as three fields in `root`: quicker than a date
// picker's wheel for a year decades back. value() is 'YYYY-MM-DD', or ''
// until the three make a real date; the API says if it is in the future.
function birthdayFields(root) {
  const month = $('[name=month]', root), day = $('[name=day]', root), year = $('[name=year]', root);
  for (const f of [day, year]) {
    f.addEventListener('input', () => { f.value = f.value.replace(/[^0-9]/g, ''); });
  }
  return {
    first: month,
    value() {
      const m = Number(month.value), d = Number(day.value), y = Number(year.value);
      if (!m || !/^\d{1,2}$/.test(day.value) || !/^\d{4}$/.test(year.value)) return '';
      const t = new Date(y, m - 1, d);
      if (t.getMonth() !== m - 1 || t.getDate() !== d) return '';
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    },
    set(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      month.value = String(m);
      day.value = String(d);
      year.value = String(y);
    },
  };
}

// The number on its own line, and its three parts named.
const COUNT = ['None', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
function explain(sample) {
  const [major, minor, patch] = sample.version.split('.');
  vnum($('#my-v'), sample.version);
  $('#birthday-today').hidden = patch !== '0';
  $('#v-major').textContent = major;
  $('#v-minor').textContent = minor;
  $('#v-patch').textContent = patch;
  const n = Number(major);
  $('#v-major-line').textContent = n === 0 ? 'None finished yet.'
    : `${COUNT[n] || n} of them, done.`;
  $('#v-minor-line').textContent = `Together: ${sample.age}.`;
  const next = $('#v-next');
  next.textContent = '';
  const when = sample.next.days === 1 ? 'tomorrow' : `in ${sample.next.days} days`;
  next.append(el('span', 'mono', sample.next.version), ` ships ${longDate(sample.next.date)}, ${when}.`);
  $('#v-today').textContent = sample.version;
}

const pages = {
  async home() {
    const startForm = $('#start-form'), codeForm = $('#code-form'), birthdayForm = $('#birthday-form');
    const birthday = birthdayFields(birthdayForm);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // One of ask (the birthday), number (it explained, then the email),
    // signin (the email alone, for anyone returning) or check (the code).
    // Each element says in data-show which it belongs to.
    let mode = null, before = 'ask', explained = false, view = 0;
    const show = (m) => {
      ++view; // a pending answer must not replace a later navigation
      if (m !== 'check') before = m;
      mode = m;
      for (const e of document.querySelectorAll('[data-show]')) e.hidden = !e.dataset.show.split(' ').includes(m);
    };

    const showCheck = (email) => {
      $('#sent-to').textContent = email;
      show('check');
      codeForm.code.focus();
    };

    // The number for a birthday, from the API, which keeps the arithmetic.
    const sampleFor = (b) => api('GET', `/api/sample?birthday=${b}&tz=${encodeURIComponent(tz)}`);

    birthdayForm.addEventListener('input', () => quiet(birthdayForm));
    birthdayForm.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(birthdayForm, async () => {
        quiet(birthdayForm);
        const b = birthday.value();
        if (!b) return say(birthdayForm, { error: 'birthday' }, birthday.first);
        const mine = view;
        const r = await sampleFor(b);
        if (mine !== view) return;
        if (!r.ok) return say(birthdayForm, r.data, birthday.first);
        pendingBirthday.set(b);
        explain(r.data);
        explained = true;
        show('number');
        $('#you-are').focus();
      });
    });

    $('#change-birthday').addEventListener('click', () => {
      quiet(startForm);
      show('ask');
      birthday.first.focus();
    });
    $('#to-sign-in').addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(null, '', '/#sign-in');
      show('signin');
      startForm.email.focus();
    });
    $('#to-ask').addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(null, '', '/');
      quiet(startForm);
      show(explained && pendingBirthday.get() ? 'number' : 'ask');
      if (mode === 'ask') birthday.first.focus(); else $('#you-are').focus();
    });

    startForm.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(startForm, async () => {
        quiet(startForm);
        const email = startForm.email.value.trim();
        const r = await api('POST', '/api/auth/start', { email });
        if (r.status !== 202) return say(startForm, r.data);
        store.set('rn-email', email);
        store.set('rn-before', mode);
        showCheck(email);
      });
    });

    // The same address again. Only the newest email's code works.
    const resend = $('#resend'), resent = $('#resent');
    resend.addEventListener('click', async (e) => {
      e.preventDefault();
      if (resend.dataset.busy) return;
      resend.dataset.busy = '1';
      quiet(codeForm);
      resent.hidden = true;
      const r = await api('POST', '/api/auth/start', { email: store.get('rn-email') || $('#sent-to').textContent });
      delete resend.dataset.busy;
      if (r.status !== 202) return say(codeForm, r.data, codeForm.code);
      codeForm.code.value = '';
      resent.textContent = 'Sent again. Use the code in the newest email.';
      resent.hidden = false;
      codeForm.code.focus();
    });

    codeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(codeForm, async () => {
        quiet(codeForm);
        const r = await api('POST', '/api/auth/verify', {
          email: store.get('rn-email') || $('#sent-to').textContent,
          code: codeForm.code.value,
        });
        if (!r.ok) return say(codeForm, r.data);
        store.drop('rn-email');
        store.drop('rn-before');
        signedIn.set();
        location.replace(home(r.data.new));
      });
    });

    $('#again').addEventListener('click', async (e) => {
      e.preventDefault();
      store.drop('rn-email');
      store.drop('rn-before');
      resent.hidden = true;
      // A reload restores the code before the number has been fetched.
      if (before === 'number' && !explained) {
        await start();
        if (mode === 'number') startForm.email.focus();
        else if (mode === 'ask') birthday.first.focus();
        return;
      }
      show(before);
      if (before === 'ask') birthday.first.focus(); else startForm.email.focus();
    });

    // Where this visit starts: the code if an email just went from this
    // tab, the sign-in form if asked for, the number if a birthday is
    // waiting, else the question.
    const start = async () => {
      if (store.get('rn-email')) {
        before = store.get('rn-before') || (location.hash === '#sign-in' ? 'signin' : pendingBirthday.get() ? 'number' : 'ask');
        return showCheck(store.get('rn-email'));
      }
      if (location.hash === '#sign-in') return show('signin');
      const b = pendingBirthday.get();
      if (b) {
        const mine = view;
        const r = await sampleFor(b);
        if (mine !== view) return;
        if (r.ok) {
          birthday.set(b);
          explain(r.data);
          explained = true;
          return show('number');
        }
      }
      show('ask');
    };
    window.addEventListener('hashchange', () => start());

    // Everything starts hidden. Someone signed in here before goes straight
    // on once /api/me agrees, without the form ever showing.
    // If /api/me is slow (a cold start), a quiet line after a moment.
    const waited = signedIn.get() ? loading($('#ask'), 'Opening your notes…', 600) : () => {};
    const started = signedIn.get() ? null : start();
    const me = await api('GET', '/api/me');
    if (me.ok) return location.replace(home(me.data.new));
    waited();
    if (!started) start();
  },

  signin() {
    const form = $('#link-form');
    const token = new URLSearchParams(location.hash.slice(1)).get('t');
    // Keep the token out of history and anything copied from the bar.
    history.replaceState(null, '', location.pathname);
    // A link that can't sign in: say why and offer a new one.
    const spent = (data) => {
      $('button', form).hidden = true;
      const again = el('a', '', 'Send a new link');
      again.href = '/#sign-in';
      form.append(again);
      say(form, data, again);
    };
    if (!token) return spent({ error: 'link-used-or-expired' });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form, async () => {
        quiet(form);
        const r = await api('POST', '/api/auth/verify', { token });
        if (r.data.error === 'network') return say(form, r.data);
        if (!r.ok) return spent(r.data);
        signedIn.set();
        location.replace(home(r.data.new));
      });
    });
  },

  async setup() {
    const me = await api('GET', '/api/me');
    if (!me.ok) return location.replace('/#sign-in');
    if (!me.data.new) return location.replace(home(false));

    const form = $('#setup-form');
    const birthday = birthdayFields(form);
    let place = null, askedVersion = 0;
    sendTimes(form.send_time, '06:00');

    // Sign-up sends today's email at once (web.send_first).
    const firstEmail = () => {
      $('#first-email').textContent =
        `Today’s email comes as soon as you start. After that, every day at ${clock(form.send_time.value)}.`;
    };
    firstEmail();
    // The number the birthday makes, in the picked city's time zone once
    // there is one: in the sentence for a birthday from the front page, or
    // under the fields.
    const known = $('#known');
    const version = async () => {
      const mine = ++askedVersion;
      const b = birthday.value();
      if (!b) { $('#that-makes').hidden = true; return; }
      const tz = place ? place.tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await api('GET', `/api/sample?birthday=${b}&tz=${encodeURIComponent(tz)}`);
      if (mine !== askedVersion) return;
      if (!known.hidden) {
        if (r.ok) vnum($('#known-v'), r.data.version); else notRight();
        return;
      }
      $('#that-makes').hidden = !r.ok;
      if (r.ok) vnum($('#setup-v'), r.data.version);
    };
    const notRight = () => {
      known.hidden = true;
      $('#birthday-stack').hidden = false;
      $('#setup-head').textContent = 'Three things, then you’re set.';
      version();
    };
    const waiting = pendingBirthday.get();
    if (waiting) {
      birthday.set(waiting);
      $('#known-date').textContent = longDate(waiting);
      $('#setup-head').textContent = 'Two more things.';
      $('#birthday-stack').hidden = true;
      known.hidden = false;
      version();
    }
    $('#not-right').addEventListener('click', () => { notRight(); birthday.first.focus(); });

    placePicker($('.place-picker', form), (p) => {
      place = p;
      $('.picked-tz', form).textContent = p.tz;
      $('.picked', form).hidden = false;
      firstEmail();
      version();
    }, () => {
      // The city text changed after a pick: that pick no longer holds.
      place = null;
      $('.picked', form).hidden = true;
      version();
    });
    for (const f of $('.birthday', form).querySelectorAll('select, input')) f.addEventListener('change', version);
    form.addEventListener('input', () => quiet(form));
    form.addEventListener('click', (e) => { if (e.target.closest('.place')) quiet(form); });
    form.send_time.addEventListener('change', firstEmail);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form, async () => {
        quiet(form);
        if (!birthday.value()) { notRight(); return say(form, { error: 'birthday' }, birthday.first); }
        if (!place) return say(form, { error: 'place' }, form.city);
        const r = await api('PUT', '/api/me', { birthday: birthday.value(), place, send_time: form.send_time.value });
        if (!r.ok) {
          if (r.data.error === 'birthday') notRight();
          const field = { birthday: birthday.first, place: form.city, 'send-time': form.send_time }[r.data.error];
          return say(form, r.data, field || $('button[type=submit]', form));
        }
        pendingBirthday.drop();
        location.replace(home(false));
      });
    });
  },

  async settings() {
    // Signing out does not depend on loading the profile successfully.
    $('#signout').addEventListener('click', async () => {
      await api('POST', '/api/auth/signout');
      signedIn.drop();
      location.replace('/#sign-in');
    });
    const account = $('#account');
    const done = loading(account);
    const me = await api('GET', '/api/me');
    done();
    if (bounce(me)) return;
    if (!me.ok) return failed(account);
    if (me.data.new) return location.replace(home(true));
    let p = me.data;

    const fill = () => {
      for (const el of document.querySelectorAll('[data-field]')) {
        const k = el.dataset.field, v = p[k];
        if (v === undefined) continue;
        el.textContent = k === 'birthday' ? longDate(v) : v;
      }
      const stopped = p.status === 'stopped';
      $('#email-status').textContent = stopped
        ? (STOPPED[p.stopped_reason] || 'Stopped.')
        : p.pause ? pauseLine(p) : `Arriving every day at ${clock(p.send_time)}.`;
      $('#restart').hidden = !stopped;
      $('#pause-link').hidden = stopped;
      $('#pause-link').textContent = p.pause ? 'Change the pause' : 'Pause the emails';
      $('#resume').hidden = stopped || !p.pause;
      $('#delete-link').hidden = $('#delete-hint').hidden = false;
      $('#account').hidden = false;
    };
    zipExport($('#your-data'));
    // Each change saves at once; a failure shows in that section's error
    // line, with focus back on `field`.
    const save = async (change, section, field) => {
      quiet(section);
      const r = await api('PUT', '/api/me', change);
      if (r.ok) { p = r.data; fill(); } else say(section, r.data, field);
      return r.ok;
    };

    const sendTime = $('#send-time'), timeSection = sendTime.closest('.section');
    sendTimes(sendTime, p.send_time);
    sendTime.addEventListener('change', async () => {
      $('#send-time-saved').hidden = true;
      const saved = await save({ send_time: sendTime.value }, timeSection, sendTime);
      $('#send-time-saved').hidden = !saved;
      if (!saved) sendTime.value = p.send_time; // back to what is stored
    });

    const picker = $('#city-picker'), changeCity = $('#change-city');
    const closePicker = () => {
      city.reset();
      quiet(picker);
      picker.hidden = true;
      changeCity.hidden = false;
      changeCity.focus();
    };
    changeCity.addEventListener('click', () => {
      picker.hidden = false;
      changeCity.hidden = true;
      $('input', picker).focus();
    });
    const city = placePicker(picker, async (place) => {
      if (await save({ place }, picker, $('input', picker))) closePicker();
    });
    $('#cancel-city').addEventListener('click', closePicker);

    const emails = $('#email-status').closest('.section');
    $('#restart').addEventListener('click', () => save({ status: 'active' }, emails, $('#restart')));
    $('#resume').addEventListener('click', async () => {
      quiet(emails);
      const r = await api('DELETE', '/api/pause');
      if (r.ok) { p = r.data; fill(); } else say(emails, r.data, $('#resume'));
    });
    fill();
  },

  async today() {
    const view = $('#day');
    // The address comes from /api/me, asked alongside, for the line that
    // stands in for an empty day.
    const asked = api('GET', '/api/me');
    let me = null;
    const load = async () => {
      const done = view.hidden ? loading(view) : () => {};
      const r = await api('GET', '/api/today');
      done();
      if (bounce(r)) return;
      if (!r.ok) return failed(view);
      ok(view);
      const t = r.data;
      if (!me) {
        const m = await asked;
        me = m.ok ? m.data : {};
      }
      $('#date').textContent = dayName(t.date);
      vnum($('#v'), t.version, true);
      const dots = $('#dots');
      dots.textContent = '';
      for (let i = 0; i < 24; i++) dots.append(el('span', i < t.dots ? 'on' : ''));
      const next = $('#next');
      next.textContent = '';
      const [, nm, nd] = t.next.date.split('-').map(Number);
      const on = new Date(2000, nm - 1, nd).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      next.append(el('span', 'mono', t.next.version), ` ships ${on}.`);
      $('#paused').hidden = !t.paused_through;
      if (t.paused_through) $('#paused').textContent = `Emails paused through ${dayName(t.paused_through)}. Notes still count.`;
      renderNotes($('#notes'), t.date, t.notes, t.tz, load, t.version);
      emptyLine(t);
      streakLine($('#streak'), t.streak);
      view.hidden = false;
      return t;
    };

    // No notes yet today: one quiet line where they will be. True whether
    // or not today's email has gone, which this page can't tell. Someone
    // with no notes at all yet also hears where the email comes from.
    const emptyLine = (t) => {
      const line = $('#empty');
      line.textContent = '';
      // Paused or stopped, no email comes today; the paused line says so.
      line.hidden = t.notes.length > 0 || !!t.paused_through || me.status === 'stopped' || !me.email;
      if (line.hidden) return;
      line.append('Today’s email, for ', el('span', 'mono', t.version), ', comes to ', el('strong', '', me.email),
        '. Reply to it, with photos or a voice memo if you like, or write here.');
      if (!t.streak.longest && !t.streak.current) {
        line.append(' Add ', el('strong', '', 'notes@yourversionnumber.com'),
          ' to your contacts so the emails don’t land in junk.');
      }
    };

    const t = await load();
    if (t) noteForm($('#note-form'), () => t.date, load).restore();
  },

  async timeline() {
    const list = $('#days'), more = $('#earlier');
    let before = null, thisYear = null;

    const day = (d, today) => {
      const sec = el('section', 'tday');
      const head = el('a', 'tday-head');
      head.href = d.date === today ? '/today/' : `/day/?d=${d.date}`;
      const v = el('span', 'vnum small');
      vnum(v, d.version, true);
      head.append(v, el('span', 'when', (d.date === today ? 'Today, ' : '') + dayName(d.date, thisYear)));
      sec.append(head);
      if (d.weather) {
        sec.append(el('p', 'weather', d.weather));
        $('#weather-credit').hidden = false;
      }
      if (!d.notes.length) {
        const p = el('p', 'hint', 'No notes. ');
        const add = el('a', '', 'Add some');
        add.href = head.href;
        p.append(add);
        sec.append(p);
        return sec;
      }
      for (const n of d.notes) {
        sec.append(noteBody(n));
        if (n.media && n.media.length) sec.append(noteMedia(d.date, n, d.version));
      }
      let count = d.notes.length === 1 ? '1 note' : `${d.notes.length} notes`;
      if (d.notes.every((n) => n.late)) count += ', added later';
      sec.append(el('p', 'count', count));
      return sec;
    };

    // Paused days with no notes read as one row, across pages too.
    let run = null;
    const paused = (d) => {
      if (run && addDays(d.date, 1) === run.oldest.date) {
        run.oldest = d;
        run.days += 1;
      } else {
        run = { newest: d, oldest: d, days: 1, sec: el('section', 'tday') };
        list.append(run.sec);
      }
      const { sec, newest, oldest, days } = run;
      sec.textContent = '';
      const head = el('p', 'tday-head');
      const a = el('span', 'vnum small');
      vnum(a, oldest.version, true);
      head.append(a);
      if (days > 1) {
        const b = el('span', 'vnum small');
        vnum(b, newest.version, true);
        head.append(el('span', 'when', 'to'), b);
      }
      const when = days > 1 ? `${dayName(oldest.date, thisYear)} to ${dayName(newest.date, thisYear)}` : dayName(oldest.date, thisYear);
      sec.append(head, el('p', 'hint', when), el('p', 'hint', `Paused, ${days === 1 ? '1 day' : days + ' days'}. Your streak waited.`));
    };

    const load = async (clicked) => {
      more.disabled = true;
      const done = list.children.length ? () => {} : loading(list);
      const r = await api('GET', '/api/days' + (before ? `?before=${before}` : ''));
      done();
      if (bounce(r)) return;
      more.disabled = false;
      if (!r.ok) { if (clicked) more.focus(); return failed(more); }
      ok(more);
      thisYear = thisYear || Number(r.data.today.slice(0, 4));
      const had = list.children.length, lastRun = run && run.sec;
      for (const d of r.data.days) {
        if (d.paused && !d.notes.length) { paused(d); continue; }
        run = null;
        list.append(day(d, r.data.today));
      }
      before = r.data.before;
      more.hidden = !before;
      // Disabling the button dropped focus. Give it back, or, when the last
      // page took the button away, move on to the first day that page added
      // (or the paused run it extended).
      if (clicked && before) more.focus();
      else if (clicked) {
        const first = list.children[had] || lastRun;
        const link = first && $('a.tday-head', first);
        if (link) link.focus();
        else if (first) { first.tabIndex = -1; first.focus(); }
      }
    };
    more.addEventListener('click', () => load(true));
    await load(false);
  },

  async day() {
    const pick = $('#pick'), view = $('#day'), form = $('#note-form');
    const waited = loading(view);
    const me = await api('GET', '/api/me');
    waited();
    if (bounce(me)) return;
    if (!me.ok) return failed(view);
    if (me.data.new) return location.replace(home(true));
    pick.min = me.data.birthday;
    pick.max = me.data.today;
    const asked = new URLSearchParams(location.search).get('d');
    const yesterday = (() => {
      const [y, m, d] = me.data.today.split('-').map(Number);
      const t = new Date(Date.UTC(y, m - 1, d - 1));
      return t.toISOString().slice(0, 10);
    })();
    let current = asked && asked >= pick.min && asked <= pick.max ? asked : yesterday;
    if (current < pick.min) current = pick.min;
    pick.value = current;

    const thisYear = Number(me.data.today.slice(0, 4));
    // The days either side, by date (their versions aren't known here),
    // from the birthday to today.
    const nearby = () => {
      const prev = addDays(current, -1), next = addDays(current, 1);
      const short = (iso) => {
        const [y, m, d] = iso.split('-').map(Number);
        const opts = { month: 'long', day: 'numeric' };
        if (y !== thisYear) opts.year = 'numeric';
        return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
      };
      const nav = $('#nearby');
      nav.textContent = '';
      const link = (iso, text, rel) => {
        const a = el('a', '', text);
        a.href = iso === me.data.today ? '/today/' : `/day/?d=${iso}`;
        a.rel = rel;
        return a;
      };
      if (prev >= pick.min) nav.append(link(prev, `← ${short(prev)}`, 'prev'));
      if (prev >= pick.min && next <= pick.max) nav.append(' · ');
      if (next <= pick.max) nav.append(link(next, `${short(next)} →`, 'next'));
      nav.hidden = !nav.childNodes.length;
    };
    const draft = noteForm(form, () => current, () => load());
    const load = async (fresh) => {
      const done = view.hidden ? loading(view) : () => {};
      const r = await api('GET', `/api/days/${current}`);
      done();
      if (bounce(r)) return;
      if (!r.ok) { view.hidden = true; return failed(view); }
      ok(view);
      const d = r.data;
      $('#date').textContent = dayName(d.date, thisYear);
      vnum($('#v'), d.version, true);
      $('#weather').hidden = $('#weather-credit').hidden = !d.weather;
      $('#weather').textContent = d.weather || '';
      vnum($('#for-v'), d.version);
      $('#save-v').textContent = d.version;
      renderNotes($('#notes'), d.date, d.notes, d.tz, () => load(), d.version);
      $('#none').hidden = d.notes.length > 0;
      nearby();
      if (fresh) draft.restore();
      view.hidden = false;
    };
    pick.addEventListener('change', () => {
      if (!pick.value || pick.value < pick.min || pick.value > pick.max) return;
      current = pick.value;
      history.replaceState(null, '', `/day/?d=${current}`);
      quiet(form);
      load(true);
    });
    load(true);
  },

  async pause() {
    const form = $('#pause-form'), until = $('.until', form);
    const done = loading($('#current'));
    const me = await api('GET', '/api/me');
    done();
    if (bounce(me)) return;
    if (!me.ok) return failed($('#current'));
    if (me.data.new) return location.replace(home(true));
    let p = me.data;
    const thisYear = Number(p.today.slice(0, 4)), on = (iso) => dayName(iso, thisYear);

    const start = () => (p.pause && p.pause.from <= p.today ? p.pause.from : p.pause_starts);
    const through = () => {
      const v = form.len.value;
      return v === 'until' ? form.through.value : addDays(start(), Number(v) - 1);
    };
    // A typed date outside the range the API takes gets the error a
    // submit would, instead of a preview.
    const outOfRange = (last) => last < form.through.min || last > form.through.max;
    const preview = () => {
      quiet(form);
      until.hidden = form.len.value !== 'until';
      for (const c of form.querySelectorAll('.choice')) c.classList.toggle('on', $('input', c).checked);
      const last = through(), out = $('#preview');
      out.textContent = '';
      if (!last) return;
      if (form.len.value === 'until' && outOfRange(last)) {
        const err = $('.error', form);
        err.textContent = SAY.through;
        err.hidden = false;
        return;
      }
      const from = start() < p.today ? p.today : start();
      const b = (t) => el('strong', '', t);
      out.append('No emails from ', b(on(from)), ' through ', b(on(last)),
        '. They start again on ', b(on(addDays(last, 1))), ` at ${clock(p.send_time)}.`);
    };
    const show = () => {
      if (p.status === 'stopped') {
        $('#current-text').textContent = 'Your emails are stopped, so there’s nothing to pause. Start them again in settings.';
        $('#current').hidden = false;
        $('#resume').hidden = true;
        form.hidden = true;
        return;
      }
      $('#current').hidden = !p.pause;
      if (p.pause) $('#current-text').textContent = pauseLine(p);
      $('#choose').textContent = p.pause ? 'Change it to' : 'Pause for';
      form.through.min = start() < p.today ? p.today : start();
      form.through.max = addDays(start(), 59);
      if (!form.through.value) form.through.value = addDays(start(), 13);
      form.hidden = false;
      preview();
    };

    form.addEventListener('change', preview);
    $('#resume').addEventListener('click', async () => {
      const current = $('#current');
      quiet(current);
      const r = await api('DELETE', '/api/pause');
      if (r.ok) { p = r.data; show(); } else say(current, r.data, $('#resume'));
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form, async () => {
        quiet(form);
        const v = form.len.value;
        const field = v === 'until' ? form.through : form.querySelector('input[name=len]:checked');
        if (v === 'until' && (!form.through.value || outOfRange(form.through.value))) return say(form, { error: 'through' }, field);
        const r = await api('PUT', '/api/pause', v === 'until' ? { through: form.through.value } : { days: Number(v) });
        if (!r.ok) return say(form, r.data, field);
        location.replace('/settings/');
      });
    });
    show();
  },

  async delete() {
    const me = await api('GET', '/api/me');
    if (bounce(me)) return;
    if (!me.ok) return failed($('#ask-delete'));
    if (me.data.new) return location.replace(home(true));
    const ask = $('#code-ask'), confirm = $('#code-confirm');
    $('#to').textContent = me.data.email;
    $('#ask-delete').hidden = false;
    zipExport($('#keep-copy'));

    ask.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(ask, async () => {
        quiet(ask);
        const r = await api('POST', '/api/me/delete-code');
        if (r.status !== 202) return say(ask, r.data);
        ask.hidden = true;
        confirm.hidden = false;
        confirm.code.focus();
      });
    });
    confirm.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(confirm, async () => {
        quiet(confirm);
        const r = await api('DELETE', '/api/me', { code: confirm.code.value });
        if (!r.ok) {
          if (['too-many-tries', 'code-expired', 'code-used'].includes(r.data.error)) {
            ask.hidden = false;
            confirm.hidden = true;
            confirm.code.value = '';
            return say(ask, r.data);
          }
          return say(confirm, r.data);
        }
        $('#ask-delete').hidden = true;
        $('#deleted').hidden = false;
        for (const a of document.querySelectorAll('.bar a:not(.brand)')) a.hidden = true;
      });
    });
  },

  // One tag's days, newest first, with the notes that carry it (?t=), or
  // every tag, most used first.
  async tag() {
    const list = $('#tagged'), title = $('#tag-title'), lede = $('#tag-lede');
    const tag = new URLSearchParams(location.search).get('t');
    const done = loading(list);
    const r = await api('GET', tag ? `/api/tags/${encodeURIComponent(tag)}` : '/api/tags');
    done();
    if (bounce(r)) return;
    if (!r.ok) {
      if (r.status === 404) return location.replace('/tag/');
      return failed(list);
    }
    const count = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
    if (!tag) {
      title.textContent = 'Tags';
      lede.textContent = r.data.tags.length
        ? 'Every hashtag in your notes. Write one, like #cabin, in an email or here, and the note has that tag.'
        : 'No tags yet. Write a hashtag, like #cabin, in a note or a reply, and it shows here.';
      const ul = el('ul', 'tags');
      for (const t of r.data.tags) {
        const li = el('li');
        const a = el('a', 'tag', `#${t.tag}`);
        a.href = `/tag/?t=${encodeURIComponent(t.tag)}`;
        li.append(a, el('span', 'hint', ` ${count(t.days, 'day', 'days')}`));
        ul.append(li);
      }
      list.append(ul);
      return;
    }
    $('#every-tag').hidden = false;
    document.title = `#${r.data.tag}: Release Notes`;
    title.textContent = `#${r.data.tag}`;
    lede.textContent = r.data.days.length ? count(r.data.days.length, 'day', 'days') : 'No notes have this tag now.';
    const thisYear = Number(r.data.today.slice(0, 4));
    for (const d of r.data.days) {
      const sec = el('section', 'tday');
      const head = el('a', 'tday-head');
      head.href = d.date === r.data.today ? '/today/' : `/day/?d=${d.date}`;
      const v = el('span', 'vnum small');
      vnum(v, d.version, true);
      head.append(v, el('span', 'when', dayName(d.date, thisYear)));
      sec.append(head);
      for (const n of d.notes) {
        sec.append(noteBody(n));
        if (n.media && n.media.length) sec.append(noteMedia(d.date, n, d.version));
        sec.append(el('p', 'count', noteMeta(n, r.data.tz)));
      }
      list.append(sec);
    }
  },

  unsubscribe() {
    const form = $('#stop-form');
    const token = new URLSearchParams(location.hash.slice(1)).get('t');
    history.replaceState(null, '', location.pathname);
    if (!token) {
      $('button', form).hidden = true;
      say(form, { error: 'token' });
      return;
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form, async () => {
        quiet(form);
        const r = await api('POST', '/api/unsubscribe?t=' + encodeURIComponent(token));
        if (!r.ok) return say(form, r.data);
        $('#ask-stop').hidden = true;
        $('#stopped').hidden = false;
      });
    });
  },
};

const page = pages[document.body.dataset.page];
if (page) page();

// Page counts for Tinylytics site 3816 (Jamie, 2026-10-08), sent from here
// so no remote script runs (Tinylytics' own route for strict CSPs). Only the
// path goes: query strings carry sign-in tokens and dates. No cookies, and
// another site's referrer goes as its origin only. ?tiny_ignore=true stops
// counting in this browser; ?tiny_ignore=false starts it again.
(function count() {
  if (location.hostname !== 'notes.yourversionnumber.com') return;
  try {
    const ignore = new URLSearchParams(location.search).get('tiny_ignore');
    if (ignore === 'true') localStorage.setItem('tiny_ignore', '1');
    if (ignore === 'false') localStorage.removeItem('tiny_ignore');
    if (localStorage.getItem('tiny_ignore')) return;
  } catch (e) { /* storage blocked: count anyway */ }
  let referrer = '';
  try {
    const r = new URL(document.referrer);
    if (r.origin !== location.origin) referrer = r.origin + '/';
  } catch (e) { /* no referrer */ }
  const q = new URLSearchParams({ url: location.origin + location.pathname, path: location.pathname, referrer });
  fetch('https://tinylytics.app/collector/sGuEB7xpDqmsxbCyVK-B?' + q,
    { method: 'POST', mode: 'no-cors', credentials: 'omit', keepalive: true }).catch(() => {});
})();
