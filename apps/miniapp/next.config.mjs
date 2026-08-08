import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const isDev = process.env.NODE_ENV !== 'production';

// SEC-040..048: CSP/HSTS. Unlike apps/web, this app is *meant* to be
// embedded — Telegram's web client (web.telegram.org) iframes Mini Apps —
// so no X-Frame-Options and frame-ancestors allows that origin instead of
// denying it. script-src must allow https://telegram.org: the app's own
// layout loads Telegram's WebApp bridge script from there
// (src/app/[locale]/layout.tsx), and without it window.Telegram never
// exists, breaking the initData auth flow entirely. 'unsafe-inline' is for
// the App Router's un-nonced RSC hydration payload, same as apps/web.
// 'unsafe-eval' is added in dev only — Next's dev-mode webpack runtime
// (HMR/React Refresh) evals module code; the production build doesn't.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // https://api-maps.yandex.ru/yastatic.net: the Yandex Maps JS SDK
      // (components/shared/yandex-map.tsx) — script-loaded only when
      // NEXT_PUBLIC_YANDEX_MAPS_API_KEY is set.
      `script-src 'self' 'unsafe-inline' https://telegram.org https://api-maps.yandex.ru https://yastatic.net${isDev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline' https://yastatic.net",
      `connect-src 'self' ${apiUrl} https://api-maps.yandex.ru https://*.maps.yandex.net https://*.maps.yandex.ru`,
      // Product images come from whatever S3-compatible endpoint this
      // deployment configured (S3_ENDPOINT) — not knowable at build time.
      "img-src 'self' data: https: http:",
      "font-src 'self' data: https://yastatic.net",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors https://web.telegram.org",
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
