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
  return { status: res.status, ok: res.ok, data };
}

// Cobalt digits, tangerine dots.
function vnum(el, v) {
  el.textContent = '';
  v.split('.').forEach((part, i) => {
    if (i) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '.';
      el.append(dot);
    }
    el.append(part);
  });
  el.setAttribute('aria-label', 'Version ' + v);
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
  birthday: 'Pick your birthday: a real date, not in the future.',
  place: 'Pick your city from the list.',
  'send-time': 'Pick a time for your email.',
  'places-failed': 'The city search isn’t answering. Try again in a minute.',
  token: 'This link isn’t one we sent. Sign in to manage your emails.',
  date: 'Pick a day between your birthday and today.',
  text: 'Write something first.',
  'too-long': 'That’s longer than one note can hold. Split it in two.',
  note: 'That note isn’t here any more. Reload the page.',
  days: 'Pick how long to pause.',
  through: 'Pick a day within the next 60.',
  stopped: 'Your emails are stopped. Start them again in settings first.',
  'delete-failed': 'Couldn’t delete everything just now. Nothing is lost; try again in a minute.',
};

function say(form, data) {
  const el = $('.error', form);
  let text = SAY[data.error] || 'Something went wrong. Try again.';
  if (data.error === 'wrong-code' && data.tries_left !== undefined) {
    text += data.tries_left === 1 ? ' One try left.' : ` ${data.tries_left} tries left.`;
  }
  el.textContent = text;
  el.hidden = false;
}

function quiet(form) {
  $('.error', form).hidden = true;
}

// Where a signed-in person lands.
function home(isNew) {
  return isNew ? '/setup/' : '/today/';
}

// Every quarter hour, as the sender allows.
function sendTimes(select, value) {
  for (let m = 0; m < 24 * 60; m += 15) {
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    select.add(new Option(clock(v), v, false, v === value));
  }
  select.value = value;
}

// The time now in a zone, as "HH:MM", and that zone's date.
function zoneNow(tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { hhmm: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

// A city search over /api/places. Calls onPick(place) with the choice.
function placePicker(root, onPick) {
  const input = $('input[type=search]', root), list = $('.places', root);
  let timer = null, asked = 0;

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
      b.addEventListener('click', () => { show(places, p); onPick(p); });
      list.append(b);
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.textContent = ''; return; }
    timer = setTimeout(async () => {
      const mine = ++asked;
      const r = await api('GET', '/api/places?q=' + encodeURIComponent(q));
      if (mine !== asked) return; // a later search has gone out
      if (!r.ok) { list.textContent = SAY[r.data.error] || SAY['places-failed']; return; }
      if (!r.data.places.length) { list.textContent = 'No city by that name. Try the nearest larger one.'; return; }
      show(r.data.places, null);
    }, 300);
  });
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
  return n.text || 'Attachments only. They are in the original email.';
}

// A note's text as a paragraph, with bare web addresses as links (the same
// rule as the email's, compose.linked). Built from text nodes, never HTML.
const URL_RE = /https?:\/\/[^\s<>"]+/gi;
function noteBody(n, cls = 'text') {
  const p = el('p', cls);
  const text = noteText(n);
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?'")\]}]+$/, '');
    p.append(text.slice(last, m.index));
    const a = el('a', '', url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''));
    a.href = url;
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    p.append(a);
    last = m.index + url.length;
  }
  p.append(text.slice(last));
  return p;
}

function noteMeta(n, tz) {
  const when = n.at ? (n.late ? `${zoneShortDate(n.at, tz)}, ${zoneTime(n.at, tz)}` : zoneTime(n.at, tz)) : '';
  const parts = [when, n.source === 'web' ? 'on the web' : 'by email'];
  if (n.attachments) parts.push(n.attachments === 1 ? '1 attachment in the email' : `${n.attachments} attachments in the email`);
  if (n.edited_at) parts.push('edited');
  return parts.filter(Boolean).join(' · ');
}

// A day's notes, each with Edit and Delete. onChange() runs after either.
function renderNotes(root, day, notes, tz, onChange) {
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
      row.append(save, button('Cancel', 'quiet', () => renderNotes(root, day, notes, tz, onChange)));
      const err = el('p', 'error');
      err.setAttribute('role', 'alert');
      err.hidden = true;
      form.append(area, row, err);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        busy(form, async () => {
          quiet(form);
          const r = await api('PUT', path, { text: area.value });
          if (!r.ok) return say(form, r.data);
          onChange();
        });
      });
      text.replaceWith(form);
      actions.hidden = true;
      area.focus();
    };

    const ask = () => {
      actions.textContent = '';
      const q = el('span', 'confirm', n.source === 'web' ? 'Delete this note?' : 'Delete this note and the email it came in?');
      const yes = button('Delete', 'quiet danger', async () => {
        yes.disabled = true;
        const r = await api('DELETE', path);
        if (!r.ok && r.status !== 404) {
          yes.disabled = false;
          q.textContent = SAY[r.data.error] || 'That didn’t work. Try again.';
          return;
        }
        onChange();
      });
      actions.append(q, yes, button('Keep it', 'quiet', () => renderNotes(root, day, notes, tz, onChange)));
    };

    actions.append(button('Edit', 'quiet', edit), button('Delete', 'quiet', ask));
    item.append(meta, text, actions);
    root.append(item);
  }
}

// The form that adds a note to a day. onAdded() runs after.
function noteForm(form, getDay, onAdded) {
  form.text.addEventListener('input', () => quiet(form));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form, async () => {
      quiet(form);
      if (!form.text.value.trim()) return say(form, { error: 'text' });
      const r = await api('POST', `/api/days/${getDay()}/notes`, { text: form.text.value });
      if (!r.ok) return say(form, r.data);
      form.text.value = '';
      onAdded();
    });
  });
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
  if (r.status === 401) { location.replace('/'); return true; }
  if (r.status === 403 && r.data.error === 'no-account') { location.replace(home(true)); return true; }
  return false;
}

function failed(root) {
  root.textContent = 'Couldn’t load this just now. Reload to try again.';
}

// --- pausing -------------------------------------------------------------------

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// "Paused through Thursday, October 15." or, not yet begun, from and through.
function pauseLine(p) {
  const { from, through } = p.pause;
  if (from > p.today) return `Paused from ${dayName(from)} through ${dayName(through)}.`;
  return `Paused through ${dayName(through)}. They start again ${dayName(addDays(through, 1))} at ${clock(p.send_time)}.`;
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

const pages = {
  async home() {
    const ask = $('#ask'), check = $('#check');
    const startForm = $('#start-form'), codeForm = $('#code-form');

    const showCheck = (email) => {
      $('#sent-to').textContent = email;
      ask.hidden = true;
      $('#home-foot').hidden = true;
      check.hidden = false;
      codeForm.code.focus();
    };

    startForm.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(startForm, async () => {
        quiet(startForm);
        const email = startForm.email.value.trim();
        const r = await api('POST', '/api/auth/start', { email });
        if (r.status !== 202) return say(startForm, r.data);
        store.set('rn-email', email);
        showCheck(email);
      });
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
        location.replace(home(r.data.new));
      });
    });

    $('#again').addEventListener('click', (e) => {
      e.preventDefault();
      store.drop('rn-email');
      check.hidden = true;
      ask.hidden = false;
      $('#home-foot').hidden = false;
      startForm.email.focus();
    });

    const [me, sample] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/sample')]);
    if (me.ok) return location.replace(home(me.data.new));
    if (store.get('rn-email')) showCheck(store.get('rn-email'));
    if (sample.ok) {
      vnum($('#sample-v'), sample.data.version);
      $('#sample-who').textContent = `Someone born ${longDate(sample.data.birthday)}, today.`;
    }
  },

  signin() {
    const form = $('#link-form');
    const token = new URLSearchParams(location.hash.slice(1)).get('t');
    // Keep the token out of history and anything copied from the bar.
    history.replaceState(null, '', location.pathname);
    if (!token) {
      say(form, { error: 'link-used-or-expired' });
      $('button', form).hidden = true;
      return;
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form, async () => {
        quiet(form);
        const r = await api('POST', '/api/auth/verify', { token });
        if (!r.ok) {
          say(form, r.data);
          $('button', form).hidden = true;
          const again = document.createElement('a');
          again.href = '/';
          again.textContent = 'Send a new link';
          form.append(again);
          return;
        }
        location.replace(home(r.data.new));
      });
    });
  },

  async setup() {
    const me = await api('GET', '/api/me');
    if (!me.ok) return location.replace('/');
    if (!me.data.new) return location.replace(home(false));

    const form = $('#setup-form');
    let place = null;
    sendTimes(form.send_time, '06:00');
    form.birthday.max = zoneNow(Intl.DateTimeFormat().resolvedOptions().timeZone).date;

    const firstEmail = () => {
      const at = clock(form.send_time.value);
      if (!place) { $('#first-email').textContent = ''; return; }
      const when = zoneNow(place.tz).hhmm < form.send_time.value ? 'today' : 'tomorrow';
      $('#first-email').textContent = `Your first email arrives ${when} at ${at}.`;
    };
    const version = async () => {
      if (!form.birthday.value) { $('#that-makes').hidden = true; return; }
      const tz = place ? place.tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await api('GET', `/api/sample?birthday=${form.birthday.value}&tz=${encodeURIComponent(tz)}`);
      $('#that-makes').hidden = !r.ok;
      if (r.ok) vnum($('#setup-v'), r.data.version);
    };

    placePicker($('.place-picker', form), (p) => {
      place = p;
      $('.picked-tz', form).textContent = p.tz;
      $('.picked', form).hidden = false;
      firstEmail();
      version();
    });
    form.birthday.addEventListener('change', version);
    form.addEventListener('input', () => quiet(form));
    form.addEventListener('click', (e) => { if (e.target.closest('.place')) quiet(form); });
    form.send_time.addEventListener('change', firstEmail);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form, async () => {
        quiet(form);
        if (!form.birthday.value) return say(form, { error: 'birthday' });
        if (!place) return say(form, { error: 'place' });
        const r = await api('PUT', '/api/me', { birthday: form.birthday.value, place, send_time: form.send_time.value });
        if (!r.ok) return say(form, r.data);
        location.replace(home(false));
      });
    });
  },

  async settings() {
    const me = await api('GET', '/api/me');
    if (!me.ok) return location.replace('/');
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
        : p.pause ? pauseLine(p) : `Arriving every morning at ${clock(p.send_time)}.`;
      $('#restart').hidden = !stopped;
      $('#pause-link').hidden = stopped;
      $('#pause-link').textContent = p.pause ? 'Change the pause' : 'Pause the emails';
      $('#resume').hidden = stopped || !p.pause;
      $('#delete-link').hidden = $('#delete-hint').hidden = false;
      $('#account').hidden = false;
    };
    const save = async (change) => {
      const r = await api('PUT', '/api/me', change);
      if (r.ok) { p = r.data; fill(); }
      return r.ok;
    };

    const sendTime = $('#send-time');
    sendTimes(sendTime, p.send_time);
    sendTime.addEventListener('change', async () => {
      $('#send-time-saved').hidden = true;
      $('#send-time-saved').hidden = !(await save({ send_time: sendTime.value }));
    });

    $('#change-city').addEventListener('click', () => {
      $('#city-picker').hidden = false;
      $('#change-city').hidden = true;
      $('#city-picker input').focus();
    });
    placePicker($('#city-picker'), async (place) => {
      if (await save({ place })) {
        $('#city-picker').hidden = true;
        $('#change-city').hidden = false;
      }
    });

    $('#restart').addEventListener('click', () => save({ status: 'active' }));
    $('#resume').addEventListener('click', async () => {
      const r = await api('DELETE', '/api/pause');
      if (r.ok) { p = r.data; fill(); }
    });
    $('#signout').addEventListener('click', async () => {
      await api('POST', '/api/auth/signout');
      location.replace('/');
    });
    fill();
  },

  async today() {
    const view = $('#day');
    const load = async () => {
      const r = await api('GET', '/api/today');
      if (bounce(r)) return;
      if (!r.ok) return failed(view.parentNode.appendChild(el('p', 'hint spaced')));
      const t = r.data;
      $('#date').textContent = dayName(t.date);
      vnum($('#v'), t.version);
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
      renderNotes($('#notes'), t.date, t.notes, t.tz, load);
      streakLine($('#streak'), t.streak);
      view.hidden = false;
      return t;
    };
    const t = await load();
    if (t) noteForm($('#note-form'), () => t.date, load);
  },

  async timeline() {
    const list = $('#days'), more = $('#earlier');
    let before = null, thisYear = null;

    const day = (d, today) => {
      const sec = el('section', 'tday');
      const head = el('a', 'tday-head');
      head.href = d.date === today ? '/today/' : `/day/?d=${d.date}`;
      const v = el('span', 'vnum small');
      vnum(v, d.version);
      head.append(v, el('span', 'when', (d.date === today ? 'Today, ' : '') + dayName(d.date, thisYear)));
      sec.append(head);
      if (!d.notes.length) {
        const p = el('p', 'hint', 'No notes. ');
        const add = el('a', '', 'Add some');
        add.href = head.href;
        p.append(add);
        sec.append(p);
        return sec;
      }
      for (const n of d.notes) sec.append(noteBody(n));
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
      vnum(a, oldest.version);
      head.append(a);
      if (days > 1) {
        const b = el('span', 'vnum small');
        vnum(b, newest.version);
        head.append(el('span', 'when', 'to'), b);
      }
      const when = days > 1 ? `${dayName(oldest.date, thisYear)} to ${dayName(newest.date, thisYear)}` : dayName(oldest.date, thisYear);
      sec.append(head, el('p', 'hint', when), el('p', 'hint', `Paused, ${days === 1 ? '1 day' : days + ' days'}. Your streak waited.`));
    };

    const load = async () => {
      more.disabled = true;
      const r = await api('GET', '/api/days' + (before ? `?before=${before}` : ''));
      if (bounce(r)) return;
      more.disabled = false;
      if (!r.ok) return failed(list.appendChild(el('p', 'hint')));
      thisYear = thisYear || Number(r.data.today.slice(0, 4));
      for (const d of r.data.days) {
        if (d.paused && !d.notes.length) { paused(d); continue; }
        run = null;
        list.append(day(d, r.data.today));
      }
      before = r.data.before;
      more.hidden = !before;
    };
    more.addEventListener('click', load);
    await load();
  },

  async day() {
    const me = await api('GET', '/api/me');
    if (bounce(me)) return;
    if (me.data.new) return location.replace(home(true));
    const pick = $('#pick'), view = $('#day'), form = $('#note-form');
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

    const load = async () => {
      const r = await api('GET', `/api/days/${current}`);
      if (bounce(r)) return;
      if (!r.ok) { view.hidden = true; return; }
      const d = r.data;
      $('#date').textContent = dayName(d.date, Number(me.data.today.slice(0, 4)));
      vnum($('#v'), d.version);
      vnum($('#for-v'), d.version);
      $('#save-v').textContent = d.version;
      renderNotes($('#notes'), d.date, d.notes, d.tz, load);
      $('#none').hidden = d.notes.length > 0;
      view.hidden = false;
    };
    pick.addEventListener('change', () => {
      if (!pick.value || pick.value < pick.min || pick.value > pick.max) return;
      current = pick.value;
      history.replaceState(null, '', `/day/?d=${current}`);
      quiet(form);
      load();
    });
    noteForm(form, () => current, load);
    load();
  },

  async pause() {
    const me = await api('GET', '/api/me');
    if (bounce(me)) return;
    if (me.data.new) return location.replace(home(true));
    let p = me.data;
    const form = $('#pause-form'), until = $('.until', form);

    const start = () => (p.pause && p.pause.from <= p.today ? p.pause.from : p.pause_starts);
    const through = () => {
      const v = form.len.value;
      return v === 'until' ? form.through.value : addDays(start(), Number(v) - 1);
    };
    const preview = () => {
      quiet(form);
      until.hidden = form.len.value !== 'until';
      for (const c of form.querySelectorAll('.choice')) c.classList.toggle('on', $('input', c).checked);
      const last = through(), out = $('#preview');
      out.textContent = '';
      if (!last) return;
      const from = start() < p.today ? p.today : start();
      const b = (t) => el('strong', '', t);
      out.append('No emails from ', b(dayName(from)), ' through ', b(dayName(last)),
        '. They start again on ', b(dayName(addDays(last, 1))), ` at ${clock(p.send_time)}.`);
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
      const r = await api('DELETE', '/api/pause');
      if (r.ok) { p = r.data; show(); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form, async () => {
        quiet(form);
        const v = form.len.value;
        if (v === 'until' && !form.through.value) return say(form, { error: 'through' });
        const r = await api('PUT', '/api/pause', v === 'until' ? { through: form.through.value } : { days: Number(v) });
        if (!r.ok) return say(form, r.data);
        location.replace('/settings/');
      });
    });
    show();
  },

  async delete() {
    const me = await api('GET', '/api/me');
    if (bounce(me)) return;
    if (me.data.new) return location.replace(home(true));
    const ask = $('#code-ask'), confirm = $('#code-confirm');
    $('#to').textContent = me.data.email;
    $('#ask-delete').hidden = false;

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

  unsubscribe() {
    const form = $('#stop-form');
    const token = new URLSearchParams(location.hash.slice(1)).get('t');
    history.replaceState(null, '', location.pathname);
    if (!token) {
      say(form, { error: 'token' });
      $('button', form).hidden = true;
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
