'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/auth-context';
import { isCourierOnly } from '@/lib/auth/roles';
import { SyncStatusBadge } from '@/components/shared/sync-status-badge';
import { TelegramFallback } from '@/components/telegram-fallback';
import { Button } from '@/components/ui/button';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, status, linkPhone, linking } = useAuth();
  const t = useTranslations('Auth');
  // No sync engine is mounted for a courier-only session (see OfflineLayer in
  // components/providers.tsx), and there is nothing queued to report either.
  const courierOnly = isCourierOnly(user?.roles);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Neither a stored session nor Telegram initData — this device was never
  // authenticated and isn't inside Telegram right now. There is no
  // phone/password login screen here (9.4: agent identity is Telegram
  // identity, 15.2) — the only way in is the bot's Mini App button/link, so
  // the fallback's job is to hand the agent that link rather than to explain
  // a login they cannot perform here. This used to be a single line of muted
  // text on an otherwise empty page, which on a phone reads as a blank screen.
  if (status === 'no-telegram-context' || status === 'unauthenticated') {
    return <TelegramFallback reason={status} />;
  }

  // Valid Telegram identity, but no admin-created User.phone matches it yet
  // — share the phone Telegram already knows so the backend can link it.
  if (status === 'needs-phone-link') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-xs text-sm text-muted-foreground">{t('needsPhoneLink')}</p>
        <Button onClick={() => linkPhone()} disabled={linking}>
          {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sharePhone')}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">Velto</span>
        {!courierOnly && <SyncStatusBadge />}
      </header>
      <main className="flex-1 p-4">{children}</main>
    </div>
  );
}
