'use client';

import { useLocale, useTranslations } from 'next-intl';
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { courierName, type Courier } from '@/lib/api/couriers';

interface CourierTelegramDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courier: Courier | null;
  /** `users.update` — DELETE /users/:id/telegram requires it. */
  canUpdate: boolean;
  /**
   * Unlink confirmation is owned by the page, not nested here: `Dialog` is
   * deliberately single-instance (shared Escape handler + body-scroll cleanup),
   * so stacking a ConfirmDialog on top of this one would misbehave.
   */
  onRequestUnlink: (courier: Courier) => void;
}

/**
 * Read-only view of a courier's Telegram link, plus revoke. There is nothing to
 * issue here: the courier links themselves by pressing /start in the company bot
 * and sharing their phone number, which the backend matches to their account —
 * so an admin can only see the status and unlink.
 */
export function CourierTelegramDialog({
  open,
  onOpenChange,
  courier,
  canUpdate,
  onRequestUnlink,
}: CourierTelegramDialogProps) {
  const t = useTranslations('Couriers.telegram');
  const locale = useLocale();

  const linked = courier?.telegramLinked ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogCloseButton onClick={() => onOpenChange(false)} />
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('subtitle', { name: courier ? courierName(courier) : '' })}</p>

          {linked ? (
            <div className="space-y-2 rounded-md border border-border p-4">
              <Badge variant="success">{t('statusLinked')}</Badge>
              {courier?.telegramLinkedAt && (
                <p className="text-xs text-muted-foreground">
                  {t('linkedAt', { date: formatDateTime(courier.telegramLinkedAt, locale) })}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2 rounded-md border border-border bg-accent/40 p-4">
              <Badge variant="outline">{t('notLinked')}</Badge>
              <p className="text-sm text-muted-foreground">{t('statusNotLinked')}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {linked && canUpdate && courier && (
            <Button variant="destructive" onClick={() => onRequestUnlink(courier)}>
              {t('unlink')}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
