'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import { useResetUserMfaMutation } from '@/lib/api/mfa';
import type { User } from '@/lib/api/users';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface ResetMfaDialogProps {
  user: User | null;
  onClose: () => void;
}

export function ResetMfaDialog({ user, onClose }: ResetMfaDialogProps) {
  const t = useTranslations('Users.mfaReset');
  const locale = useLocale();
  const mutation = useResetUserMfaMutation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function close() {
    setReason('');
    setError(null);
    onClose();
  }

  async function confirm() {
    if (!user) return;
    setError(null);
    try {
      await mutation.mutateAsync({ id: user.id, reason: reason.trim() });
      toast.success(t('success', { name: `${user.firstName} ${user.lastName}` }));
      close();
    } catch (err) {
      setError(errorMessage(err, locale));
    }
  }

  return (
    <Dialog open={user !== null} onOpenChange={(open) => (!open && !mutation.isPending ? close() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('description', { name: user ? `${user.firstName} ${user.lastName}` : '' })}
        </p>
        <div className="mt-4 space-y-2">
          <Label htmlFor="mfa-reset-reason">{t('reason')}</Label>
          <Textarea
            id="mfa-reset-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            disabled={mutation.isPending}
          />
        </div>
        {error && (
          <Alert variant="destructive" className="mt-4" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={mutation.isPending}>
            {t('cancel')}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={mutation.isPending || reason.trim().length === 0}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
