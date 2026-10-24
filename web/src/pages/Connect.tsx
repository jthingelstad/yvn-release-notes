// Approval uses the owner's existing email-verified session. The pending
// request stays in the fragment, out of page counts and server URLs.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AppLink, Bar, ErrorLine, Failed, Loading, useBusy, useProblem, useTitle } from '../components/common.tsx';
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
      {!info.data && (
        <>
          <p className="kicker">{request ? 'Approval request' : 'No request open'}</p>
          <h1>Connect an agent</h1>
        </>
      )}
      {!request && <NoRequest />}
      {request && info.isPending && <Loading />}
      {info.isError && (
        <>
          <Failed />
          <p>Start again from your agent if this request has expired.</p>
        </>
      )}
      {info.data && (
        <section className="agent-content connect-request">
          <p className="kicker">Approval request</p>
          <h1>{info.data.client_name} wants to read your notes</h1>
          <p className="hint">
            Connected as {me.data?.email}. The client supplied this name; connect only if you started this request.
          </p>
          <h2 className="connect-shared">Shared</h2>
          <ul className="connect-list">
            <li>
              Your whole archive: note text, tags, places, weather, and any existing transcripts and photo descriptions
            </li>
            <li>Your badges, releases, settings and your activity log</li>
            <li>Never your email address or private addresses</li>
          </ul>
          <p className="hint">The agent can search and discuss them with you.</p>
          <div className="connect-options">
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
            <label className="check">
              <input type="checkbox" checked={upcoming} onChange={(e) => setUpcoming(e.target.checked)} /> Also allow
              reading and changing my Upcoming dates
            </label>
            {upcoming && (
              <p className="hint">
                The agent can list your Upcoming dates (birthdays, anniversaries, trips and events) and, when you ask,
                add, change and remove them. Upcoming is separate from notes: this never adds, rewrites or deletes a
                note. Turn it off in Settings by disconnecting; add it later there without reconnecting.
              </p>
            )}
          </div>
          <p className="hint">
            The agent service receives what it reads under its own privacy and retention policies. Adding notes and
            Upcoming are off unless you choose them above. It cannot delete notes, change settings, or start processing.
            Your transcription and photo description choices stay as they are. Jamie, the operator, can read notes added
            here too.
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

const MCP = 'https://notes.yourversionnumber.com/mcp';

// No request yet: the address to add in the agent's app, which then opens
// this page with its request.
function NoRequest() {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <p className="lede">
        An agent like Claude can search your notes and talk them over with you. Start from the agent’s app, and this
        page asks you to approve it.
      </p>
      <div className="connect-address">
        <p className="label">Add this address as a connector</p>
        <div className="row">
          <span className="mono" id="mcp-address">
            {MCP}
          </span>
          <button className="quiet" type="button" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {copied === false && (
          <p className="hint" role="status">
            Couldn’t copy it. Select the address and copy it from there.
          </p>
        )}
        <p className="meta">
          What you’ve connected is under <AppLink href="/settings/">Settings</AppLink>, Connected agents.
        </p>
      </div>
    </>
  );
}
