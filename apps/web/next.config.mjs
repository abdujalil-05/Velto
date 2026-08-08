import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const isDev = process.env.NODE_ENV !== 'production';

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
      `connect-src 'self' ${apiUrl}`,
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
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
