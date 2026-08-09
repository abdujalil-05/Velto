'use client';

/**
 * Last-resort boundary for a throw in the root layout itself (locale
 * resolution, next-intl message loading) — at that point no provider has
 * mounted, so this cannot use next-intl's `useTranslations` and must render
 * its own `<html>`/`<body>`. Hence the hardcoded strings here: they are the
 * one place in the app where a translation lookup is not available by
 * construction (the failure may be the translation layer itself). All three
 * locales are shown rather than picking one.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="uz">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          padding: '24px',
          textAlign: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#ffffff',
          color: '#111827',
        }}
      >
        <h1 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>Velto</h1>
        <p style={{ fontSize: '14px', color: '#6b7280', maxWidth: '20rem', margin: 0 }}>
          Ilovani ochib bo&apos;lmadi. / Не удалось открыть приложение. / The app failed to load.
        </p>
        <button
          onClick={reset}
          style={{
            minHeight: '48px',
            padding: '0 32px',
            borderRadius: '6px',
            border: 'none',
            background: '#2563eb',
            color: '#ffffff',
            fontSize: '14px',
            fontWeight: 500,
          }}
        >
          Qayta urinish / Повторить / Retry
        </button>
        {error.digest ? (
          <p style={{ fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace', margin: 0 }}>{error.digest}</p>
        ) : null}
      </body>
    </html>
  );
}
