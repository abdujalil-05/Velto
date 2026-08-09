'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CloudOff } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConfirmSheetProps {
  open: boolean;
  /** Ignored while the action is running — a half-applied destructive action must not be dismissable. */
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What exactly is about to be lost. Always name the object (outlet, customer, draft) rather than "this item". */
  description: React.ReactNode;
  /** Rendered as the emphasised object name under the description (outlet/customer/draft name). */
  itemName?: string;
  /**
   * The confirmed action writes into the local mutation queue (`lib/offline/queue.ts`).
   * Adds the 10.3 warning that the document is already durable locally and will
   * be pushed to the server on the next sync — there is no recall once queued.
   */
  queued?: boolean;
  /** `destructive` (default) paints the confirm button red; `default` is for irreversible-but-not-deleting actions (e.g. finishing a route). */
  tone?: 'destructive' | 'default';
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  /** Extra inputs shown above the actions (e.g. a "reason" textarea). Disabled by the caller while `busy` isn't observable — keep them cheap. */
  children?: React.ReactNode;
}

/**
 * The single confirmation surface for destructive / irreversible agent actions
 * (UX-012, TZ 10.3). Bottom-sheet, one-thumb reachable, never `window.confirm`
 * (blocked inside the Telegram WebView and unstyleable).
 *
 * Owns its own `busy` state so every call site gets the same guarantees for
 * free: double-tap can't fire the action twice, and the sheet can't be
 * dismissed mid-flight (a field device drops connectivity exactly during these
 * awaits, and `onConfirm` is often an `enqueue` + navigation pair).
 */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  itemName,
  queued = false,
  tone = 'destructive',
  confirmLabel,
  cancelLabel,
  onConfirm,
  children,
}: ConfirmSheetProps) {
  const t = useTranslations('Common.confirmSheet');
  const tCommon = useTranslations('Common');
  const [busy, setBusy] = React.useState(false);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A sheet reopened for a different object must not inherit a stuck busy flag
  // (e.g. onConfirm threw and the caller kept the sheet closed).
  React.useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      placement="bottom"
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="rounded-b-none rounded-t-2xl border-b-0 p-5">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
              tone === 'destructive' ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning-foreground',
            )}
            aria-hidden="true"
          >
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold leading-tight">{title}</h2>
            <p className="text-sm text-muted-foreground">{description}</p>
            {itemName && <p className="truncate text-sm font-medium">{itemName}</p>}
          </div>
        </div>

        {queued && (
          <div className="mt-4 flex items-start gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
            <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('offlineQueueWarning')}</span>
          </div>
        )}

        {children && <div className="mt-4">{children}</div>}

        <div className="mt-5 flex flex-col-reverse gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel ?? tCommon('cancel')}
          </Button>
          <Button
            type="button"
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={handleConfirm}
          >
            {busy ? t('working') : (confirmLabel ?? t('delete'))}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
