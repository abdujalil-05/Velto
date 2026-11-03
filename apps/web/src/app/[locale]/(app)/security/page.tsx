'use client';

import { useTranslations } from 'next-intl';
import { SecurityCards } from '@/components/auth/security-cards';

export default function SecurityPage() {
  const t = useTranslations('Security');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <SecurityCards />
    </div>
  );
}
