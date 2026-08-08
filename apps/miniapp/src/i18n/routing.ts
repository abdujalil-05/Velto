import { defineRouting } from 'next-intl/routing';

// 9.1/14.6: uch til — o'zbek (lotin), rus, ingliz — hech bir matn kodda
// qattiq yozilmaydi. Same locale set as apps/web.
export const routing = defineRouting({
  locales: ['uz', 'ru', 'en'],
  defaultLocale: 'uz',
});

export type Locale = (typeof routing.locales)[number];
