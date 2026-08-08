'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface CancelOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string | undefined) => void;
  isSubmitting: boolean;
}

export function CancelOrderDialog({ open, onOpenChange, onConfirm, isSubmitting }: CancelOrderDialogProps) {
  const t = useTranslations('Orders.detail');
  const [reason, setReason] = useState('');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('cancelTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancelReason">{t('cancelReasonLabel')}</Label>
          <Textarea id="cancelReason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('cancelKeep')}
          </Button>
          <Button variant="destructive" disabled={isSubmitting} onClick={() => onConfirm(reason.trim() || undefined)}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('cancelConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
