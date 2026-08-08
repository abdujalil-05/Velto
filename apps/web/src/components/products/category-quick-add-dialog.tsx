'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCreateCategoryMutation } from '@/lib/api/categories';
import type { ProductCategory } from '@/lib/api/categories';
import { errorMessage } from '@/lib/api/client';

interface CategoryQuickAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (category: ProductCategory) => void;
}

export function CategoryQuickAddDialog({ open, onOpenChange, onCreated }: CategoryQuickAddDialogProps) {
  const t = useTranslations('Products.form.categoryDialog');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const createMutation = useCreateCategoryMutation();

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
  }, [open]);

  function handleSubmit() {
    if (!name.trim()) {
      setError(t('nameRequired'));
      return;
    }
    setError(null);
    createMutation.mutate(
      { name: name.trim() },
      {
        onSuccess: (category) => {
          onCreated(category);
          onOpenChange(false);
        },
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
            <Label htmlFor="categoryName">{t('name')}</Label>
            <Input
              id="categoryName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
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
