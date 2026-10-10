// Moving between pages, and the profile most pages start from.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { ApiError } from './api.ts';
import { meQuery } from './queries.ts';
import { home, store } from './storage.ts';

// To another page in place of this one (location.replace): nothing to come
// back to with Back.
export function useGo() {
  const navigate = useNavigate();
  return useCallback((href: string) => navigate({ href, replace: true }), [navigate]);
}

// After signing in or out, nothing fetched for the last session is kept.
export function useSignedInAs() {
  const client = useQueryClient();
  const go = useGo();
  return useCallback(
    (href: string) => {
      client.clear();
      return go(href);
    },
    [client, go]
  );
}

// The profile. The gate (main.tsx) has it before a signed-in page shows;
// this follows it after, when it is fetched again: someone signed in
// without one yet goes to setup, and a session that ran out to sign in.
export function useMe() {
  const me = useQuery(meQuery);
  const go = useGo();
  const isNew = !!me.data?.new;
  const signedOut = me.error instanceof ApiError && me.error.answer.status === 401;
  useEffect(() => {
    if (isNew) go(home(true));
    else if (signedOut) {
      store.set('rn-back', location.pathname + location.search);
      go('/#sign-in');
    }
  }, [isNew, signedOut, go]);
  return me;
}

// The address's ?query as plain strings, and its #hash.
export function useQueryParam(name: string): string | null {
  return useLocation({ select: (l) => new URLSearchParams(l.searchStr).get(name) });
}

export function useHashParam(name: string): string | null {
  return useLocation({ select: (l) => new URLSearchParams(l.hash).get(name) });
}
