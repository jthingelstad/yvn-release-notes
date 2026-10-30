// Approval uses the owner's existing email-verified session. The pending
// request stays in the fragment, out of page counts and server URLs. An
// agent asks to connect to /mcp; an app asks to sign in to /v1, which makes
// it an API token (docs/API.md, Phase 5).
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { EXPIRY, OFFERED } from '../components/api-tokens.tsx';
import { AppLink, Bar, ErrorLine, Failed, Loading, useBusy, useProblem, useTitle } from '../components/common.tsx';
import { api, load } from '../lib/api.ts';
import { useHashParam, useMe } from '../lib/nav.ts';

interface RequestInfo {
  client_name: string;
  scope: string;
  // An app's sign-in: the API, and a name for its token no other has.
  resource?: '/v1';
  name?: string;
}

export function Connect() {
  const request = useHashParam('request');
  const me = useMe();
  const info = useQuery({
    queryKey: ['mcp-request', request],
    queryFn: () => load<RequestInfo>('POST', '/api/mcp/authorize', { request }),
    enabled: !!request,
    retry: false
  });
  useTitle(info.data?.resource === '/v1' ? 'Sign in an app' : 'Connect an agent');
  const [media, setMedia] = useState(false);
  const [write, setWrite] = useState(false);
  const [files, setFiles] = useState(false);
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
        files: write && files,
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
      {info.data?.resource === '/v1' && request && (
        <AppSignIn info={info.data} request={request} email={me.data?.email} />
      )}
      {info.data && info.data.resource !== '/v1' && (
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
          <p className="hint">
            The agent can search and discuss them with you, and send Jamie feedback about Release Notes for you.
          </p>
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
                The agent can create notes and append to notes this connection created, and rewrite those notes when you
                ask. They show who added them. It cannot rewrite your notes or delete anything. Turn off adding in
                Settings without stopping reads.
              </p>
            )}
            {write && (
              <label className="check">
                <input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} /> Also allow adding
                photos, recordings and PDFs to those notes
              </label>
            )}
            {write && files && (
              <p className="hint">
                Files it adds are kept like the ones you upload: thumbnails are made, a photo’s place is read, and your
                own transcription and photo description choices apply to them.
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

// An app signing in chooses an API token, as Settings makes one: its name,
// what it may do from what the app asked for, and when it expires. Nothing
// is made until the app takes the answer back.
export function AppSignIn({ info, request, email }: { info: RequestInfo; request: string; email?: string }) {
  const asked = OFFERED.filter(([s]) => info.scope.split(' ').includes(s));
  const [name, setName] = useState(info.name ?? '');
  const [scopes, setScopes] = useState<string[]>(asked.map(([s]) => s));
  const [expiry, setExpiry] = useState('1y');
  const [busy, run] = useBusy();
  const problem = useProblem();
  const form = useRef<HTMLFormElement>(null);
  const decide = (approve: boolean) =>
    run(async () => {
      problem.clear();
      const r = await api<{ redirect: string }>(
        'POST',
        '/api/mcp/authorize',
        approve ? { request, approve, name, scopes, expiry } : { request, approve }
      );
      if (r.ok) return window.location.assign(r.data.redirect);
      if (r.data?.error === 'request_expired' || !approve)
        return problem.show('This sign-in request expired. Start again from the app.');
      problem.show(r.data, null, form.current);
    });
  return (
    <section className="agent-content connect-request">
      <p className="kicker">Sign-in request</p>
      <h1>{info.client_name} wants to sign in</h1>
      <p className="hint">
        Signed in as {email}. The app supplied this name; allow it only if you started this from the app.
      </p>
      <p>
        Allowing makes it an API token, like one you make in Settings. It lasts until it expires, you revoke it under
        API tokens, or the app signs out.
      </p>
      <form
        ref={form}
        className="stack tight"
        onSubmit={(e) => {
          e.preventDefault();
          void decide(true);
        }}
      >
        <label>
          Name
          <input
            name="token-name"
            value={name}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="scopes">
          <legend>It may</legend>
          {asked.map(([scope, said]) => (
            <label className="check" key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                disabled={scope === 'media:write' && !scopes.includes('notes:write')}
                onChange={(e) =>
                  setScopes((now) =>
                    e.target.checked
                      ? [...now, scope]
                      : now.filter((s) => s !== scope && !(scope === 'notes:write' && s === 'media:write'))
                  )
                }
              />{' '}
              {said}
            </label>
          ))}
        </fieldset>
        <label>
          Expires
          <select name="token-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY.map(([value, said]) => (
              <option key={value} value={value}>
                {said}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          Every token reads your version, today’s date and your tags. Notes it adds are yours, shown “via” its name. No
          token reads your notes.
        </p>
        <div className="row">
          <button className="go" type="submit" disabled={busy || !scopes.length}>
            Allow
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={() => decide(false)}>
            Cancel
          </button>
        </div>
      </form>
      <ErrorLine line={problem.line} />
    </section>
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
