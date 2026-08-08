'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCreateSupplierMutation, type Supplier } from '@/lib/api/suppliers';
import { errorMessage } from '@/lib/api/client';

interface SupplierQuickAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (supplier: Supplier) => void;
}

export function SupplierQuickAddDialog({ open, onOpenChange, onCreated }: SupplierQuickAddDialogProps) {
  const t = useTranslations('Purchases.supplierDialog');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const createMutation = useCreateSupplierMutation();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setPhone('');
    setAddress('');
    setError(null);
  }

  function handleSubmit() {
    if (!name.trim()) {
      setError(t('nameRequired'));
      return;
    }
    setError(null);
    createMutation.mutate(
      { name: name.trim(), phone: phone.trim() || undefined, address: address.trim() || undefined },
      {
        onSuccess: (supplier) => {
          onCreated(supplier);
          onOpenChange(false);
          reset();
        },
        onError: (err) => setError(errorMessage(err, locale)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) reset(); }}>
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
            <Label htmlFor="supplierName">{t('name')}</Label>
            <Input id="supplierName" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplierPhone">{t('phone')}</Label>
            <Input id="supplierPhone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplierAddress">{t('address')}</Label>
            <Input id="supplierAddress" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
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
