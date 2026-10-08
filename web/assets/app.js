// Release Notes: one script for every page, chosen by <body data-page>.
// Vanilla, no build step, nothing remote. The API is same-origin at /api.
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
  return isNew ? '/settings/' : '/settings/';
}

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

  async settings() {
    const me = await api('GET', '/api/me');
    if (!me.ok) return location.replace('/');
    const p = me.data;
    const fill = (root) => {
      for (const el of root.querySelectorAll('[data-field]')) {
        const k = el.dataset.field, v = p[k];
        if (v === undefined) continue;
        if (k === 'version') vnum(el, v);
        else if (k === 'birthday') el.textContent = longDate(v);
        else if (k === 'send_time') el.textContent = clock(v);
        else el.textContent = v;
      }
      root.hidden = false;
    };
    fill(p.new ? $('#newcomer') : $('#account'));

    $('#signout').addEventListener('click', async () => {
      await api('POST', '/api/auth/signout');
      location.replace('/');
    });
  },
};

const page = pages[document.body.dataset.page];
if (page) page();
