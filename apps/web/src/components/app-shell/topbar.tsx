'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LogOut, Menu, X } from 'lucide-react';
import { Link, usePathname } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { useAuth } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, isNavItemActive } from './nav-config';

export function Topbar() {
  const t = useTranslations('Nav');
  const tShell = useTranslations('AppShell');
  const pathname = usePathname();
  const { user, hasPermission, logout } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!mobileNavOpen) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileNavOpen]);

  const items = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));
  const roleLabel = user?.roles[0] ? tShell(`roles.${user.roles[0]}`) : '';

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-card">
      <div className="flex h-14 items-center gap-3 px-4">
        <button
          type="button"
          className="rounded-md p-2 text-muted-foreground hover:bg-accent md:hidden"
          onClick={() => setMobileNavOpen((v) => !v)}
          aria-label={tShell('toggleMenu')}
        >
          {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>

        <div className="flex-1" />

        <ThemeToggle />
        <LanguageSwitcher />

        {user && (
          <div className="hidden items-center gap-2 border-l border-border pl-3 sm:flex">
            <div className="text-right leading-tight">
              <p className="text-sm font-medium">
                {user.firstName} {user.lastName}
              </p>
              <p className="text-xs text-muted-foreground">{roleLabel}</p>
            </div>
          </div>
        )}

        <Button variant="ghost" size="icon" onClick={() => logout()} aria-label={tShell('logout')} title={tShell('logout')}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      {mobileNavOpen && (
        <nav
          className="fixed inset-x-0 bottom-0 top-14 z-50 flex flex-col gap-1 overflow-y-auto bg-card p-2 md:hidden"
          aria-modal="true"
          role="dialog"
        >
          {items.map((item) => {
            const Icon = item.icon;
            const active = isNavItemActive(pathname, item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                onClick={() => setMobileNavOpen(false)}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
                  active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                <Icon className="h-4 w-4" />
                {t(item.key)}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
