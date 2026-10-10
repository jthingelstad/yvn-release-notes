// The emailed link lands here. A button, not an automatic sign-in: mail
// scanners open links, and opening this page must not use up the link.
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AppLink, Bar, ErrorLine, useBusy, useFocusLater, useProblem, useTitle } from '../components/common.tsx';
import { api } from '../lib/api.ts';
import { useSignedInAs } from '../lib/nav.ts';
import type { Problem } from '../lib/say.ts';
import { home, signedIn } from '../lib/storage.ts';

export function SignIn() {
  useTitle('Sign in');
  const navigate = useNavigate();
  const signIn = useSignedInAs();
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('t'));
  const [isSpent, setSpent] = useState(false);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const focusLater = useFocusLater();
  const again = useRef<HTMLAnchorElement>(null);

  // A link that can't sign in: say why and offer a new one.
  const spent = (p: Problem) => {
    setSpent(true);
    problem.show(p);
    focusLater(() => again.current);
  };

  useEffect(() => {
    // Keep the token out of history and anything copied from the bar.
    navigate({ to: '/signin/', replace: true });
    if (!token) spent({ error: 'link-used-or-expired' });
    // Once, as the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      problem.clear();
      const r = await api<{ new: boolean }>('POST', '/api/auth/verify', { token });
      if (r.data.error === 'network') return problem.show(r.data);
      if (!r.ok) return spent(r.data);
      signedIn.set();
      signIn(home(r.data.new));
    });
  };

  return (
    <>
      <Bar nav={false} />
      <h1 className="top">Sign in to Release Notes.</h1>
      <p className="lede">One tap finishes signing in on this device.</p>
      <form id="link-form" onSubmit={submit}>
        <button className="go" type="submit" hidden={isSpent} disabled={busy}>
          Sign in
        </button>
        <ErrorLine line={problem.line} />
        {isSpent && (
          <AppLink href="/#sign-in" ref={again}>
            Send a new link
          </AppLink>
        )}
      </form>
    </>
  );
}
