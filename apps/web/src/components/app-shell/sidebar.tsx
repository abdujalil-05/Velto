'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, isNavItemActive } from './nav-config';

export function Sidebar() {
  const t = useTranslations('Nav');
  const pathname = usePathname();
  const { hasPermission } = useAuth();

  const items = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));

  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-card md:flex md:flex-col">
      <div className="flex h-14 items-center px-4 text-lg font-semibold text-primary">Velto</div>
      <nav className="flex flex-1 flex-col gap-1 px-2 py-2">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isNavItemActive(pathname, item.href);
          return (
            <Link
              key={item.key}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              {t(item.key)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
