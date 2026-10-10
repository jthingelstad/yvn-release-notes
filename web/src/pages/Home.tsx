// The front page asks for a birthday first and shows the number it makes,
// then asks for an email. The birthday waits in this browser
// (pendingBirthday) and setup saves it after sign-in. "Sign in" skips
// straight to the email for anyone returning.
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BirthdayFields, emptyMdy, mdyOf, mdyValue, type Mdy } from '../components/fields.tsx';
import {
  Bar,
  Digits,
  ErrorLine,
  Loading,
  useBusy,
  useFocusLater,
  useProblem,
  useTitle
} from '../components/common.tsx';
import { api } from '../lib/api.ts';
import { browserZone, longDate } from '../lib/format.ts';
import { useGo, useSignedInAs } from '../lib/nav.ts';
import { home, pendingBirthday, signedIn, store } from '../lib/storage.ts';
import type { Sample } from '../lib/types.ts';

// One of ask (the birthday), number (it explained, then the email), signin
// (the email alone, for anyone returning) or check (the code). Each part of
// the page says which it belongs to.
type Mode = 'ask' | 'number' | 'signin' | 'check';

const COUNT = [
  'None',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve'
];

// The number for a birthday, from the API, which keeps the arithmetic.
const sampleFor = (b: string) =>
  api<Sample>('GET', `/api/sample?birthday=${b}&tz=${encodeURIComponent(browserZone())}`);

export function Home() {
  useTitle('');
  const navigate = useNavigate();
  const signIn = useSignedInAs();
  const go = useGo();
  const hash = useLocation({ select: (l) => l.hash });

  const [mode, setMode] = useState<Mode | null>(null);
  const [opening, setOpening] = useState(false);
  const [birthday, setBirthday] = useState<Mdy>(emptyMdy);
  const [sample, setSample] = useState<Sample | null>(null);
  const [sentTo, setSentTo] = useState('');
  const [resent, setResent] = useState('');
  const [birthdayBusy, runBirthday] = useBusy();
  const [startBusy, runStart] = useBusy();
  const [codeBusy, runCode] = useBusy();
  const birthdayProblem = useProblem();
  const focusLater = useFocusLater();
  const startProblem = useProblem();
  const codeProblem = useProblem();

  const month = useRef<HTMLSelectElement>(null);
  const email = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const youAre = useRef<HTMLHeadingElement>(null);

  // Read inside answers that arrive later.
  const now = useRef({ mode: null as Mode | null, before: 'ask' as Mode, explained: false, view: 0, resending: false });
  const handledHash = useRef<string | null>(null);

  const show = (m: Mode) => {
    ++now.current.view; // a pending answer must not replace a later navigation
    if (m !== 'check') now.current.before = m;
    now.current.mode = m;
    setMode(m);
  };
  const shows = (...ms: Mode[]) => mode !== null && ms.includes(mode);

  const showCheck = (address: string) => {
    setSentTo(address);
    show('check');
    focusLater(() => code.current);
  };

  const explain = (s: Sample) => {
    setSample(s);
    now.current.explained = true;
  };

  // Where this visit starts: the code if an email just went from this tab,
  // the sign-in form if asked for, the number if a birthday is waiting,
  // else the question.
  const start = async () => {
    const sent = store.get('rn-email');
    if (sent) {
      now.current.before =
        (store.get('rn-before') as Mode | null) ||
        (location.hash === '#sign-in' ? 'signin' : pendingBirthday.get() ? 'number' : 'ask');
      return showCheck(sent);
    }
    if (location.hash === '#sign-in') return show('signin');
    const b = pendingBirthday.get();
    if (b) {
      const mine = now.current.view;
      const r = await sampleFor(b);
      if (mine !== now.current.view) return;
      if (r.ok) {
        setBirthday(mdyOf(b));
        explain(r.data);
        return show('number');
      }
    }
    show('ask');
  };

  // Everything starts hidden. Someone signed in here before goes straight
  // on once /api/me agrees, without the form ever showing. If /api/me is
  // slow (a cold start), a quiet line after a moment.
  useEffect(() => {
    let gone = false;
    const hinted = signedIn.get();
    handledHash.current = location.hash.slice(1);
    setOpening(hinted);
    if (!hinted) start();
    api<{ new: boolean }>('GET', '/api/me').then((me) => {
      if (gone) return;
      // Already signed in: the same session, so what is cached stays.
      if (me.ok) return go(home(me.data.new));
      setOpening(false);
      if (hinted) start();
    });
    return () => {
      gone = true;
    };
    // Once, as the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back, forward, or a "sign in again" link from elsewhere.
  useEffect(() => {
    if (handledHash.current === null || handledHash.current === hash) return;
    handledHash.current = hash;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  const toHash = (h: string) => {
    handledHash.current = h;
    navigate({ to: '/', hash: h || undefined, replace: true });
  };

  const onBirthday = (e: FormEvent) => {
    e.preventDefault();
    runBirthday(async () => {
      birthdayProblem.clear();
      const b = mdyValue(birthday);
      if (!b) return birthdayProblem.show({ error: 'birthday' }, month.current);
      const mine = now.current.view;
      const r = await sampleFor(b);
      if (mine !== now.current.view) return;
      if (!r.ok) return birthdayProblem.show(r.data, month.current);
      pendingBirthday.set(b);
      explain(r.data);
      show('number');
      focusLater(() => youAre.current);
    });
  };

  const onStart = (e: FormEvent) => {
    e.preventDefault();
    runStart(async () => {
      startProblem.clear();
      const address = email.current!.value.trim();
      const r = await api('POST', '/api/auth/start', { email: address });
      if (r.status !== 202) return startProblem.show(r.data, null, email.current?.form);
      store.set('rn-email', address);
      store.set('rn-before', now.current.mode || 'ask');
      showCheck(address);
    });
  };

  // The same address again. Only the newest email's code works.
  const resend = async () => {
    if (now.current.resending) return;
    now.current.resending = true;
    codeProblem.clear();
    setResent('');
    const r = await api('POST', '/api/auth/start', { email: store.get('rn-email') || sentTo });
    now.current.resending = false;
    if (r.status !== 202) return codeProblem.show(r.data, code.current);
    code.current!.value = '';
    setResent('Sent again. Use the code in the newest email.');
    code.current?.focus();
  };

  const onCode = (e: FormEvent) => {
    e.preventDefault();
    runCode(async () => {
      codeProblem.clear();
      const r = await api<{ new: boolean }>('POST', '/api/auth/verify', {
        email: store.get('rn-email') || sentTo,
        code: code.current!.value
      });
      if (!r.ok) return codeProblem.show(r.data, null, code.current?.form);
      store.drop('rn-email');
      store.drop('rn-before');
      signedIn.set();
      signIn(home(r.data.new));
    });
  };

  const again = async () => {
    store.drop('rn-email');
    store.drop('rn-before');
    setResent('');
    const { before, explained } = now.current;
    // A reload restores the code before the number has been fetched.
    if (before === 'number' && !explained) {
      await start();
      focusLater(() =>
        now.current.mode === 'number' ? email.current : now.current.mode === 'ask' ? month.current : null
      );
      return;
    }
    show(before);
    focusLater(() => (before === 'ask' ? month.current : email.current));
  };

  const [major, minor, patch] = sample ? sample.version.split('.') : ['', '', ''];
  const n = Number(major);

  return (
    <>
      <Bar nav={false}>
        <a
          href="/#sign-in"
          id="to-sign-in"
          hidden={!shows('ask', 'number')}
          onClick={(e) => {
            e.preventDefault();
            toHash('sign-in');
            show('signin');
            focusLater(() => email.current);
          }}
        >
          Sign in
        </a>
      </Bar>

      {opening && <Loading text="Opening your notes…" wait={600} />}

      <section id="ask" hidden={!shows('ask')}>
        <p className="vnum huge unknown" aria-hidden="true">
          ?<span className="dot">.</span>?<span className="dot">.</span>???
        </p>
        <h1>What’s your version number?</h1>
        <p className="lede">Your age, written like software: decades, years, and the days since your last birthday.</p>

        <form id="birthday-form" noValidate onSubmit={onBirthday} onInput={birthdayProblem.clear}>
          <BirthdayFields value={birthday} onChange={setBirthday} firstRef={month} />
          <button className="go" type="submit" disabled={birthdayBusy}>
            Show me my number
          </button>
          <ErrorLine line={birthdayProblem.line} />
          <p className="hint">Nothing is kept until you sign up.</p>
        </form>
      </section>

      <section id="number" hidden={!shows('number')}>
        <h1 className="you-are" id="you-are" tabIndex={-1} ref={youAre}>
          <span className="lead">Today you’re</span>{' '}
          <span className="vnum huge" id="my-v">
            {sample && <Digits v={sample.version} />}
          </span>
        </h1>
        <p className="birthday-today" id="birthday-today" hidden={patch !== '0'}>
          Happy birthday: a new release.
        </p>
        <dl className="explain">
          <dt className="vnum" id="v-major">
            {major}
          </dt>
          <dd>
            <strong>Decades.</strong>{' '}
            <span id="v-major-line">
              {sample && (n === 0 ? 'None finished yet.' : `${COUNT[n] || n} of them, done.`)}
            </span>
          </dd>
          <dt className="vnum" id="v-minor">
            {minor}
          </dt>
          <dd>
            <strong>Years into this one.</strong> <span id="v-minor-line">{sample && `Together: ${sample.age}.`}</span>
          </dd>
          <dt className="vnum" id="v-patch">
            {patch}
          </dt>
          <dd>
            <strong>Days since your birthday.</strong> <span>It goes up by one every day.</span>
          </dd>
        </dl>
        <p className="sub" id="v-next">
          {sample && (
            <>
              <span className="mono">{sample.next.version}</span>
              {` ships ${longDate(sample.next.date)}, ${sample.next.days === 1 ? 'tomorrow' : `in ${sample.next.days} days`}.`}
            </>
          )}
        </p>

        <h2 className="big get-it">Get it every day.</h2>
        <p className="lede">
          One email a day, at the time you choose, with that day’s number. Reply with anything about the day, and your
          reply becomes the release notes for{' '}
          <span className="mono" id="v-today">
            {sample?.version}
          </span>
          .
        </p>
      </section>

      <section id="sign-in" hidden={!shows('signin')}>
        <h1 className="top">Sign in.</h1>
        <p className="lede">
          Type the email your release notes come to. New here?{' '}
          <a
            href="/"
            id="to-ask"
            onClick={(e) => {
              e.preventDefault();
              toHash('');
              startProblem.clear();
              const m = now.current.explained && pendingBirthday.get() ? 'number' : 'ask';
              show(m);
              focusLater(() => (m === 'ask' ? month.current : youAre.current));
            }}
          >
            Find your version number first
          </a>
          .
        </p>
      </section>

      <form
        id="start-form"
        noValidate
        hidden={!shows('number', 'signin')}
        onSubmit={onStart}
        onInput={startProblem.clear}
      >
        <label>
          Your email
          <input ref={email} type="email" name="email" autoComplete="email" placeholder="you@example.com" required />
        </label>
        <button className="go" type="submit" disabled={startBusy}>
          Send me a link
        </button>
        <ErrorLine line={startProblem.line} />
        <p className="hint" hidden={!shows('number')}>
          We’ll email a link and a six-digit code. Your birthday comes along once you confirm.{' '}
          <button
            className="quiet inline"
            type="button"
            id="change-birthday"
            onClick={() => {
              startProblem.clear();
              show('ask');
              focusLater(() => month.current);
            }}
          >
            Change birthday
          </button>
        </p>
        <p className="hint" hidden={!shows('signin')}>
          We’ll email you a link and a six-digit code.
        </p>
      </form>

      <section id="check" hidden={!shows('check')}>
        <h1 className="top">Check your email.</h1>
        <p className="lede">
          We sent a link and a code to <strong id="sent-to">{sentTo}</strong>. Open the link, or type the code here.
        </p>

        <form id="code-form" noValidate onSubmit={onCode} onInput={codeProblem.clear}>
          <label>
            Six-digit code
            <input
              ref={code}
              className="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="000000"
              required
            />
          </label>
          <button className="go" type="submit" disabled={codeBusy}>
            Sign in
          </button>
          <ErrorLine line={codeProblem.line} />
        </form>

        <p className="hint">
          The link and the code work once, for 15 minutes. Nothing there? Look in junk,{' '}
          <a
            href="/"
            id="resend"
            onClick={(e) => {
              e.preventDefault();
              resend();
            }}
          >
            send it again
          </a>
          , or{' '}
          <a
            href="/"
            id="again"
            onClick={(e) => {
              e.preventDefault();
              again();
            }}
          >
            use a different address
          </a>
          .
        </p>
        <p className="hint spaced" id="resent" role="status" hidden={!resent}>
          {resent}
        </p>
        <p className="foot">
          The email comes from <strong>notes@yourversionnumber.com</strong>. Adding it to your contacts keeps your daily
          emails out of junk.
        </p>
      </section>

      <p className="foot" id="home-foot" hidden={!shows('ask', 'number', 'signin')}>
        A hobby by <a href="https://www.thingelstad.com/">Jamie Thingelstad</a>. Your notes are yours: export or delete
        them any time. Jamie runs it and can read what’s stored; nothing is sold or shared. No ads. Page counts by
        Tinylytics, without cookies. From <a href="https://yourversionnumber.com/">Your Version Number</a>.
      </p>
    </>
  );
}
