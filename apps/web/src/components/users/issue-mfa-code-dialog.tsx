'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Copy, Loader2 } from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import { useIssueMfaEnrollmentCodeMutation } from '@/lib/api/mfa';
import type { User } from '@/lib/api/users';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface IssueMfaCodeDialogProps {
  user: User | null;
  onClose: () => void;
}

export function IssueMfaCodeDialog({ user, onClose }: IssueMfaCodeDialogProps) {
  const t = useTranslations('Users.mfaCode');
  const locale = useLocale();
  const mutation = useIssueMfaEnrollmentCodeMutation();
  // Held in component state only, dropped on close; the one-time code is never persisted.
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function close() {
    setIssued(null);
    setError(null);
    setCopied(false);
    mutation.reset();
    onClose();
  }

  async function issue() {
    if (!user) return;
    setError(null);
    try {
      setIssued(await mutation.mutateAsync({ id: user.id }));
    } catch (err) {
      setError(errorMessage(err, locale));
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const name = user ? `${user.firstName} ${user.lastName}` : '';

  return (
    <Dialog open={user !== null} onOpenChange={(open) => (!open && !mutation.isPending ? close() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        {issued ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('shownOnce', { name })}</p>
            <div className="flex gap-2">
              <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-center font-mono text-lg tracking-widest">
                {issued.code}
              </code>
              <Button type="button" variant="outline" onClick={copy} aria-label={t('copy')}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-sm">{t('expires', { at: new Date(issued.expiresAt).toLocaleString(locale) })}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('description', { name })}</p>
        )}
        {error && (
          <Alert variant="destructive" className="mt-4" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={mutation.isPending}>
            {t('close')}
          </Button>
          {!issued && (
            <Button onClick={issue} disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {error ? t('retry') : t('issue')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
