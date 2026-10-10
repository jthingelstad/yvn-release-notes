// Moving between pages, and the profile most pages start from.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { get } from './api.ts';
import { home } from './storage.ts';
import type { Me } from './types.ts';

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

// The profile. Someone signed in without one yet goes to setup.
export function useMe() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me') });
  const go = useGo();
  const isNew = !!me.data?.new;
  useEffect(() => {
    if (isNew) go(home(true));
  }, [isNew, go]);
  return me;
}

// The address's ?query as plain strings, and its #hash.
export function useQueryParam(name: string): string | null {
  return useLocation({ select: (l) => new URLSearchParams(l.searchStr).get(name) });
}

export function useHashParam(name: string): string | null {
  return useLocation({ select: (l) => new URLSearchParams(l.hash).get(name) });
}
