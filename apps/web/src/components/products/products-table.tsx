import { useTranslations } from 'next-intl';
import { ImageOff, Trash2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SortableHeader } from '@/components/shared/sortable-header';
import { formatMoney } from '@/lib/format';
import type { SortState } from '@/lib/hooks/use-sort';
import type { Product } from '@/lib/api/products';

interface ProductsTableProps {
  products: Product[];
  sort: SortState;
  onSort: (column: string) => void;
  /** `catalog.delete` — restricted on the API side. */
  canDelete?: boolean;
  onDelete?: (product: Product) => void;
}

export function ProductsTable({ products, sort, onSort, canDelete = false, onDelete }: ProductsTableProps) {
  const t = useTranslations('Products');
  const showActions = canDelete && !!onDelete;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('image')}</th>
            <SortableHeader column="sku" sort={sort} onSort={onSort}>
              {t('sku')}
            </SortableHeader>
            <SortableHeader column="name" sort={sort} onSort={onSort}>
              {t('name')}
            </SortableHeader>
            <SortableHeader column="brand" sort={sort} onSort={onSort}>
              {t('brand')}
            </SortableHeader>
            <th className="pb-2 pr-3 font-medium">{t('category')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('price')}</th>
            <th className="pb-2 font-medium">{t('status')}</th>
            {showActions && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {products.map((product) => (
            <tr key={product.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3">
                <Link href={`/products/${product.id}/edit`}>
                  <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                    {product.imageUrl ? (
                      <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <ImageOff className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </Link>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{product.sku}</td>
              <td className="py-2 pr-3">
                <Link href={`/products/${product.id}/edit`} className="font-medium text-primary hover:underline">
                  {product.name}
                </Link>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{product.brand ?? '—'}</td>
              <td className="py-2 pr-3 text-muted-foreground">{product.category?.name ?? '—'}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{product.price ? formatMoney(product.price) : '—'}</td>
              <td className="py-2">
                {product.isActive ? (
                  <Badge variant="success">{t('active')}</Badge>
                ) : (
                  <Badge variant="outline">{t('inactive')}</Badge>
                )}
              </td>
              {showActions && (
                <td className="py-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => onDelete?.(product)} aria-label={t('delete')}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
