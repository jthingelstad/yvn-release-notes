// Fields more than one page uses: the birthday, the send time, and the zip
// export. The city search is placepicker.tsx, so React Aria loads only with
// the pages that have it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, get } from '../lib/api.ts';
import { clock, megabytes, SEND_TIMES } from '../lib/format.ts';
import type { ZipStatus } from '../lib/types.ts';

// --- the birthday ------------------------------------------------------------
// Month, day and year as three fields: quicker than a date picker's wheel
// for a year decades back.

export interface Mdy {
  month: string;
  day: string;
  year: string;
}

export const emptyMdy: Mdy = { month: '', day: '', year: '' };

// 'YYYY-MM-DD', or '' until the three make a real date; the API says if it
// is in the future.
export function mdyValue({ month, day, year }: Mdy): string {
  const m = Number(month),
    d = Number(day),
    y = Number(year);
  if (!m || !/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year)) return '';
  const t = new Date(y, m - 1, d);
  if (t.getMonth() !== m - 1 || t.getDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function mdyOf(iso: string): Mdy {
  const [y, m, d] = iso.split('-').map(Number);
  return { month: String(m), day: String(d), year: String(y) };
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

export function BirthdayFields({
  value,
  onChange,
  firstRef
}: {
  value: Mdy;
  onChange: (v: Mdy) => void;
  firstRef?: React.Ref<HTMLSelectElement>;
}) {
  const digits = (s: string) => s.replace(/[^0-9]/g, '');
  return (
    <fieldset className="birthday">
      <legend>Your birthday</legend>
      <div className="mdy">
        <label>
          Month
          <select
            ref={firstRef}
            name="month"
            autoComplete="bday-month"
            required
            value={value.month}
            onChange={(e) => onChange({ ...value, month: e.target.value })}
          >
            <option value="">—</option>
            {MONTHS.map((name, i) => (
              <option key={name} value={String(i + 1)}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Day
          <input
            name="day"
            inputMode="numeric"
            autoComplete="bday-day"
            maxLength={2}
            placeholder="DD"
            required
            value={value.day}
            onChange={(e) => onChange({ ...value, day: digits(e.target.value) })}
          />
        </label>
        <label>
          Year
          <input
            name="year"
            inputMode="numeric"
            autoComplete="bday-year"
            maxLength={4}
            placeholder="YYYY"
            required
            value={value.year}
            onChange={(e) => onChange({ ...value, year: digits(e.target.value) })}
          />
        </label>
      </div>
    </fieldset>
  );
}

// --- the send time -----------------------------------------------------------

export function SendTimeSelect({
  value,
  onChange,
  id,
  selectRef
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  selectRef?: React.Ref<HTMLSelectElement>;
}) {
  return (
    <select
      ref={selectRef}
      name="send_time"
      className="send-times"
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {SEND_TIMES.map((v) => (
        <option key={v} value={v}>
          {clock(v)}
        </option>
      ))}
    </select>
  );
}

// --- the zip export ----------------------------------------------------------
// Everything, photos and recordings too, built in the background
// (export_job.py): start it, ask every few seconds, then offer the link.

export function ZipExport() {
  const client = useQueryClient();
  const zip = useQuery({
    queryKey: ['zip'],
    queryFn: () => get<ZipStatus>('/api/export/zip'),
    refetchInterval: (q) => (q.state.status === 'error' ? 10000 : q.state.data?.status === 'building' ? 3000 : false),
    retry: false,
    // A failure just asks again later; the page itself sends anyone signed
    // out to sign in.
    meta: { bounce: false }
  });
  const [starting, setStarting] = useState(false);
  const [couldNot, setCouldNot] = useState(false);
  const z = zip.data;
  const state = z?.status || 'none';

  const start = async () => {
    setStarting(true);
    const r = await api<ZipStatus>('POST', '/api/export/zip');
    setStarting(false);
    if (r.status === 202) {
      setCouldNot(false);
      client.setQueryData(['zip'], r.data);
      return;
    }
    setCouldNot(true);
  };

  let status = '';
  if (couldNot) status = 'Couldn’t start the export just now. Try again in a minute.';
  else if (state === 'building')
    status =
      'Putting it together. With lots of photos it can take a few minutes, and you can leave this page and come back.';
  else if (state === 'ready' && z) {
    const t = new Date(z.until || '');
    const until = `${t.toLocaleDateString('en-US', { weekday: 'long' })} at ${t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    const files = z.files ? `, with ${z.files} ${z.files === 1 ? 'photo or recording' : 'photos and recordings'}` : '';
    status = `Ready: ${megabytes(z.size || 0)}${files}. The download is here until ${until}.`;
  } else if (state === 'failed') status = 'That export didn’t finish.';

  return (
    <>
      <div className="row">
        <a className="go" href="/api/export/zip/file" data-zip-file="" hidden={state !== 'ready'}>
          Download the zip
        </a>
        <button
          className={state === 'ready' ? 'quiet' : 'go'}
          type="button"
          data-zip-start=""
          hidden={state === 'building'}
          disabled={starting}
          onClick={start}
        >
          {state === 'ready' ? 'Make a fresh one' : state === 'failed' ? 'Try again' : 'Export everything'}
        </button>
      </div>
      <p className="hint" data-zip-status="" role="status" hidden={!status}>
        {status}
      </p>
    </>
  );
}
