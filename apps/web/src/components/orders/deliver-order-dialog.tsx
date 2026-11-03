'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatQty } from '@/lib/format';
import type { SalesOrderLine } from '@/lib/api/orders';

const QTY_PATTERN = /^\d{1,15}([.,]\d{1,3})?$/;

interface DeliverOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: SalesOrderLine[];
  /** `undefined` lines = full delivery (no request body). */
  onConfirm: (lines: { lineId: string; deliveredQty: string }[] | undefined) => void;
  isSubmitting: boolean;
}

// String-only comparison (no float math): normalises "5", "5.0", "5,000" to a canonical form.
function canon(v: string): string {
  const [i, f = ''] = v.replace(',', '.').split('.');
  const frac = f.replace(/0+$/, '');
  const int = i.replace(/^0+(?=\d)/, '');
  return frac ? `${int}.${frac}` : int;
}

function cmp(a: string, b: string): number {
  const [ai, af = ''] = canon(a).split('.');
  const [bi, bf = ''] = canon(b).split('.');
  if (ai.length !== bi.length) return ai.length - bi.length;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const w = Math.max(af.length, bf.length);
  const x = af.padEnd(w, '0');
  const y = bf.padEnd(w, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}

export function DeliverOrderDialog({ open, onOpenChange, lines, onConfirm, isSubmitting }: DeliverOrderDialogProps) {
  const t = useTranslations('Orders.detail');
  const [values, setValues] = useState<Record<string, string>>({});

  const valueOf = (l: SalesOrderLine) => values[l.id] ?? l.qty;
  const errorOf = (l: SalesOrderLine): 'invalid' | 'over' | null => {
    const v = valueOf(l).trim();
    if (!QTY_PATTERN.test(v)) return 'invalid';
    return cmp(v, l.qty) > 0 ? 'over' : null;
  };
  const hasError = lines.some((l) => errorOf(l) !== null);
  const allZero = !hasError && lines.every((l) => cmp(valueOf(l), '0') === 0);
  const differs = lines.some((l) => cmp(valueOf(l), l.qty) !== 0);

  function submit() {
    if (!differs) return onConfirm(undefined);
    onConfirm(lines.map((l) => ({ lineId: l.id, deliveredQty: canon(valueOf(l).trim()) })));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('deliverTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('deliverHint')}</p>
        <div className="max-h-[50vh] overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">{t('product')}</th>
                <th className="pb-2 pr-3 text-right font-medium">{t('qty')}</th>
                <th className="pb-2 font-medium">{t('deliveredQty')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((l) => {
                const err = errorOf(l);
                return (
                  <tr key={l.id}>
                    <td className="py-2 pr-3">{l.product.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatQty(l.qty)}</td>
                    <td className="py-2">
                      <Input
                        inputMode="decimal"
                        className="h-12 w-32"
                        value={valueOf(l)}
                        aria-invalid={err !== null}
                        aria-label={`${t('deliveredQty')}: ${l.product.name}`}
                        onChange={(e) => setValues((p) => ({ ...p, [l.id]: e.target.value }))}
                      />
                      {err && (
                        <p role="alert" className="mt-1 text-xs text-destructive">
                          {err === 'over' ? t('deliveredQtyOver') : t('deliveredQtyInvalid')}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {differs && !hasError && !allZero && (
          <Alert>
            <AlertDescription>{t('deliverRemainderNotice')}</AlertDescription>
          </Alert>
        )}
        {allZero && (
          <Alert variant="destructive">
            <AlertDescription>{t('deliverAllZero')}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('cancelKeep')}
          </Button>
          <Button disabled={isSubmitting || hasError || allZero} onClick={submit}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('deliverConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
