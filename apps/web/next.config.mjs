import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const isDev = process.env.NODE_ENV !== 'production';

// Path-prefix deployment (e.g. https://auto-message.uz/velto/, nginx proxies
// without stripping the prefix so Next itself must know about it). Empty
// string must NOT be passed to `basePath` — Next throws at boot — so fall
// back to undefined when unset, which keeps bare localhost dev unchanged.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// `apiUrl` is only a valid CSP source expression when it's an absolute URL.
// Under a basePath deployment it's set to a same-origin relative path (e.g.
// "/velto/api") so the browser/API share one origin behind the proxy — a
// path isn't a CSP source expression and `'self'` already covers it, so only
// append it here when it actually names another origin.
const isAbsoluteApiUrl = /^https?:\/\//.test(apiUrl);

// SEC-040..048: CSP/X-Frame-Options/HSTS. This is a standalone back-office
// dashboard (never embedded in another page, unlike apps/miniapp), so
// framing is denied outright. script-src needs 'unsafe-inline' because
// Next.js's App Router streams its RSC hydration payload as inline
// <script> tags with no nonce wired up — without it the app never
// hydrates (verified against the actual dev-server HTML output).
// 'unsafe-eval' is added in dev only — Next's dev-mode webpack runtime
// (HMR/React Refresh) evals module code; the production build doesn't.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self'${isAbsoluteApiUrl ? ` ${apiUrl}` : ''}`,
      // Product images come from whatever S3-compatible endpoint this
      // deployment configured (S3_ENDPOINT) — not knowable at build time.
      "img-src 'self' data: https: http:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  basePath: basePath || undefined,
  // Under a basePath, requesting the bare prefix (e.g. `/velto`, no trailing
  // slash) strips down to an empty pathname. nginx 301s `/velto` -> `/velto/`
  // for us; don't let Next's own trailing-slash redirect fight that (verified:
  // removing this flag makes Next 308-redirect `/velto/` -> `/velto`, which
  // loops forever against nginx's `/velto` -> `/velto/` 301 — do not remove).
  // NB: this flag is *not* the cause of the basePath-root blank-page bug (see
  // src/middleware.ts) — that reproduces identically with this flag removed.
  skipTrailingSlashRedirect: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
