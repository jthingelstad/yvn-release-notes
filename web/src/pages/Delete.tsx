// Deleting the account: the export offered first, then a code mailed to
// the address to confirm.
import { useRef, useState, type FormEvent } from 'react';
import {
  AppLink,
  Bar,
  ErrorLine,
  Failed,
  Loading,
  useBusy,
  useFocusLater,
  useProblem,
  useTitle
} from '../components/common.tsx';
import { ZipExport } from '../components/fields.tsx';
import { api } from '../lib/api.ts';
import { useMe } from '../lib/nav.ts';
import { signedIn } from '../lib/storage.ts';

const START_OVER = ['too-many-tries', 'code-expired', 'code-used'];

export function Delete() {
  useTitle('Delete account');
  const me = useMe();
  const [step, setStep] = useState<'ask' | 'confirm' | 'deleted'>('ask');
  const [askBusy, runAsk] = useBusy();
  const [confirmBusy, runConfirm] = useBusy();
  const askProblem = useProblem();
  const confirmProblem = useProblem();
  const focusLater = useFocusLater();
  const askForm = useRef<HTMLFormElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const p = me.data && !me.data.new ? me.data : null;

  const ask = (e: FormEvent) => {
    e.preventDefault();
    runAsk(async () => {
      askProblem.clear();
      const r = await api('POST', '/api/me/delete-code');
      if (r.status !== 202) return askProblem.show(r.data, null, askForm.current);
      setStep('confirm');
      focusLater(() => code.current);
    });
  };

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    runConfirm(async () => {
      confirmProblem.clear();
      const r = await api('DELETE', '/api/me', { code: code.current!.value });
      if (!r.ok) {
        if (START_OVER.includes(r.data.error || '')) {
          setStep('ask');
          code.current!.value = '';
          return askProblem.show(r.data, null, askForm.current);
        }
        return confirmProblem.show(r.data, code.current);
      }
      // Nothing fetched again here: the session is gone with the account.
      signedIn.drop();
      setStep('deleted');
    });
  };

  return (
    <>
      <Bar nav={step !== 'deleted'} />

      {step !== 'deleted' && me.isPending && <Loading />}
      {step !== 'deleted' && me.isError && <Failed />}
      {p && step !== 'deleted' && (
        <section id="ask-delete">
          <h1>Delete your account?</h1>
          <p className="lede">
            This deletes every note, its photos and recordings, the original emails behind them, and your settings. It
            can’t be undone.
          </p>

          <div className="section wide" id="keep-copy">
            <h2 className="big">Keep a copy first</h2>
            <p className="hint">
              Every note you’ve kept, with its day and version, every photo and recording, and your settings, in one
              zip.
            </p>
            <ZipExport />
            <p className="hint">
              Or the words alone:{' '}
              <a href="/api/export?format=md" download>
                Markdown
              </a>{' '}
              or{' '}
              <a href="/api/export?format=json" download>
                JSON
              </a>
              .
            </p>
          </div>

          <form
            ref={askForm}
            id="code-ask"
            className="stack tight spaced-lg"
            noValidate
            hidden={step !== 'ask'}
            onSubmit={ask}
          >
            <p className="hint">
              To make sure it’s you, we’ll email a code to <strong id="to">{p.email}</strong>.
            </p>
            <div className="row">
              <button className="quiet danger" type="submit" disabled={askBusy}>
                Email me a code to delete my account
              </button>
              <AppLink href="/settings/">Not now</AppLink>
            </div>
            <ErrorLine line={askProblem.line} />
          </form>

          <form
            id="code-confirm"
            className="spaced-lg"
            noValidate
            hidden={step !== 'confirm'}
            onSubmit={confirm}
            onInput={confirmProblem.clear}
          >
            <label>
              The six digits from the email
              <input
                ref={code}
                className="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
              />
            </label>
            <div className="row">
              <button className="go danger" type="submit" disabled={confirmBusy}>
                Delete everything
              </button>
              <AppLink href="/settings/">Keep my account</AppLink>
            </div>
            <ErrorLine line={confirmProblem.line} />
          </form>
        </section>
      )}

      <section id="deleted" hidden={step !== 'deleted'}>
        <h1 className="top">Deleted.</h1>
        <p className="lede">
          Your notes, settings and reply addresses are gone. The original emails sit in a backup for 30 days, then
          they’re gone too. Thank you for keeping release notes.
        </p>
        <p className="hint spaced">
          <AppLink href="/">Start again</AppLink>
        </p>
      </section>
    </>
  );
}
