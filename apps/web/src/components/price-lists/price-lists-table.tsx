import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import type { PriceList } from '@/lib/api/price-lists';

interface PriceListsTableProps {
  priceLists: PriceList[];
}

export function PriceListsTable({ priceLists }: PriceListsTableProps) {
  const t = useTranslations('PriceLists');

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('name')}</th>
            <th className="pb-2 font-medium">{t('isDefault')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {priceLists.map((priceList) => (
            <tr key={priceList.id}>
              <td className="py-2 pr-3 font-medium">
                <Link href={`/price-lists/${priceList.id}`} className="text-primary hover:underline">
                  {priceList.name}
                </Link>
              </td>
              <td className="py-2">{priceList.isDefault && <Badge variant="success">{t('isDefault')}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
