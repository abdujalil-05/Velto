'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  useIssueSupplierTelegramCodeMutation,
  useSupplierTelegramQuery,
  type Supplier,
  type SupplierTelegramCode,
} from '@/lib/api/suppliers';

interface SupplierTelegramDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier: Supplier | null;
  /** `purchases.update` — POST /link-code and DELETE both require it. */
  canUpdate: boolean;
  /**
   * Unlink confirmation is owned by the page, not nested here: `Dialog` is
   * deliberately single-instance (shared Escape handler + body-scroll cleanup),
   * so stacking a ConfirmDialog on top of this one would misbehave.
   */
  onRequestUnlink: (supplier: Supplier) => void;
}

export function SupplierTelegramDialog({
  open,
  onOpenChange,
  supplier,
  canUpdate,
  onRequestUnlink,
}: SupplierTelegramDialogProps) {
  const t = useTranslations('Suppliers.telegram');
  const locale = useLocale();

  const supplierId = supplier?.id ?? '';
  const { data, isLoading, isError, error } = useSupplierTelegramQuery(supplierId, open);
  const issueMutation = useIssueSupplierTelegramCodeMutation();

  // A freshly issued code, held locally so it shows immediately without waiting
  // for the refetch; the server's `pendingCode` takes over once it lands.
  const [issuedCode, setIssuedCode] = useState<SupplierTelegramCode | null>(null);

  useEffect(() => {
    if (!open) setIssuedCode(null);
  }, [open]);

  const code = issuedCode ?? data?.pendingCode ?? null;

  function handleGenerate() {
    if (!supplierId) return;
    issueMutation.mutate(supplierId, {
      onSuccess: (result) => {
        setIssuedCode(result);
        toast.success(t('codeIssued'));
      },
      onError: (err) => toast.error(errorMessage(err, locale)),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogCloseButton onClick={() => onOpenChange(false)} />
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('subtitle', { name: supplier?.name ?? '' })}</p>

          {isLoading && <Skeleton className="h-24 w-full" />}

          {isError && !isLoading && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error, locale)}</AlertDescription>
            </Alert>
          )}

          {data?.linked && (
            <div className="space-y-2 rounded-md border border-border p-4">
              <div className="flex items-center gap-2">
                <Badge variant="success">{t('statusLinked')}</Badge>
                <span className="text-sm font-medium">
                  {data.username ? `@${data.username}` : (data.telegramId ?? '—')}
                </span>
              </div>
              {data.linkedAt && (
                <p className="text-xs text-muted-foreground">
                  {t('linkedAt', { date: formatDateTime(data.linkedAt, locale) })}
                </p>
              )}
            </div>
          )}

          {data && !data.linked && (
            <div className="space-y-3">
              {!code && <p className="text-sm text-muted-foreground">{t('statusNotLinked')}</p>}

              {code && <LinkCodeBlock code={code} />}

              {canUpdate && (
                <Button variant={code ? 'outline' : 'default'} onClick={handleGenerate} disabled={issueMutation.isPending}>
                  {issueMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {code ? t('newCode') : t('generateCode')}
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {data?.linked && canUpdate && supplier && (
            <Button variant="destructive" onClick={() => onRequestUnlink(supplier)}>
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

/**
 * The raw code is always shown and copyable — `deepLink` is null whenever the
 * API has no TELEGRAM_BOT_USERNAME set, and the admin still has to relay the
 * code for the supplier's `/start`.
 */
function LinkCodeBlock({ code }: { code: SupplierTelegramCode }) {
  const t = useTranslations('Suppliers.telegram');
  const locale = useLocale();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-accent/40 p-4">
      <p className="text-xs font-medium text-muted-foreground">{t('codeLabel')}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 select-all break-all font-mono text-lg font-semibold tracking-wider">{code.code}</code>
        <Button variant="outline" size="sm" onClick={handleCopy} aria-label={t('copy')}>
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('expiresAt', { date: formatDateTime(code.expiresAt, locale) })}
      </p>
      {code.deepLink ? (
        <a
          href={code.deepLink}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          <ExternalLink className="h-4 w-4" />
          {t('openBot')}
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">{t('noDeepLinkHint')}</p>
      )}
    </div>
  );
}
