// A book of the owner's notes for any days they pick (?from&to, which a
// release's page fills in): a PDF at 6 by 9 inches or US Letter with the
// photos, places and weather, typeset by the export worker and offered for a
// day (packages/backend/books.ts).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Bar, Crumb, ErrorLine, Failed, Loading, useBusy, useProblem, useTitle } from '../components/common.tsx';
import { api, get } from '../lib/api.ts';
import { count, dayName, megabytes, thisYearOf } from '../lib/format.ts';
import { useMe, useQueryParam } from '../lib/nav.ts';
import { releasesQuery } from '../lib/queries.ts';
import type { BookPlan, BookStatus, Me } from '../lib/types.ts';
import { MAX_TITLE, type PageSize } from '../../../packages/book/limits.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PICK = 'Pick a first and last day between your birthday and today, the first no later than the last.';
const PAGES: [PageSize, string, string][] = [
  ['6x9', '6 by 9 inches', 'a book’s size, for a printer that binds'],
  ['letter', 'US Letter', '8½ by 11 inches, for printing at home']
];
const pageName = (page?: PageSize) => PAGES.find(([v]) => v === page)?.[1] ?? '';

export function Book() {
  useTitle('Make a book');
  const me = useMe();
  const p = me.data && !me.data.new ? me.data : null;
  const book = useQuery({
    queryKey: ['book'],
    queryFn: () => get<BookStatus>('/api/book'),
    refetchInterval: (q) => (q.state.status === 'error' ? 10000 : q.state.data?.status === 'building' ? 3000 : false),
    retry: false,
    meta: { bounce: false }
  });
  const b = book.data;
  return (
    <>
      <Bar />
      <Crumb href="/timeline/" phone>
        Archive
      </Crumb>
      <h1>Make a book</h1>
      <p className="lede">
        Your notes from any days you pick, set as a book with their photos, places and weather: a PDF to read, or to
        print at 6 by 9 inches or on US Letter.
      </p>
      {(me.isPending || book.isPending) && <Loading />}
      {(me.isError || book.isError) && <Failed />}
      {p && b && <BookForm p={p} b={b} />}
    </>
  );
}

function BookForm({ p, b }: { p: Me; b: BookStatus }) {
  const client = useQueryClient();
  const releases = useQuery(releasesQuery);
  // Releases with notes, newest first, each to today at the latest.
  const spans = (releases.data?.releases || [])
    .filter((r) => r.notes > 0)
    .map((r) => ({ v: r.v, from: r.from, to: r.through < p.today ? r.through : p.today, notes: r.notes }));
  const asked = (v: string | null) => (v && DAY.test(v) && v >= p.birthday && v <= p.today ? v : '');
  const askedFrom = asked(useQueryParam('from'));
  const askedTo = asked(useQueryParam('to'));
  const [from, setFrom] = useState(askedFrom);
  const [to, setTo] = useState(askedTo || p.today);
  const [title, setTitle] = useState('');
  const [page, setPage] = useState<PageSize>(b.page ?? '6x9');
  const [busy, run] = useBusy();
  const problem = useProblem();
  const form = useRef<HTMLFormElement>(null);
  const year = thisYearOf(p.today);
  const first = from || spans[0]?.from || p.today;
  const ok = DAY.test(first) && DAY.test(to) && first <= to && first >= p.birthday && to <= p.today;
  const plan = useQuery({
    queryKey: ['book-plan', first, to],
    queryFn: () => get<BookPlan>(`/api/book/plan?from=${first}&to=${to}`),
    enabled: ok,
    meta: { bounce: false }
  });
  const picked = spans.find((s) => s.from === first && s.to === to)?.v ?? '';
  const n = plan.data;
  const tooMany = !!n && n.photos > n.max_photos;
  const building = b.status === 'building';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      problem.clear();
      if (!ok) return problem.show({ error: 'date' }, form.current?.querySelector<HTMLElement>('input[name=from]'));
      const r = await api<BookStatus>('POST', '/api/book', {
        from: first,
        to,
        page,
        ...(title.trim() ? { title } : {})
      });
      if (r.status !== 202) return problem.show(r.data, null, form.current);
      await client.invalidateQueries({ queryKey: ['book'] });
    });
  };

  return (
    <>
      <BookState b={b} year={year} />
      <form ref={form} id="book-form" className="roomy" noValidate onSubmit={submit} hidden={building}>
        <fieldset className="book-fields" disabled={busy}>
          {spans.length > 0 && (
            <label>
              Release
              <select
                name="release"
                value={picked}
                onChange={(e) => {
                  problem.clear();
                  const s = spans.find((x) => x.v === e.target.value);
                  if (s) {
                    setFrom(s.from);
                    setTo(s.to);
                  }
                }}
              >
                <option value="">Days I pick</option>
                {spans.map((s) => (
                  <option key={s.v} value={s.v}>
                    {s.v}, {count(s.notes, 'note', 'notes')}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="upcoming-date-fields">
            <label>
              First day
              <input
                type="date"
                name="from"
                min={p.birthday}
                max={p.today}
                value={first}
                onChange={(e) => {
                  problem.clear();
                  setFrom(e.target.value);
                }}
              />
            </label>
            <label>
              Last day
              <input
                type="date"
                name="to"
                min={p.birthday}
                max={p.today}
                value={to}
                onChange={(e) => {
                  problem.clear();
                  setTo(e.target.value);
                }}
              />
            </label>
          </div>
          <label>
            Title (optional)
            <input
              name="title"
              maxLength={MAX_TITLE}
              autoComplete="off"
              placeholder={n?.title || ''}
              value={title}
              onChange={(e) => {
                problem.clear();
                setTitle(e.target.value);
              }}
            />
          </label>
          <fieldset className="choices">
            <legend>Page size</legend>
            {PAGES.map(([v, name, about]) => (
              <label key={v} className={page === v ? 'choice on' : 'choice'}>
                <input
                  type="radio"
                  name="page"
                  value={v}
                  checked={page === v}
                  onChange={() => {
                    problem.clear();
                    setPage(v);
                  }}
                />{' '}
                <span>
                  {name}, {about}
                </span>
              </label>
            ))}
          </fieldset>
        </fieldset>
        <div className="stack tight">
          <p className="value" id="book-plan" role="status">
            {!ok
              ? PICK
              : !n
                ? ''
                : !n.days
                  ? 'No notes in those days.'
                  : [
                      count(n.days, 'day', 'days'),
                      count(n.notes, 'note', 'notes'),
                      ...(n.photos ? [count(n.photos, 'photo', 'photos')] : []),
                      ...(n.memos ? [count(n.memos, 'voice memo', 'voice memos')] : [])
                    ].join(' · ')}
          </p>
          {tooMany && (
            <p className="hint" id="book-too-many">
              That’s more photos than one book holds ({n.max_photos.toLocaleString('en-US')}). Pick fewer days.
            </p>
          )}
          <div className="row">
            <button className="go" type="submit" disabled={busy || !ok || !n?.days || tooMany}>
              Make the book
            </button>
          </div>
          <ErrorLine line={problem.line} />
          <p className="hint">One book at a time. It’s yours to download for a day, and you can make another after.</p>
        </div>
      </form>
    </>
  );
}

// The book being made, or the last one made, while it is offered.
function BookState({ b, year }: { b: BookStatus; year: number }) {
  if (b.status === 'none') return null;
  const days =
    b.from && b.to
      ? b.from === b.to
        ? dayName(b.from, year)
        : `${dayName(b.from, year)} to ${dayName(b.to, year)}`
      : '';
  const name = b.title ? `“${b.title}”, ${days}` : days;
  let line = '';
  if (b.status === 'building')
    line = `Making the book of ${name}. With lots of photos it can take a few minutes, and you can leave this page and come back.`;
  else if (b.status === 'failed')
    line =
      b.reason === 'empty'
        ? `There were no notes in ${days}, so there’s no book.`
        : `The book of ${name} didn’t finish.`;
  else if (b.status === 'ready') {
    const t = new Date(b.until || '');
    const until = `${t.toLocaleDateString('en-US', { weekday: 'long' })} at ${t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    const left = b.missing
      ? ` ${count(b.missing, 'photo couldn’t be read and was', 'photos couldn’t be read and were')} left out.`
      : '';
    line = `Ready: ${name}, ${count(b.pages || 0, 'page', 'pages')}, ${pageName(b.page)}, ${megabytes(b.size || 0)}.${left} The download is here until ${until}.`;
  }
  return (
    <div className="section" id="book-state">
      {b.status === 'ready' && (
        <div className="row">
          <a className="go" href="/api/book/file" id="book-file">
            Download the book
          </a>
        </div>
      )}
      <p className="hint" id="book-status" role="status">
        {line}
      </p>
    </div>
  );
}
