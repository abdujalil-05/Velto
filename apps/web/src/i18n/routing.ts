import { defineRouting } from 'next-intl/routing';

// 9.1/14.6: uch til — o'zbek (lotin), rus, ingliz — hech bir matn kodda
// qattiq yozilmaydi. Uzbek Cyrillic is [v1.2], not enabled here.
export const routing = defineRouting({
  locales: ['uz', 'ru', 'en'],
  defaultLocale: 'uz',
});

export type Locale = (typeof routing.locales)[number];
