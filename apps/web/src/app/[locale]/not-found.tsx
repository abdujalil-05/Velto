import { useTranslations } from 'next-intl';
import { FileQuestion } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// 9.1: barcha matnlar next-intl orqali (uz/ru/en) — bu sahifa `notFound()`
// chaqirilganda va `[locale]/[...rest]` catch-all yo'nalishida ko'rsatiladi.
export default function LocaleNotFoundPage() {
  const t = useTranslations('NotFound');

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <FileQuestion className="h-6 w-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link href="/" className={cn(buttonVariants({ size: 'lg' }))}>
            {t('backHome')}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
