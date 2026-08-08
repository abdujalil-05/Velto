import { notFound } from 'next/navigation';

// next-intl's middleware rewrites every non-file request under a locale
// prefix, so an unknown path (e.g. /uz/typo) reaches the App Router with a
// valid locale and no matching segment. Without this catch-all Next.js falls
// back to the framework's own root not-found, which renders outside the
// locale layout (no NextIntlClientProvider, no Telegram theming). Throwing
// notFound() here routes it to ./[locale]/not-found.tsx instead.
export default function CatchAllNotFound(): never {
  notFound();
}
