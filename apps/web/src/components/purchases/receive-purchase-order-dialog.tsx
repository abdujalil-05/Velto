'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatQty } from '@/lib/format';
import type { PurchaseOrder } from '@/lib/api/purchase-orders';

interface ReceivePurchaseOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchaseOrder: PurchaseOrder;
  isSubmitting: boolean;
  onConfirm: (lines: { purchaseOrderLineId: string; qty: number }[]) => void;
}

export function ReceivePurchaseOrderDialog({ open, onOpenChange, purchaseOrder, isSubmitting, onConfirm }: ReceivePurchaseOrderDialogProps) {
  const t = useTranslations('Purchases.receiveDialog');
  const tCommon = useTranslations('Common');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const pendingLines = useMemo(
    () => purchaseOrder.lines.filter((l) => Number(l.qtyReceived) < Number(l.qty)),
    [purchaseOrder.lines],
  );

  function handleConfirm() {
    const lines = Object.entries(amounts)
      .filter(([, v]) => Number(v) > 0)
      .map(([purchaseOrderLineId, v]) => ({ purchaseOrderLineId, qty: Number(v) }));
    if (lines.length === 0) {
      setError(t('enterAtLeastOne'));
      return;
    }
    setError(null);
    onConfirm(lines);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {pendingLines.map((line) => {
            const remaining = Number(line.qty) - Number(line.qtyReceived);
            return (
              <div key={line.id} className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{line.product.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('remaining')}: {formatQty(remaining)} {line.product.baseUnit}
                  </p>
                </div>
                <Input
                  type="number"
                  min={0}
                  max={remaining}
                  step="0.001"
                  className="w-32"
                  value={amounts[line.id] ?? ''}
                  onChange={(e) => setAmounts((prev) => ({ ...prev, [line.id]: e.target.value }))}
                />
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
