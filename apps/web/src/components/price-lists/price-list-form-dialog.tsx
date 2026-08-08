'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCreatePriceListMutation } from '@/lib/api/price-lists';
import { errorMessage } from '@/lib/api/client';

interface PriceListFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PriceListFormDialog({ open, onOpenChange }: PriceListFormDialogProps) {
  const t = useTranslations('PriceLists.form');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const createMutation = useCreatePriceListMutation();

  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setIsDefault(false);
    setError(null);
  }, [open]);

  function handleSubmit() {
    if (!name.trim()) {
      setError(t('invalidName'));
      return;
    }
    setError(null);
    createMutation.mutate(
      { name: name.trim(), isDefault },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => setError(errorMessage(err, locale)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="priceListName">{t('name')}</Label>
            <Input id="priceListName" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            {t('isDefault')}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createMutation.isPending}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
