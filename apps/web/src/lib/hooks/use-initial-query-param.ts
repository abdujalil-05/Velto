import { useEffect, useState } from 'react';

/**
 * Reads a single `?key=value` query param once, right after mount, as the
 * initial value for a piece of local filter state (deep-linking, e.g. the
 * agents/couriers list "N routes" link into `/routes?agentId=...`).
 * Deliberately not `next/navigation`'s `useSearchParams` — that forces every
 * page that calls it into a Suspense boundary at build time; these filter
 * pages are plain client-rendered local state, so a one-time
 * `window.location.search` read is enough. Starts at `''` on both server and
 * client renders (so hydration matches) and syncs from the URL in an effect
 * right after mount — callers that render a list based on this value should
 * already handle the "no filter yet" state as a normal loading frame.
 */
export function useInitialQueryParam(key: string): string {
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(new URLSearchParams(window.location.search).get(key) ?? '');
    // `key` is expected to be a stable literal per call site, so this only ever
    // runs once on mount in practice, despite depending on `key` for correctness.
  }, [key]);
  return value;
}
