// Basic subscriber metadata only. No journal reader or content drill-down.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, ErrorLine, Loading, useTitle } from '../components/common.tsx';
import { AdminNav } from '../components/admin-nav.tsx';
import { get, ApiError } from '../lib/api.ts';
import type { SubscriberOverview } from '../../../packages/backend/subscriber-overview.ts';
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
    [status, setStatus] = useState('all');
  const all = users.data?.users ?? [];
  const filtered = all.filter(
    (u) => u.email.toLowerCase().includes(search.trim().toLowerCase()) && (status === 'all' || u.status === status)
  );
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
          <p className="hint">
            Email status shows whether daily sends are enabled. Last email is its local date sent, without open or click
            tracking. Entry totals include imports; last added includes import activity. Dates and times below use each
            person’s time zone.
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
          <ul className="subscriber-list">
            {filtered.map((user) => (
              <li key={user.email}>
                <h2>{user.email}</h2>
                <p>{statusName(user)}</p>
                <dl className="subscriber-facts">
                  <div>
                    <dt>Last added</dt>
                    <dd>{dateTime(user.last_added_at, user.tz)}</dd>
                  </div>
                  <div>
                    <dt>Entries</dt>
                    <dd>
                      {user.entries} across {user.days} days
                    </dd>
                  </div>
                  <div>
                    <dt>Last email</dt>
                    <dd>{user.last_sent_date ?? 'None recorded'}</dd>
                  </div>
                  <div>
                    <dt>Daily send</dt>
                    <dd>
                      {user.send_time} · {user.tz}
                    </dd>
                  </div>
                  <div>
                    <dt>Joined</dt>
                    <dd>{dateTime(user.joined_at, user.tz)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          {!filtered.length && <p className="hint">{all.length ? 'No users match these filters.' : 'No users yet.'}</p>}
          <button className="quiet" type="button" disabled={users.isFetching} onClick={() => users.refetch()}>
            Reload users
          </button>
          <p className="hint">
            Updated {dateTime(users.data?.as_of ?? null, Intl.DateTimeFormat().resolvedOptions().timeZone)} (your time).
          </p>
        </>
      )}
    </>
  );
}
