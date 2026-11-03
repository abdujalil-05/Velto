'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const MAX_NOTE = 500;

interface HandoverOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (note?: string) => void;
  isSubmitting: boolean;
}

export function HandoverOrderDialog({ open, onOpenChange, onConfirm, isSubmitting }: HandoverOrderDialogProps) {
  const t = useTranslations('Orders.detail');
  const tCommon = useTranslations('Common');
  const [note, setNote] = useState('');
  const trimmed = note.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('handoverTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('handoverHint')}</p>
        <div className="space-y-2">
          <Label htmlFor="handoverNote">{t('handoverNote')}</Label>
          <Textarea id="handoverNote" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {tCommon('cancel')}
          </Button>
          <Button disabled={isSubmitting} onClick={() => onConfirm(trimmed || undefined)}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('handoverConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
