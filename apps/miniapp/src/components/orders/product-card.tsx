'use client';

import { useTranslations } from 'next-intl';
import { PackageX } from 'lucide-react';
import type { SyncPackaging, SyncProduct } from '@/lib/api/sync';
import { formatMoney, formatQty } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { QtyStepper } from '@/components/shared/qty-stepper';

interface ProductCardProps {
  product: SyncProduct;
  packagings: SyncPackaging[];
  price: string | undefined;
  availableQty: number;
  maxQty: number;
  packagingId: string;
  qty: number;
  onPackagingChange: (packagingId: string) => void;
  onQtyChange: (qty: number) => void;
}

/** 9.4 Ekran 4: "rasm (majburiy ko'rinadi), nom, narx, qoldiq. Miqdor: − 12 + va qadoq tanlash." */
export function ProductCard({
  product,
  packagings,
  price,
  availableQty,
  maxQty,
  packagingId,
  qty,
  onPackagingChange,
  onQtyChange,
}: ProductCardProps) {
  const t = useTranslations('Order');
  const tCommon = useTranslations('Common');
  const exceedsStock = qty > maxQty;

  return (
    <Card>
      <CardContent className="flex gap-3 py-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
          {product.imageUrl ? (
            // Plain <img>, not next/image — these URLs must still render
            // offline from cache, which next/image's optimizer can't do.
            <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <PackageX className="h-6 w-6 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="truncate text-sm font-medium">{product.name}</p>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {price ? `${formatMoney(price)} ${tCommon('somUnit')}` : t('priceUnavailable')}
            </span>
            <span>
              {t('available')}: {formatQty(availableQty)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {packagings.length > 1 ? (
              <Select value={packagingId} onChange={(e) => onPackagingChange(e.target.value)} className="h-10 w-24 text-xs">
                {packagings.map((pkg) => (
                  <option key={pkg.id} value={pkg.id}>
                    {pkg.name}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">{packagings[0]?.name}</span>
            )}
            <QtyStepper value={qty} onChange={onQtyChange} max={maxQty} />
          </div>
          {exceedsStock && <p className="text-xs text-destructive">{t('stockExceeded', { available: formatQty(maxQty) })}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
