'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Bell, CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
  useUnreadCountQuery,
  type AppNotification,
} from '@/lib/api/notifications';
import { errorMessage } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import type { LocalizedMessage } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

function pick(message: LocalizedMessage, locale: string): string {
  return message[locale as keyof LocalizedMessage] || message.uz;
}

export function NotificationBell() {
  const t = useTranslations('Notifications');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const unread = useUnreadCountQuery();
  const list = useNotificationsQuery({ page: 1, pageSize: 20, unreadOnly }, open);
  const markRead = useMarkNotificationReadMutation();
  const markAll = useMarkAllNotificationsReadMutation();
  const count = unread.data?.count ?? 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  function handleItem(n: AppNotification) {
    if (n.readAt) return;
    markRead.mutate(n.id, { onError: (err) => toast.error(errorMessage(err, locale)) });
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label={count > 0 ? t('bellWithCount', { count }) : t('bell')}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label={t('title')}
          className="fixed inset-x-2 top-14 z-50 rounded-md border border-border bg-card shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border p-3">
            <h2 className="text-sm font-semibold">{t('title')}</h2>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setUnreadOnly((v) => !v)} aria-pressed={unreadOnly}>
                {t('unreadOnly')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={count === 0 || markAll.isPending}
                onClick={() => markAll.mutate(undefined, { onError: (err) => toast.error(errorMessage(err, locale)) })}
              >
                <CheckCheck className="mr-1 h-4 w-4" aria-hidden="true" />
                {t('markAllRead')}
              </Button>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {list.isLoading && (
              <div className="space-y-2 p-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            )}
            {list.isError && (
              <div className="flex items-center justify-between gap-3 p-3 text-sm text-destructive" role="alert">
                <span>{errorMessage(list.error, locale)}</span>
                <Button variant="outline" size="sm" onClick={() => list.refetch()}>
                  {t('retry')}
                </Button>
              </div>
            )}
            {list.data && list.data.data.length === 0 && (
              <p className="p-6 text-center text-sm text-muted-foreground">{unreadOnly ? t('emptyUnread') : t('empty')}</p>
            )}
            {list.data && list.data.data.length > 0 && (
              <ul className="divide-y divide-border">
                {list.data.data.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => handleItem(n)}
                      className={cn('flex w-full gap-2 p-3 text-left hover:bg-accent', !n.readAt && 'bg-accent/40')}
                    >
                      <span
                        className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-sm', !n.readAt && 'font-semibold')}>
                          {!n.readAt && <span className="sr-only">{t('unread')}: </span>}
                          {pick(n.title, locale)}
                        </span>
                        <span className="block text-xs text-muted-foreground">{pick(n.message, locale)}</span>
                        <span className="mt-1 block text-[11px] text-muted-foreground">{formatDateTime(n.createdAt, locale)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
