import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

// Root-cause note (blank page at the Telegram menu-button entry URL, i.e.
// `${basePath}/` — the single most important URL in this app):
//
// Next compiles each matcher entry into a regexp that requires the
// `basePath` (here `/velto/app`, see next.config.mjs) as a hard literal
// prefix. For a bare catch-all like `'/((?!api|trpc|_next|_vercel|.*\\..*).*)'`
// that compiles to (simplified):
//   ^/velto/app(?:/(_next/data/...))?(?:/((?!api|...).*))(\.json|...)?[/#?]?$
// — note the second group is NOT optional: it demands a literal `/`
// followed by the capture. With `skipTrailingSlashRedirect: true` (needed so
// Next doesn't fight nginx's `/velto/app` -> `/velto/app/` 301, see
// next.config.mjs), Next still normalizes the trailing slash away for its
// *internal* matcher test even though it skips the *HTTP* redirect — so the
// path actually tested is `/velto/app`, not `/velto/app/`. That fails the
// mandatory-`/`-plus-capture group above for BOTH `/velto/app` and
// `/velto/app/`: middleware is silently never invoked for the app's own
// root, next-intl never runs, and the request falls through to the App
// Router with no matching page (no `src/app/page.tsx` — only
// `[locale]/page.tsx` exists) -> an empty 200 with no Content-Type.
// `/velto/app/uz` was unaffected because it has content after the prefix.
//
// Fix: add an explicit `'/'` matcher entry. Next compiles `'/'` on its own
// (independent of the catch-all's exclusion groups) to a regexp where
// everything after the basePath prefix is optional, so it matches
// `/velto/app`, `/velto/app/`, and any basePath-normalized variant of the
// root — verified via the compiled `.next/server/middleware-manifest.json`
// regexp and live curl against `next start`, see PR/task notes. This does
// not weaken the `(?!api|trpc|_next|_vercel|...)` exclusions for any other
// path; it only plugs the one path the catch-all group can't express.
export const config = {
  matcher: ['/', '/((?!api|trpc|_next|_vercel|.*\\..*).*)'],
};
