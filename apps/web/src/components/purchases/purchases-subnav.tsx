'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export function PurchasesSubnav() {
  const t = useTranslations('Purchases');
  const pathname = usePathname();
  const tabs = [
    { href: '/purchases', label: t('tabOrders'), active: pathname === '/purchases' || pathname.startsWith('/purchases/new') },
    { href: '/purchases/receipts', label: t('tabReceipts'), active: pathname.startsWith('/purchases/receipts') },
    { href: '/purchases/suppliers', label: t('tabSuppliers'), active: pathname.startsWith('/purchases/suppliers') },
  ];
  return (
    <nav className="flex gap-1 border-b border-border" aria-label={t('title')}>
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={cn(
            'inline-flex min-h-12 items-center border-b-2 px-4 text-sm font-medium',
            tab.active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
