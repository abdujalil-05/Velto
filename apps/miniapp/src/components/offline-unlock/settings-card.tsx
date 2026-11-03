'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth/auth-context';
import { getOfflineSession } from '@/lib/offline/session';
import { isLocalMode } from '@/lib/offline/local-mode';
import { offlineUnlockSupported } from '@/lib/offline/unlock/capabilities';
import { changePassphrase, deleteEntry, enrollOfflineUnlock, getEntryMeta } from '@/lib/offline/unlock/entry';
import { validatePassphrase } from '@/lib/offline/unlock/policy';

/** Settings: enable / change / disable Offline Unlock (ADR-071). Hidden entirely when the device lacks a required capability. */
export function OfflineUnlockSettings() {
  const t = useTranslations('OfflineUnlock');
  const locale = useLocale();
  const { user, status } = useAuth();
  const [meta, setMeta] = useState<{ lastOnlineAt: number } | null>(null);
  const [mode, setMode] = useState<'idle' | 'enable' | 'change'>('idle');
  const [oldPass, setOldPass] = useState('');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const supported = offlineUnlockSupported();

  const reload = useCallback(async () => {
    const o = getOfflineSession();
    setMeta(o ? await getEntryMeta(o) : null);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (!supported || !user) return null;
  const online = status === 'authenticated' && !isLocalMode();

  const reset = () => {
    setMode('idle');
    setOldPass('');
    setPass('');
    setConfirm('');
    setIssues([]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const owner = getOfflineSession();
    if (!owner) return;
    const found = validatePassphrase(pass, { firstName: user.firstName, lastName: user.lastName }, confirm);
    if (found.length) return setIssues(found.map((i) => t(`issue_${i}`)));
    setBusy(true);
    try {
      const r = mode === 'change' ? await changePassphrase(owner, user, oldPass, pass, confirm) : await enrollOfflineUnlock(owner, user, pass, confirm);
      if (r.kind === 'ok') {
        toast.success(mode === 'change' ? t('changed') : t('enabled'));
        reset();
        await reload();
      } else if (r.kind === 'wrong-old') setIssues([t('wrongOld')]);
      else if (r.kind === 'vault-not-ready' || r.kind === 'offline-mode') setIssues([t('needOnline')]);
      else if (r.kind === 'weak') setIssues(r.issues.map((i) => t(`issue_${i}`)));
      else setIssues([t('saveFailed')]);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    await deleteEntry(getOfflineSession());
    toast.success(t('disabled'));
    await reload();
  };

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <h2 className="text-sm font-semibold">{t('settingsTitle')}</h2>
      <p className="text-xs text-muted-foreground">{t('settingsBody')}</p>
      <p className="text-xs">
        {meta ? t('statusOn') : t('statusOff')}
        {meta && <> · {t('lastOnline', { date: new Date(meta.lastOnlineAt).toLocaleString(locale) })}</>}
      </p>
      {!online && <p className="text-xs text-muted-foreground">{t('needOnline')}</p>}
      {online && mode === 'idle' && (
        <div className="flex gap-2">
          {!meta ? (
            <Button size="sm" onClick={() => setMode('enable')}>{t('enable')}</Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setMode('change')}>{t('change')}</Button>
              <Button size="sm" variant="outline" onClick={disable}>{t('disable')}</Button>
            </>
          )}
        </div>
      )}
      {online && mode !== 'idle' && (
        <form onSubmit={submit} className="space-y-2">
          {mode === 'change' && <Input type="password" autoComplete="off" placeholder={t('oldPassphrase')} value={oldPass} onChange={(e) => setOldPass(e.target.value)} />}
          <Input type="password" autoComplete="new-password" placeholder={mode === 'change' ? t('newPassphrase') : t('passphrase')} value={pass} onChange={(e) => setPass(e.target.value)} />
          <Input type="password" autoComplete="new-password" placeholder={t('confirm')} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {issues.length > 0 && (
            <ul role="alert" className="list-disc pl-4 text-xs text-destructive">
              {issues.map((i) => <li key={i}>{i}</li>)}
            </ul>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>{mode === 'change' ? t('change') : t('enable')}</Button>
            <Button type="button" size="sm" variant="outline" onClick={reset}>×</Button>
          </div>
        </form>
      )}
    </section>
  );
}
