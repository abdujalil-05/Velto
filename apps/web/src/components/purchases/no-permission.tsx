import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export function NoPermission() {
  const t = useTranslations('Purchases');
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <Lock className="h-10 w-10 text-muted-foreground" />
        <p className="max-w-sm text-sm text-muted-foreground">{t('noPermission')}</p>
      </CardContent>
    </Card>
  );
}
