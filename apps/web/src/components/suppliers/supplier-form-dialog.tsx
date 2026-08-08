'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCreateSupplierMutation, useUpdateSupplierMutation, type Supplier } from '@/lib/api/suppliers';
import { errorMessage } from '@/lib/api/client';

interface SupplierFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier?: Supplier | null;
}

export function SupplierFormDialog({ open, onOpenChange, supplier }: SupplierFormDialogProps) {
  const t = useTranslations('Suppliers.form');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const isEdit = !!supplier;
  const createMutation = useCreateSupplierMutation();
  const updateMutation = useUpdateSupplierMutation(supplier?.id ?? '');
  const mutation = isEdit ? updateMutation : createMutation;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(supplier?.name ?? '');
    setPhone(supplier?.phone ?? '');
    setAddress(supplier?.address ?? '');
    setError(null);
  }, [open, supplier]);

  function handleSubmit() {
    if (!name.trim()) {
      setError(t('nameRequired'));
      return;
    }
    setError(null);
    const input = { name: name.trim(), phone: phone.trim() || undefined, address: address.trim() || undefined };
    mutation.mutate(input as never, {
      onSuccess: () => onOpenChange(false),
      onError: (err) => setError(errorMessage(err, locale)),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t('editTitle') : t('createTitle')}</DialogTitle>
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {tCommon('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
