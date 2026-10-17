// Approval uses the owner's existing email-verified session. The pending
// request stays in the fragment, out of page counts and server URLs.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, ErrorLine, Failed, Loading, useBusy, useProblem, useTitle } from '../components/common.tsx';
import { api, load } from '../lib/api.ts';
import { useHashParam, useMe } from '../lib/nav.ts';

interface RequestInfo {
  client_name: string;
  scope: string;
}

export function Connect() {
  useTitle('Connect an agent');
  const request = useHashParam('request');
  const me = useMe();
  const info = useQuery({
    queryKey: ['mcp-request', request],
    queryFn: () => load<RequestInfo>('POST', '/api/mcp/authorize', { request }),
    enabled: !!request,
    retry: false
  });
  const [media, setMedia] = useState(false);
  const [write, setWrite] = useState(false);
  const [upcoming, setUpcoming] = useState(false);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const decide = (approve: boolean) =>
    run(async () => {
      problem.clear();
      const r = await api<{ redirect: string }>('POST', '/api/mcp/authorize', {
        request,
        approve,
        media,
        write,
        upcoming
      });
      if (!r.ok)
        return problem.show('This connection request expired or could not be approved. Start again from your agent.');
      window.location.assign(r.data.redirect);
    });
  return (
    <>
      <Bar />
      <h1>Connect an agent</h1>
      {!request && <p>Start a connection from your agent to get an approval request.</p>}
      {request && info.isPending && <Loading />}
      {info.isError && (
        <>
          <Failed />
          <p>Start again from your agent if this request has expired.</p>
        </>
      )}
      {info.data && (
        <section className="section agent-content">
          <h2>{info.data.client_name} wants to read your notes</h2>
          <p>Connected as {me.data?.email}. The client supplied this name; connect only if you started this request.</p>
          <p>
            This shares your whole archive: note text, tags, places, weather, and any existing transcripts and photo
            descriptions. The agent can search and discuss them with you.
          </p>
          {info.data.scope.includes('media:read') && (
            <label className="check">
              <input type="checkbox" checked={media} onChange={(e) => setMedia(e.target.checked)} /> Also allow photos
              and recordings
            </label>
          )}
          {info.data.scope.includes('notes:write') && (
            <label className="check">
              <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Also allow adding
              notes when I ask
            </label>
          )}
          {write && (
            <p className="hint">
              The agent can create notes and append to notes this connection created. They show who added them. It
              cannot rewrite your notes or delete anything. Turn off adding in Settings without stopping reads.
            </p>
          )}
          {info.data.scope.includes('upcoming') && (
            <label className="check">
              <input type="checkbox" checked={upcoming} onChange={(e) => setUpcoming(e.target.checked)} /> Also allow
              reading and changing my Upcoming dates
            </label>
          )}
          {upcoming && (
            <p className="hint">
              The agent can list your Upcoming dates and, when you ask, add, change and remove them. This never touches
              your notes.
            </p>
          )}
          <p className="hint">
            The agent service receives what it reads under its own privacy and retention policies. Adding notes is off
            unless you choose it above. It cannot delete notes, change settings, or start processing. Your transcription
            and photo description choices stay as they are. Jamie, the operator, can read notes added here too.
          </p>
          <p className="hint">
            Disconnect in Settings whenever you like. It stops future reads; content already shared and private file
            links that last up to ten minutes may remain available to the service.
          </p>
          <div className="row">
            <button className="go" type="button" disabled={busy} onClick={() => decide(true)}>
              {write && upcoming
                ? 'Allow reading, adding and Upcoming'
                : write
                  ? 'Allow reading and adding'
                  : upcoming
                    ? 'Allow reading and Upcoming'
                    : 'Allow reading'}
            </button>
            <button type="button" className="quiet" disabled={busy} onClick={() => decide(false)}>
              Cancel
            </button>
          </div>
          <ErrorLine line={problem.line} />
        </section>
      )}
    </>
  );
}
