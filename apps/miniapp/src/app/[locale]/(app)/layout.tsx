'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/auth-context';
import { SyncStatusBadge } from '@/components/shared/sync-status-badge';
import { Button } from '@/components/ui/button';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, linkPhone, linking } = useAuth();
  const t = useTranslations('Auth');

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
  // identity, 15.2) — the only way in is the bot's Mini App button/link.
  if (status === 'no-telegram-context' || status === 'unauthenticated') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-xs text-sm text-muted-foreground">{t('openViaTelegram')}</p>
      </div>
    );
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
        <SyncStatusBadge />
      </header>
      <main className="flex-1 p-4">{children}</main>
    </div>
  );
}
