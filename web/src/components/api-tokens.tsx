// API tokens (docs/API.md, Tokens): the administrator's alone until they
// open to every subscriber. A token is shown once, as it is made; after that
// Settings knows only its name, scopes and dates.
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SettingsGroup } from './settings-group.tsx';
import { api, get } from '../lib/api.ts';
import { ErrorLine, Failed, Loading, useBusy, useProblem } from './common.tsx';

interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  created_at: number;
  expires_at: number | null;
  expired: boolean;
  last_used: number | null;
}
// What a token may be given today. Files (media:write) and Upcoming come
// with their phases.
const OFFERED: [string, string][] = [
  ['notes:write', 'Add notes, and change or delete the notes it adds'],
  ['activity', 'Read the activity log, without any words from it']
];
const EXPIRY: [string, string][] = [
  ['90d', '90 days'],
  ['1y', '1 year'],
  ['never', 'Never']
];
const day = (at: number) => new Date(at * 1000).toLocaleDateString();
const able = (scopes: string[]) =>
  OFFERED.filter(([s]) => scopes.includes(s))
    .map(([, said]) => said)
    .join('. ') || 'Read your version and tags';

export function ApiTokens() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['api-tokens'], queryFn: () => get<{ tokens: ApiToken[] }>('/api/tokens') });
  const [busy, run] = useBusy();
  const problem = useProblem();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['notes:write']);
  const [expiry, setExpiry] = useState('1y');
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);

  const make = () =>
    run(async () => {
      problem.clear();
      setCopied(false);
      const r = await api<{ token: string; name: string }>('POST', '/api/tokens', { name, scopes, expiry });
      if (!r.ok) return problem.show(r.data, null, form.current);
      setShown({ name: r.data.name, token: r.data.token });
      setName('');
      await client.invalidateQueries({ queryKey: ['api-tokens'] });
    });
  const revoke = (t: ApiToken) =>
    run(async () => {
      problem.clear();
      if (!window.confirm(`Revoke ${t.name}? Whatever uses it stops working at its next request.`)) return;
      const r = await api('DELETE', '/api/tokens/' + encodeURIComponent(t.id));
      if (!r.ok) return problem.show(r.data);
      if (shown?.name === t.name) setShown(null);
      await client.invalidateQueries({ queryKey: ['api-tokens'] });
    });
  const copy = async () => {
    problem.clear();
    try {
      await navigator.clipboard.writeText(shown?.token ?? '');
      setCopied(true);
    } catch {
      problem.show('Couldn’t copy it. Select the token and copy it from there.', copyButton.current);
    }
  };

  const count = list.data?.tokens.length ?? 0;
  return (
    <SettingsGroup
      id="api-tokens"
      title="API tokens"
      description={
        list.data ? (count ? `${count} ${count === 1 ? 'token' : 'tokens'}` : 'None yet') : 'Keys for apps and scripts'
      }
    >
      <p className="hint">
        A token lets an app or a script add notes as you, through the API at /v1. Only you see this for now.
      </p>
      {list.isPending && <Loading />}
      {list.isError && <Failed />}
      {shown && (
        <section className="section" id="token-shown">
          <h3>{shown.name}</h3>
          <p className="hint">Copy it now. This is the only time it is shown.</p>
          <p className="value" data-field="api-token">
            {shown.token}
          </p>
          <button type="button" ref={copyButton} onClick={copy}>
            Copy token
          </button>
          <p className="aside saved" role="status" hidden={!copied}>
            Copied.
          </p>
        </section>
      )}
      {list.data?.tokens.map((t) => (
        <div className="section" key={t.id}>
          <h3>{t.name}</h3>
          <p>{able(t.scopes)}.</p>
          <p className="hint">
            Made {day(t.created_at)}
            {t.last_used ? `. Last used ${day(t.last_used)}` : '. Not used yet'}
            {t.expired ? '. Expired' : t.expires_at ? `. Expires ${day(t.expires_at)}` : '. Never expires'}.
          </p>
          <button type="button" className="quiet" disabled={busy} onClick={() => revoke(t)}>
            Revoke {t.name}
          </button>
        </div>
      ))}
      <details className="settings-secondary" id="token-new">
        <summary>Make a token</summary>
        <form
          ref={form}
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            void make();
          }}
        >
          <label>
            Name
            <input
              name="token-name"
              value={name}
              maxLength={40}
              autoComplete="off"
              placeholder="Changelog on my iPhone"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset>
            <legend>It may</legend>
            {OFFERED.map(([scope, said]) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes((now) => (e.target.checked ? [...now, scope] : now.filter((s) => s !== scope)))
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
            Every token reads your version, today’s date and your tags. Notes it adds are yours, shown “via” its name.
            No token reads your notes.
          </p>
          <button type="submit" disabled={busy}>
            Make token
          </button>
        </form>
      </details>
      <ErrorLine line={problem.line} />
    </SettingsGroup>
  );
}
