// The email's unsubscribe link (#t=, the reply token): one tap stops the
// daily emails, without signing in.
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { AppLink, Bar, ErrorLine, useBusy, useProblem, useTitle } from '../components/common.tsx';
import { api } from '../lib/api.ts';

export function Unsubscribe() {
  useTitle('Unsubscribe');
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('t'));
  const [stopped, setStopped] = useState(false);
  const [busy, run] = useBusy();
  const problem = useProblem();

  useEffect(() => {
    // Keep the token out of history and anything copied from the bar.
    navigate({ to: '/unsubscribe/', replace: true });
    if (!token) problem.show({ error: 'token' });
    // Once, as the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      problem.clear();
      const r = await api('POST', '/api/unsubscribe?t=' + encodeURIComponent(token || ''));
      if (!r.ok) return problem.show(r.data);
      setStopped(true);
    });
  };

  return (
    <>
      <Bar nav={false} />
      <section id="ask-stop" hidden={stopped}>
        <h1 className="top">Stop the daily emails?</h1>
        <p className="lede">
          Your notes stay here. You can sign in any time to read them, export them or start the emails again.
        </p>
        <form id="stop-form" onSubmit={submit}>
          <button className="go" type="submit" hidden={!token} disabled={busy}>
            Stop my emails
          </button>
          <ErrorLine line={problem.line} />
        </form>
      </section>

      <section id="stopped" hidden={!stopped}>
        <h1 className="top">Stopped.</h1>
        <p className="lede">
          No more daily emails. Your notes are still here: <AppLink href="/#sign-in">sign in</AppLink> to read or export
          them, or to start the emails again.
        </p>
      </section>
    </>
  );
}
