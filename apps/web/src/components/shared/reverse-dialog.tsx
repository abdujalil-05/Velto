'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const MIN_REASON = 3;
const MAX_REASON = 500;

interface ReverseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Already-localised `ApiError` text. */
  error?: string | null;
  isPending?: boolean;
  onConfirm: (reason: string) => void;
  /** Overrides the default "Reverse" button label (e.g. handover reject). */
  confirmLabel?: string;
}

/** Confirmation + mandatory reason (3-500 chars, TZ F2.1) for payment / stock reversals. */
export function ReverseDialog({ open, onOpenChange, title, description, error, isPending = false, onConfirm, confirmLabel }: ReverseDialogProps) {
  const t = useTranslations('Common.reverse');
  const tCommon = useTranslations('Common');
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const invalid = trimmed.length < MIN_REASON || trimmed.length > MAX_REASON;

  return (
    <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="space-y-1">
          <Label htmlFor="reverseReason">{t('reason')}</Label>
          <Textarea
            id="reverseReason"
            value={reason}
            maxLength={MAX_REASON}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={reason.length > 0 && invalid}
          />
          <p className="text-xs text-muted-foreground">{t('reasonHint', { min: MIN_REASON, max: MAX_REASON })}</p>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {tCommon('cancel')}
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(trimmed)} disabled={isPending || invalid}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel ?? t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
