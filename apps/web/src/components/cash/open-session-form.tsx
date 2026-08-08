'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface OpenSessionFormProps {
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (openAmount: number) => void;
}

export function OpenSessionForm({ isSubmitting, submitError, onSubmit }: OpenSessionFormProps) {
  const t = useTranslations('Cash.openForm');
  const [openAmount, setOpenAmount] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);
    const amount = Number(openAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setValidationError(t('invalidAmount'));
      return;
    }
    onSubmit(amount);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="openAmount">{t('openAmount')}</Label>
        <Input
          id="openAmount"
          type="number"
          min={0}
          step="0.01"
          value={openAmount}
          onChange={(e) => setOpenAmount(e.target.value)}
        />
      </div>

      {(validationError || submitError) && (
        <Alert variant="destructive">
          <AlertDescription>{validationError ?? submitError}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {t('submit')}
      </Button>
    </form>
  );
}
