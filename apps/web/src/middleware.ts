import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

// Root-cause note (blank page at the deployment's entry URL, `${basePath}/`):
//
// Next compiles each matcher entry into a regexp that requires `basePath`
// (here `/velto`, see next.config.mjs) as a hard literal prefix. A bare
// catch-all like `'/((?!api|trpc|_next|_vercel|.*\\..*).*)'` compiles to
// (simplified):
//   ^/velto(?:/(_next/data/...))?(?:/((?!api|...).*))(\.json|...)?[/#?]?$
// — the second group is NOT optional: it demands a literal `/` followed by
// the capture. Next normalizes the trailing slash away before testing the
// matcher (independently of `skipTrailingSlashRedirect`, which only governs
// the *HTTP* redirect), so the path actually tested is `/velto` for both
// `/velto` and `/velto/`. That fails the mandatory-`/`-plus-capture group
// above, and the result is that middleware is silently never
// invoked at the app's own root, next-intl never runs, and the request falls
// through to the App Router with no matching page (there is no
// `src/app/page.tsx` — only `[locale]/page.tsx`), producing an empty 200 with
// no Content-Type. `/velto/uz` was never affected: it has content after the
// prefix.
//
// Fix: an explicit `'/'` matcher entry. Next compiles `'/'` on its own —
// independent of the catch-all's exclusion groups — into a regexp where
// everything after the basePath prefix is optional, so it matches `/velto`,
// `/velto/` and any basePath-normalized variant of the root. It does not
// weaken the `(?!api|trpc|_next|_vercel|...)` exclusions for any other path;
// it only covers the one path the catch-all group cannot express.
//
// Verified against a production build behind the real nginx: `/velto` and
// `/velto/` both 307 to the negotiated locale (`Accept-Language: ru` ->
// `/velto/ru`), `/velto/uz` still 200. apps/miniapp carries the identical
// fix for the same reason — keep the two in sync.
export const config = {
  matcher: ['/', '/((?!api|trpc|_next|_vercel|.*\\..*).*)'],
};
