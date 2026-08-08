import { routing } from '@/i18n/routing';
import './globals.css';

// Locale segmenti aniqlanmagan holatlar uchun zaxira 404 (masalan middleware
// matcher'iga tushmaydigan yo'llar). Bu yerda NextIntlClientProvider yo'q, shu
// sababli matn uchta tilda statik yoziladi va havola default locale'ga boradi.
const MESSAGES = [
  { locale: 'uz', title: 'Bunday sahifa mavjud emas', action: 'Asosiy sahifaga qaytish' },
  { locale: 'ru', title: 'Такой страницы не существует', action: 'Вернуться на главную' },
  { locale: 'en', title: 'This page does not exist', action: 'Back to the main page' },
];

export default function RootNotFoundPage() {
  return (
    <html lang={routing.defaultLocale} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
          <div className="w-full max-w-md space-y-6 rounded-lg border bg-card p-6 text-center text-card-foreground shadow-sm">
            <p className="text-2xl font-semibold text-primary">Velto</p>
            <div className="space-y-2">
              {MESSAGES.map((message) => (
                <p key={message.locale} className="text-base text-muted-foreground">
                  {message.title}
                </p>
              ))}
            </div>
            <a
              href={`/${routing.defaultLocale}`}
              className="inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {MESSAGES[0].action}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
