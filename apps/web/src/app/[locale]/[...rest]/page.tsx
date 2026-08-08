import { notFound } from 'next/navigation';

// Locale prefiksli, lekin mavjud bo'lmagan yo'llar (masalan `/uz/ordersx`)
// root `app/not-found.tsx` emas, tarjimali `[locale]/not-found.tsx` sahifasiga
// tushishi uchun catch-all — next-intl'ning tavsiya etilgan usuli.
export default function CatchAllPage(): never {
  notFound();
}
