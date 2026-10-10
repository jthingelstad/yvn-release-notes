// What the pages keep in this browser. Every read and write is guarded:
// storage throws in private modes and when site data is blocked, and the
// pages work without it.

function guarded(area: () => Storage) {
  return {
    get(k: string): string | null {
      try {
        return area().getItem(k);
      } catch {
        return null;
      }
    },
    set(k: string, v: string) {
      try {
        area().setItem(k, v);
      } catch {
        /* private mode */
      }
    },
    drop(k: string) {
      try {
        area().removeItem(k);
      } catch {
        /* private mode */
      }
    }
  };
}

// This tab only: drafts, the address a code went to, where to come back to.
export const store = guarded(() => sessionStorage);
const local = guarded(() => localStorage);

// A hint, kept in this browser, that it was signed in last time. The
// session cookie is HttpOnly, so the home page cannot see it; with the hint
// it waits for /api/me instead of showing the sign-in form first.
export const signedIn = {
  get: () => local.get('rn-in') === '1',
  set: () => local.set('rn-in', '1'),
  drop: () => local.drop('rn-in')
};

// A birthday typed on the front page, waiting for setup to save it after
// sign-in. localStorage rather than the tab's sessionStorage, since the
// emailed link often opens in a new tab. Kept a day at most; dropped once
// setup saves it, or when the sign-in turns out to be an existing account.
export const pendingBirthday = {
  get(): string | null {
    try {
      const p = JSON.parse(local.get('rn-birthday') || 'null');
      if (p && /^\d{4}-\d{2}-\d{2}$/.test(p.b) && Date.now() - p.at < 86400000) return p.b;
    } catch {
      /* none, or not ours */
    }
    return null;
  },
  set: (b: string) => local.set('rn-birthday', JSON.stringify({ b, at: Date.now() })),
  drop: () => local.drop('rn-birthday')
};

// Where a signed-in person lands: back where they were signed out, if
// that was in this tab, or Today.
export function home(isNew: boolean): string {
  if (isNew) return '/setup/';
  pendingBirthday.drop();
  const back = store.get('rn-back');
  store.drop('rn-back');
  return back && /^\/[a-z]/.test(back) ? back : '/today/';
}
