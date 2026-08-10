'use client';

import { useTranslations } from 'next-intl';
import {
  ArrowRightLeft,
  BarChart3,
  HelpCircle,
  History,
  IdCard,
  Info,
  LayoutDashboard,
  Package,
  Rocket,
  Route,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Store,
  Truck,
  UserCog,
  Users,
  Wallet,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface HelpGroup {
  heading?: string;
  items: string[];
}

interface HelpSection {
  title: string;
  intro: string;
  groups: HelpGroup[];
}

/** Steps that only make sense in order are numbered; everything else is a bullet list. */
const SECTIONS: { key: string; icon: LucideIcon; ordered?: boolean }[] = [
  { key: 'intro', icon: Info },
  { key: 'roles', icon: Users },
  { key: 'start', icon: Rocket, ordered: true },
  { key: 'flow', icon: ArrowRightLeft, ordered: true },
  { key: 'dashboard', icon: LayoutDashboard },
  { key: 'orders', icon: ShoppingCart },
  { key: 'customers', icon: Store },
  { key: 'products', icon: Package },
  { key: 'stock', icon: Warehouse },
  { key: 'cash', icon: Wallet },
  { key: 'couriers', icon: Truck },
  { key: 'routes', icon: Route },
  { key: 'agents', icon: UserCog },
  { key: 'reports', icon: BarChart3 },
  { key: 'users', icon: IdCard },
  { key: 'audit', icon: History },
  { key: 'settings', icon: SettingsIcon },
  { key: 'miniapp', icon: Smartphone },
  { key: 'faq', icon: HelpCircle },
  { key: 'habits', icon: ShieldCheck },
];

export default function HelpPage() {
  const t = useTranslations('Help');

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <p className="mb-3 text-sm font-medium">{t('tocTitle')}</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {SECTIONS.map(({ key, icon: Icon }) => (
              <a
                key={key}
                href={`#${key}`}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{t(`sections.${key}.title`)}</span>
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      {SECTIONS.map(({ key, icon: Icon, ordered }) => {
        const section = t.raw(`sections.${key}`) as HelpSection;
        const List = ordered ? 'ol' : 'ul';

        return (
          <Card key={key} id={key} className="scroll-mt-20">
            <CardContent className="space-y-4 pt-6">
              <div className="flex items-start gap-3">
                <span className="rounded-md bg-primary/10 p-2 text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <div className="space-y-1">
                  <h2 className="text-base font-semibold">{section.title}</h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">{section.intro}</p>
                </div>
              </div>

              {section.groups.map((group, groupIndex) => (
                <div key={groupIndex} className="space-y-2">
                  {group.heading && <p className="text-sm font-medium">{group.heading}</p>}
                  <List
                    className={`space-y-1.5 pl-5 text-sm leading-relaxed ${
                      ordered ? 'list-decimal' : 'list-disc'
                    }`}
                  >
                    {group.items.map((item, itemIndex) => (
                      <li key={itemIndex} className="marker:text-muted-foreground">
                        {item}
                      </li>
                    ))}
                  </List>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
