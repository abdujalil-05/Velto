'use client';

import { useState } from 'react';
import { Loader2, Lock, WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth/auth-context';

/**
 * Shown for status 'offline-locked' (ADR-071): stored tokens, no network. With an Offline Unlock entry -> passphrase form;
 * without -> an honest "no network, offline access not enabled" message (NOT "session expired").
 */
export function OfflineUnlockScreen() {
  const t = useTranslations('OfflineUnlock');
  const { offlineUnlockAvailable, unlockOffline } = useAuth();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await unlockOffline(pass);
      if (r.kind === 'wrong') setMsg(t('wrong', { count: r.remaining }));
      else if (r.kind === 'backoff') setMsg(t('backoff', { seconds: Math.max(1, Math.ceil((r.retryAt - Date.now()) / 1000)) }));
      else if (r.kind === 'expired') setMsg(t('expired'));
      else if (r.kind === 'device-error') setMsg(t('deviceError'));
      else if (r.kind === 'wiped') setMsg(t('wiped'));
      else if (r.kind === 'unsupported') setMsg(t('unsupported'));
      else if (r.kind !== 'ok') setMsg(t('error'));
      if (r.kind === 'ok') setPass('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        {offlineUnlockAvailable ? <Lock className="h-7 w-7" aria-hidden /> : <WifiOff className="h-7 w-7" aria-hidden />}
      </div>
      {offlineUnlockAvailable ? (
        <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
          <h1 className="text-base font-semibold">{t('unlockTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('unlockHint')}</p>
          <Input type="password" autoComplete="off" aria-label={t('passphrase')} placeholder={t('passphrase')} value={pass} onChange={(e) => setPass(e.target.value)} />
          {msg && <p role="alert" className="text-sm text-destructive">{msg}</p>}
          <Button type="submit" size="lg" disabled={busy || pass.length === 0}>
            {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t('unlocking')}</> : t('unlock')}
          </Button>
        </form>
      ) : (
        <div className="space-y-2">
          <h1 className="text-base font-semibold">{t('noEntryTitle')}</h1>
          <p className="max-w-xs text-sm text-muted-foreground">{t('noEntryBody')}</p>
        </div>
      )}
      <Button variant="outline" size="lg" className="w-full max-w-xs" onClick={() => window.location.reload()}>
        {t('retry')}
      </Button>
    </div>
  );
}
