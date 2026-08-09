'use client';

import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Defaults to `Common.confirmDelete.title`. */
  title?: string;
  /** Defaults to `Common.confirmDelete.description` interpolated with `itemName`. */
  description?: string;
  /** Name of the object being destroyed — shown inside the default description. */
  itemName?: string;
  /** Defaults to `Common.confirmDelete.confirm`. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Already-localised `ApiError` text (see `errorMessage(err, locale)`). */
  error?: string | null;
  isPending?: boolean;
  onConfirm: () => void;
}

/**
 * Confirmation gate for destructive actions (delete / deactivate / cancel).
 * Built on the app's dependency-free `Dialog`, so Escape and overlay click close it.
 * Never use `window.confirm` — it can't be translated and doesn't match the theme.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  itemName,
  confirmLabel,
  cancelLabel,
  error,
  isPending = false,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useTranslations('Common');

  return (
    <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ?? t('confirmDelete.title')}</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {description ?? t('confirmDelete.description', { name: itemName ?? '' })}
        </p>

        {error && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {cancelLabel ?? t('confirmDelete.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel ?? t('confirmDelete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
