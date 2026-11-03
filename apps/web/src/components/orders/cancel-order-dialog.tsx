'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const MIN_REASON = 3;
const MAX_REASON = 500;

interface CancelOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isSubmitting: boolean;
  /** Namespace key prefix for strings; defaults to the cancel flow. */
  variant?: 'cancel' | 'return';
}

export function CancelOrderDialog({ open, onOpenChange, onConfirm, isSubmitting, variant = 'cancel' }: CancelOrderDialogProps) {
  const t = useTranslations('Orders.detail');
  const tReverse = useTranslations('Common.reverse');
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const invalid = trimmed.length < MIN_REASON || trimmed.length > MAX_REASON;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(variant === 'return' ? 'returnTitle' : 'cancelTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancelReason">{t('cancelReasonLabel')}</Label>
          <Textarea
            id="cancelReason"
            value={reason}
            maxLength={MAX_REASON}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={reason.length > 0 && invalid}
            autoFocus
          />
          <p className={reason.length > 0 && invalid ? 'flex items-center gap-1 text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {reason.length > 0 && invalid && <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />}
            {tReverse('reasonHint', { min: MIN_REASON, max: MAX_REASON })}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t(variant === 'return' ? 'returnKeep' : 'cancelKeep')}
          </Button>
          <Button variant={variant === 'return' ? 'default' : 'destructive'} disabled={isSubmitting || invalid} onClick={() => onConfirm(trimmed)}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t(variant === 'return' ? 'returnConfirm' : 'cancelConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
