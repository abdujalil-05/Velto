'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import {
  useCreateSupplierMutation,
  useUpdateSupplierMutation,
  type Supplier,
  type SupplierInput,
} from '@/lib/api/purchases';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogCloseButton } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface SupplierDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create. */
  supplier: Supplier | null;
}

const EMPTY = { name: '', legalName: '', inn: '', phone: '', address: '', note: '' };

export function SupplierDialog({ open, onOpenChange, supplier }: SupplierDialogProps) {
  const t = useTranslations('Purchases.supplierForm');
  const locale = useLocale();
  const createMutation = useCreateSupplierMutation();
  const updateMutation = useUpdateSupplierMutation(supplier?.id ?? '');
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      supplier
        ? {
            name: supplier.name,
            legalName: supplier.legalName ?? '',
            inn: supplier.inn ?? '',
            phone: supplier.phone ?? '',
            address: supplier.address ?? '',
            note: supplier.note ?? '',
          }
        : EMPTY,
    );
  }, [open, supplier]);

  const isPending = createMutation.isPending || updateMutation.isPending;

  function set(key: keyof typeof EMPTY, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError(t('nameRequired'));
      return;
    }
    const input: SupplierInput = {
      name: form.name.trim(),
      legalName: form.legalName.trim() || undefined,
      inn: form.inn.trim() || undefined,
      phone: form.phone.trim() || undefined,
      address: form.address.trim() || undefined,
      note: form.note.trim() || undefined,
    };
    try {
      if (supplier) await updateMutation.mutateAsync(input);
      else await createMutation.mutateAsync(input);
      toast.success(t(supplier ? 'updated' : 'created'));
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, locale));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{supplier ? t('editTitle') : t('createTitle')}</DialogTitle>
          <DialogCloseButton onClick={() => onOpenChange(false)} />
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="sup-name">{t('name')}</Label>
            <Input id="sup-name" value={form.name} maxLength={200} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-legal">{t('legalName')}</Label>
            <Input id="sup-legal" value={form.legalName} maxLength={300} onChange={(e) => set('legalName', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="sup-inn">{t('inn')}</Label>
              <Input id="sup-inn" value={form.inn} maxLength={32} onChange={(e) => set('inn', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sup-phone">{t('phone')}</Label>
              <Input id="sup-phone" value={form.phone} maxLength={32} onChange={(e) => set('phone', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-address">{t('address')}</Label>
            <Input id="sup-address" value={form.address} maxLength={500} onChange={(e) => set('address', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-note">{t('note')}</Label>
            <Textarea id="sup-note" value={form.note} maxLength={1000} onChange={(e) => set('note', e.target.value)} />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
