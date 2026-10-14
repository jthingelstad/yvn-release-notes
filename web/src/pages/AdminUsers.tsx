// Basic subscriber metadata only. No journal reader or content drill-down.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, ErrorLine, Loading, useTitle } from '../components/common.tsx';
import { AdminNav } from '../components/admin-nav.tsx';
import { get, ApiError } from '../lib/api.ts';
import type { SubscriberOverview } from '../../../packages/backend/subscriber-overview.ts';
type SortColumn =
  'email' | 'status' | 'entries' | 'days' | 'last_added_at' | 'last_sent_date' | 'send_time' | 'joined_at';
const COLUMNS: { key: SortColumn; label: string }[] = [
  { key: 'email', label: 'Email address' },
  { key: 'status', label: 'Email status' },
  { key: 'entries', label: 'Entries' },
  { key: 'days', label: 'Days' },
  { key: 'last_added_at', label: 'Last added' },
  { key: 'last_sent_date', label: 'Last email' },
  { key: 'send_time', label: 'Daily send' },
  { key: 'joined_at', label: 'Joined' }
];
const statusName = (user: SubscriberOverview) => {
  if (user.status === 'active') return 'Receiving emails';
  if (user.status === 'paused') return `Paused through ${user.pause_through}`;
  const reasons: Record<string, string> = {
    unsubscribed: 'Unsubscribed',
    bounce: 'Hard bounce',
    complaint: 'Complaint'
  };
  return 'Stopped' + (user.stopped_reason ? ` · ${reasons[user.stopped_reason]}` : '');
};
function dateTime(at: string | null, tz: string) {
  if (!at) return 'None recorded';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(at));
}
export function AdminUsers() {
  useTitle('Users');
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => get<{ users: SubscriberOverview[]; as_of: string }>('/api/admin/users')
  });
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('all'),
    [sort, setSort] = useState<{ column: SortColumn; direction: 'ascending' | 'descending' }>({
      column: 'email',
      direction: 'ascending'
    });
  const all = users.data?.users ?? [];
  const filtered = all
    .filter(
      (u) => u.email.toLowerCase().includes(search.trim().toLowerCase()) && (status === 'all' || u.status === status)
    )
    .toSorted((a, b) => {
      const left = sort.column === 'status' ? statusName(a) : a[sort.column],
        right = sort.column === 'status' ? statusName(b) : b[sort.column];
      // Missing activity stays last in either direction.
      if (left === null || right === null)
        return left === right ? a.email.localeCompare(b.email) : left === null ? 1 : -1;
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      return (sort.direction === 'ascending' ? order : -order) || a.email.localeCompare(b.email);
    });
  function sortBy(column: SortColumn) {
    setSort((current) => ({
      column,
      direction: current.column === column && current.direction === 'ascending' ? 'descending' : 'ascending'
    }));
  }
  return (
    <>
      <Bar current="/settings/" />
      <h1>Users</h1>
      <p className="lede">Who’s here, and how their Release Notes are going.</p>
      <AdminNav current="users" />
      {users.isPending ? (
        <Loading />
      ) : users.isError ? (
        <ErrorLine
          line={
            users.error instanceof ApiError && users.error.answer.status === 403
              ? 'This page is only for the Release Notes administrator.'
              : 'Couldn’t load users. Please reload and try again.'
          }
        />
      ) : (
        <>
          <p className="section" aria-label="User totals">
            {all.length} {all.length === 1 ? 'user' : 'users'} · {all.filter((u) => u.status === 'active').length}{' '}
            receiving emails · {all.filter((u) => u.status === 'paused').length} paused ·{' '}
            {all.filter((u) => u.status === 'stopped').length} stopped
          </p>
          <div className="roomy admin-filters">
            <label>
              Find an email address
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <label>
              <span id="admin-email-status-label">Email status</span>
              <select
                aria-labelledby="admin-email-status-label"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">All users</option>
                <option value="active">Receiving emails</option>
                <option value="paused">Paused</option>
                <option value="stopped">Stopped</option>
              </select>
            </label>
          </div>
          <p className="hint" role="status">
            Showing {filtered.length} of {all.length} users.
          </p>
          <div className="table-scroll" role="region" aria-label="Users table" tabIndex={0}>
            <table className="data-table users-table" aria-label="Users">
              <thead>
                <tr>
                  {COLUMNS.map(({ key, label }) => (
                    <th key={key} scope="col" aria-sort={sort.column === key ? sort.direction : undefined}>
                      <button className="table-sort" type="button" onClick={() => sortBy(key)}>
                        {label}{' '}
                        <span aria-hidden="true">
                          {sort.column === key ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr key={user.email}>
                    <th scope="row" className="table-email">
                      {user.email}
                    </th>
                    <td>{statusName(user)}</td>
                    <td className="table-number">{user.entries}</td>
                    <td className="table-number">{user.days}</td>
                    <td>{dateTime(user.last_added_at, user.tz)}</td>
                    <td>{user.last_sent_date ?? 'None recorded'}</td>
                    <td>
                      {user.send_time}
                      <span className="table-detail">{user.tz}</span>
                    </td>
                    <td>{dateTime(user.joined_at, user.tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!filtered.length && <p className="hint">{all.length ? 'No users match these filters.' : 'No users yet.'}</p>}
          <button className="quiet" type="button" disabled={users.isFetching} onClick={() => users.refetch()}>
            Reload users
          </button>
          <p className="hint">
            Email status shows whether daily sends are enabled. Last email is its local date sent, without open or click
            tracking. Entry totals include imports; last added includes import activity. Dates and times use each
            person’s time zone.
          </p>
          <p className="hint">
            Updated {dateTime(users.data?.as_of ?? null, Intl.DateTimeFormat().resolvedOptions().timeZone)} (your time).
          </p>
        </>
      )}
    </>
  );
}
