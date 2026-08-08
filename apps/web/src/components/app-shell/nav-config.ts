import {
  BarChart3,
  Building2,
  History,
  IdCard,
  LayoutDashboard,
  Package,
  Route,
  Settings as SettingsIcon,
  ShoppingCart,
  UserCog,
  Users,
  Wallet,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  key:
    | 'dashboard'
    | 'orders'
    | 'customers'
    | 'products'
    | 'cash'
    | 'stock'
    | 'suppliers'
    | 'users'
    | 'routes'
    | 'agents'
    | 'reports'
    | 'audit'
    | 'settings';
  href: string;
  icon: LucideIcon;
  /** "module.action" required to see this item — omitted if every logged-in role may see it. */
  permission?: string;
}

// 9.2 lists ~20 screens; only the ones actually built land here as they
// ship, one line each — everything else stays unlinked rather than a dead
// or "coming soon" nav entry (0-bo'lim rule 5).
//
// priceLists, purchases, import, onboarding: pages/backend still exist but
// are intentionally unlinked here — descoped for this deployment (pricing
// is now a single field on the product, not a separate module; purchase
// orders, bulk import and the setup wizard aren't used). receivables: fully
// removed — it duplicated the Reports "aging" tab exactly. payments: merged
// into the "cash" screen (Kassa) rather than being its own page.
export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', href: '/', icon: LayoutDashboard, permission: 'reports.read' },
  { key: 'orders', href: '/orders', icon: ShoppingCart, permission: 'orders.read' },
  { key: 'customers', href: '/customers', icon: Users, permission: 'customers.read' },
  { key: 'products', href: '/products', icon: Package, permission: 'catalog.read' },
  { key: 'cash', href: '/cash', icon: Wallet, permission: 'payments.read' },
  { key: 'stock', href: '/stock', icon: Warehouse, permission: 'stock.read' },
  { key: 'suppliers', href: '/suppliers', icon: Building2, permission: 'purchases.read' },
  { key: 'users', href: '/users', icon: IdCard, permission: 'users.read' },
  { key: 'agents', href: '/agents', icon: UserCog, permission: 'users.read' },
  { key: 'routes', href: '/routes', icon: Route, permission: 'routes.read' },
  { key: 'reports', href: '/reports', icon: BarChart3, permission: 'reports.read' },
  { key: 'audit', href: '/audit', icon: History, permission: 'audit.read' },
  { key: 'settings', href: '/settings', icon: SettingsIcon, permission: 'settings.read' },
];

export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));
}
