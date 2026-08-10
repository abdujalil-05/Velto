'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCreateCourierMutation, useUpdateCourierMutation, type Courier } from '@/lib/api/couriers';
import { errorMessage } from '@/lib/api/client';

interface CourierFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courier?: Courier | null;
}

export function CourierFormDialog({ open, onOpenChange, courier }: CourierFormDialogProps) {
  const t = useTranslations('Couriers.form');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const isEdit = !!courier;
  const createMutation = useCreateCourierMutation();
  const updateMutation = useUpdateCourierMutation(courier?.id ?? '');
  const isPending = createMutation.isPending || updateMutation.isPending;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFirstName(courier?.firstName ?? '');
    setLastName(courier?.lastName ?? '');
    setPhone(courier?.phone ?? '');
    setError(null);
  }, [open, courier]);

  function handleSubmit() {
    if (!firstName.trim()) {
      setError(t('firstNameRequired'));
      return;
    }
    if (!lastName.trim()) {
      setError(t('lastNameRequired'));
      return;
    }
    setError(null);
    const input = { firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim() };
    const onSuccess = () => onOpenChange(false);
    const onError = (err: unknown) => setError(errorMessage(err, locale));

    if (isEdit) {
      updateMutation.mutate(input, { onSuccess, onError });
    } else {
      createMutation.mutate(input, { onSuccess, onError });
    }
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
            <Label htmlFor="courierFirstName">{t('firstName')}</Label>
            <Input id="courierFirstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="courierLastName">{t('lastName')}</Label>
            <Input id="courierLastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="courierPhone">{t('phone')}</Label>
            <Input
              id="courierPhone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+998901234567"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {tCommon('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
