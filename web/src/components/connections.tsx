import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get } from '../lib/api.ts';
import { ErrorLine, Failed, Loading, useBusy, useProblem } from './common.tsx';

interface Connection {
  id: string;
  client_name: string;
  scope: string;
  created_at: number;
  last_used?: number;
}
interface Activity {
  at: number;
  tool: string;
  outcome: string;
  connection: string;
}
const when = (at: number) => new Date(at * 1000).toLocaleString();

export function Connections() {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ['mcp-connections'],
    queryFn: () => get<{ connections: Connection[] }>('/api/mcp/connections')
  });
  const activity = useQuery({
    queryKey: ['mcp-activity'],
    queryFn: () => get<{ activity: Activity[] }>('/api/mcp/activity')
  });
  const [busy, run] = useBusy();
  const problem = useProblem();
  const disconnect = (id: string) =>
    run(async () => {
      problem.clear();
      const r = await api('DELETE', '/api/mcp/connections/' + encodeURIComponent(id));
      if (!r.ok) return problem.show('Couldn’t disconnect. Try again.');
      await client.invalidateQueries({ queryKey: ['mcp-connections'] });
    });
  return (
    <section className="section wide agent-content" id="agent-connections">
      <h2>Connected agents</h2>
      <p>To discuss your notes with Claude, add a custom connector with this address:</p>
      <p className="value">
        <a href="https://notes.yourversionnumber.com/mcp">https://notes.yourversionnumber.com/mcp</a>
      </p>
      <p className="hint">
        Approve reading when it opens this site. An agent service receives your notes under its own privacy and
        retention policies. Connections can only read, and never turn processing on.
      </p>
      {list.isPending && <Loading />}
      {list.isError && <Failed />}
      {list.data?.connections.length === 0 && <p>No agents connected.</p>}
      {list.data?.connections.map((c) => (
        <div className="section" key={c.id}>
          <h3>{c.client_name}</h3>
          <p>
            {c.scope.includes('media:read') ? 'Notes, photos and recordings' : 'Notes and existing transcripts'}.
            Connected {when(c.created_at)}.
          </p>
          {c.last_used && <p className="hint">Last read {when(c.last_used)}.</p>}
          <button type="button" className="quiet" disabled={busy} onClick={() => disconnect(c.id)}>
            Disconnect {c.client_name}
          </button>
        </div>
      ))}
      <ErrorLine line={problem.line} />
      <p className="hint">
        Disconnecting stops new requests immediately. Already shared content stays subject to the agent service’s
        retention policies; private file links expire within ten minutes.
      </p>
      <h3>Recent reading</h3>
      <p className="hint">
        The last 14 days, up to 50 requests. We keep the time, tool and outcome here, never the search words or the
        content returned.
      </p>
      {activity.isError && <Failed />}
      {activity.data?.activity.length === 0 && <p>No recent reading.</p>}
      {activity.data?.activity.map((a, i) => (
        <p className="hint" key={`${a.at}-${i}`}>
          {when(a.at)} · {a.tool} · {a.outcome}
        </p>
      ))}
    </section>
  );
}
