// Demo seed per VELTO-TZ.md 11.5. Refuses to run in production; the demo
// password comes from .env (SEED_DEMO_PASSWORD), never hardcoded.
import 'dotenv/config';
import argon2 from 'argon2';
import {
  prisma,
  systemPrisma,
  withTenant,
  type TenantClient,
  OutletType,
  StockMovementType,
  OrderStatus,
  InvoiceStatus,
  PaymentMethod,
  VisitOutcome,
} from './index';
// Role/permission catalog lives in one place only — see rbac-catalog.ts.
// Do not re-declare these lists here.
import { SYSTEM_ROLES, PERMISSION_DEFS, permissionKeysForRole } from './rbac-catalog';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV=production. Demo data must never run against prod.');
  process.exit(1);
}

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD;
if (!DEMO_PASSWORD) {
  console.error('Set SEED_DEMO_PASSWORD in .env before seeding.');
  process.exit(1);
}

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(arr: T[]): T => arr[rand(arr.length)]!;
const round2 = (n: number) => Math.round(n * 100) / 100;

// --- Reference data pools (demo only, Uzbekistan / Tashkent flavored) ------

const FIRST_NAMES_M = ['Anvar', 'Sardor', 'Bekzod', 'Jasur', 'Otabek', 'Sherzod', 'Ravshan', 'Aziz', 'Dilshod', 'Farrux'];
const FIRST_NAMES_F = ['Nodira', 'Kamola', 'Malika', 'Feruza', 'Zarina', 'Gulnora', 'Madina', 'Sevinch', 'Dilnoza', 'Shahnoza'];
const LAST_NAMES = ['Karimov', 'Yusupov', 'Rashidov', 'Nazarov', 'Ergashev', 'Xolmatov', 'Tursunov', 'Rasulov', 'Sodiqov', 'Abdullayev'];
const lastNameFor = (firstName: string) =>
  FIRST_NAMES_F.includes(firstName) ? pick(LAST_NAMES) + 'a' : pick(LAST_NAMES);

const TASHKENT_DISTRICTS = [
  'Chilonzor', 'Yunusobod', 'Mirzo Ulug’bek', 'Shayxontohur', 'Yakkasaroy',
  'Olmazor', 'Bektemir', 'Sergeli', 'Uchtepa', 'Yashnobod',
];
const TASHKENT_CENTER = { lat: 41.2995, lng: 69.2401 };
const jitterCoord = (base: number, spread: number) => round2n(base + (Math.random() - 0.5) * spread, 7);
function round2n(n: number, digits: number) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const CATEGORY_DEFS = [
  { name: 'Ichimliklar', products: ['Coca-Cola', 'Fanta', 'Sprite', 'Pepsi', 'Mirinda', '7Up', 'Bonaqua suvi', 'Nestea', 'Miracola', 'Bahor suvi', 'Olma sharbati', 'Nектар shaftoli', 'Multivitamin sharbat', 'Energetik ichimlik', 'Kvas'] },
  { name: 'Oziq-ovqat', products: ['Makaron', 'Guruch', 'O’simlik yog’i', 'Un', 'Yormalar', 'Konserva pomidor', 'Konserva no’xat', 'Tuz', 'Shakar', 'Choy qora', 'Choy ko’k', 'Kofe', 'Ketchup', 'Majonez', 'Sirka'] },
  { name: 'Maishiy kimyo', products: ['Kir yuvish kukuni', 'Idish yuvish suyuqligi', 'Sanitar tozalagich', 'Xlorli oqartirgich', 'Shisha tozalagich', 'Xushbo’y sprey', 'Pol tozalagich', 'Dazmol spreyi', 'Kir yumshatgich', 'Changyutgich paketi'] },
  { name: 'Gigiyena', products: ['Tualet sovuni', 'Shampun', 'Tish pastasi', 'Tish cho’tkasi', 'Salfetka', 'Tualet qog’ozi', 'Dezodorant', 'Bolalar pampersi', 'Gigiyenik prokladka', 'Traş krem'] },
  { name: 'Shirinliklar', products: ['Shokolad', 'Vafli', 'Pechene', 'Konfet', 'Jem', 'Marmelad', 'Halva', 'Krekera', 'Muffin', 'Karamel'] },
];

const DEFAULT_PACKAGINGS: [string, number][] = [['dona', 1], ['blok', 12], ['quti', 96]];

// ---------------------------------------------------------------------------

async function main() {
  const existingTenant = await systemPrisma.tenant.findUnique({ where: { slug: 'demo' } });
  if (existingTenant) {
    const existingCompany = await systemPrisma.company.findFirst({ where: { tenantId: existingTenant.id } });
    if (existingCompany) {
      const userCount = await systemPrisma.user.count({ where: { companyId: existingCompany.id } });
      if (userCount > 0) {
        console.log('Demo tenant already seeded — skipping (delete it manually to reseed).');
        return;
      }
    }
  }

  // Tenant + Company provisioning is a PLATFORM_ADMIN, DB-level operation in
  // MVP (4.1) — done here via the BYPASSRLS systemPrisma, exactly like a real
  // customer would be onboarded.
  const tenant =
    existingTenant ??
    (await systemPrisma.tenant.create({
      data: {
        slug: 'demo',
        name: 'Demo Distribution',
        plan: 'GROWTH',
        trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
      },
    }));

  const company = await systemPrisma.company.create({
    data: {
      tenantId: tenant.id,
      name: 'Demo Savdo MChJ',
      legalName: '"Demo Savdo" Mas’uliyati Cheklangan Jamiyati',
      phone: '+998712001122',
      address: 'Toshkent sh., Chilonzor tumani',
      currency: 'UZS',
      defaultVatRate: 12,
      docPrefix: '',
      timezone: 'Asia/Tashkent',
    },
  });

  console.log(`Company created: ${company.id}`);

  // argon2 is deliberately hashed *before* the transaction opens: it's ~100ms
  // of CPU per call and would otherwise burn the transaction's time budget
  // while holding an RLS-scoped connection.
  const passwordHash = await argon2.hash(DEMO_PASSWORD!, { type: argon2.argon2id });

  // Everything from here on goes through the same RLS-bound path the app
  // itself uses — a useful end-to-end check that tenant-scoped writes work.
  // The explicit timeout is required: this seed writes ~10k rows (120 SKUs,
  // 80 customers, 30 days of history) in a single transaction, and Prisma's
  // 5s interactive-transaction default aborts it with P2028 long before that
  // finishes, leaving a half-seeded tenant behind.
  await withTenant(company.id, async (tx) => {
    const roles = await seedRoles(tx, company.id);
    const permissionIdByKey = await seedPermissions();
    await seedRolePermissions(tx, roles, permissionIdByKey);
    const users = await seedUsers(tx, company.id, roles, passwordHash);
    const warehouse = await tx.warehouse.create({
      data: { companyId: company.id, name: 'Asosiy ombor', address: 'Toshkent sh., Chilonzor tumani' },
    });
    const { products, packagingsByProduct } = await seedCatalog(tx, company.id);
    const stockLedger = await receiveInitialStock(tx, company.id, warehouse.id, products);
    const priceLists = await seedPriceLists(tx, company.id, products);
    const { outlets } = await seedCustomers(tx, company.id, priceLists);
    const routes = await seedRoutes(tx, company.id, users.agents, outlets);
    await seedHistory(tx, company.id, {
      warehouseId: warehouse.id,
      agents: users.agents,
      courierId: users.courier.id,
      outlets,
      products,
      packagingsByProduct,
      stockLedger,
    });
    void routes;
  }, { maxWait: 30_000, timeout: 15 * 60_000 });

  console.log('Seed complete.');
}

// --- Roles & users -----------------------------------------------------

async function seedRoles(tx: TenantClient, companyId: string) {
  const roles: Record<string, string> = {};
  for (const def of SYSTEM_ROLES) {
    const role = await tx.role.create({
      data: { companyId, code: def.code, name: def.name, isSystem: true },
    });
    roles[def.code] = role.id;
  }
  return roles;
}

/** Permission is global reference data (schema 6.2, not tenant-scoped) — seeded once via the BYPASSRLS client. */
async function seedPermissions(): Promise<Record<string, string>> {
  const idByKey: Record<string, string> = {};
  for (const def of PERMISSION_DEFS) {
    for (const action of def.actions) {
      const permission = await systemPrisma.permission.upsert({
        where: { module_code: { module: def.module, code: action } },
        update: {},
        create: { module: def.module, code: action },
      });
      idByKey[`${def.module}.${action}`] = permission.id;
    }
  }
  return idByKey;
}

async function seedRolePermissions(
  tx: TenantClient,
  roles: Record<string, string>,
  permissionIdByKey: Record<string, string>,
) {
  for (const [roleCode, roleId] of Object.entries(roles)) {
    for (const key of permissionKeysForRole(roleCode)) {
      const permissionId = permissionIdByKey[key];
      if (!permissionId) continue;
      await tx.rolePermission.create({ data: { roleId, permissionId } });
    }
  }
}

async function seedUsers(
  tx: TenantClient,
  companyId: string,
  roles: Record<string, string>,
  passwordHash: string,
) {
  async function createUser(firstName: string, lastName: string, phone: string, roleCode: string) {
    const user = await tx.user.create({
      data: { companyId, firstName, lastName, phone, passwordHash, isActive: true },
    });
    await tx.userRole.create({ data: { userId: user.id, roleId: roles[roleCode]! } });
    return user;
  }

  const owner = await createUser('Dilshod', 'Rashidov', '+998901110001', 'OWNER');
  const salesDirector = await createUser('Nodira', 'Karimova', '+998901110002', 'SALES_DIRECTOR');
  const agent1 = await createUser('Anvar', 'Tursunov', '+998901110004', 'SALES_AGENT');
  const agent2 = await createUser('Sardor', 'Ergashev', '+998901110005', 'SALES_AGENT');
  const warehouseUser = await createUser('Jasur', 'Xolmatov', '+998901110006', 'WAREHOUSE');
  const cashier = await createUser('Feruza', 'Sodiqova', '+998901110007', 'CASHIER');
  // Kuryer — an ordinary user with the COURIER role, not a separate entity.
  // +998901110006 (the number this demo courier was specified with) already
  // belongs to the warehouse user above and @@unique([companyId, phone]) would
  // reject it, so the courier takes the next free number in the block.
  const courier = await createUser('Jasur', 'Qodirov', '+998901110008', 'COURIER');

  return {
    owner,
    salesDirector,
    warehouseUser,
    cashier,
    courier,
    agents: [agent1, agent2],
  };
}

// --- Catalog -------------------------------------------------------------

async function seedCatalog(tx: TenantClient, companyId: string) {
  const products: { id: string; vatRate: number }[] = [];
  const packagingsByProduct: Record<string, { id: string; qtyInBaseUnit: number }[]> = {};
  let sku = 1;

  for (const catDef of CATEGORY_DEFS) {
    const category = await tx.productCategory.create({ data: { companyId, name: catDef.name } });

    // 24 products per category (5 * 24 = 120, matching 11.5).
    for (let i = 0; i < 24; i++) {
      const baseName = catDef.products[i % catDef.products.length]!;
      const variant = Math.floor(i / catDef.products.length) + 1;
      const name = variant > 1 ? `${baseName} v${variant}` : baseName;
      const skuCode = `SKU-${String(sku).padStart(5, '0')}`;
      const product = await tx.product.create({
        data: {
          companyId,
          categoryId: category.id,
          sku: skuCode,
          barcode: `2990000${String(sku).padStart(6, '0')}`,
          name,
          brand: baseName,
          baseUnit: 'dona',
          vatRate: 12,
          minPrice: round2(1000 + rand(15000)),
          imageUrl: `https://picsum.photos/seed/velto-${skuCode}/400/400`,
          externalCode: skuCode,
        },
      });

      const packagings = [];
      for (const [name, qty] of DEFAULT_PACKAGINGS) {
        const packaging = await tx.productPackaging.create({
          data: { productId: product.id, name, qtyInBaseUnit: qty, isDefault: qty === 1 },
        });
        packagings.push({ id: packaging.id, qtyInBaseUnit: qty });
      }
      packagingsByProduct[product.id] = packagings;
      products.push({ id: product.id, vatRate: 12 });
      sku++;
    }
  }

  return { products, packagingsByProduct };
}

async function receiveInitialStock(
  tx: TenantClient,
  companyId: string,
  warehouseId: string,
  products: { id: string }[],
): Promise<Record<string, number>> {
  const ledger: Record<string, number> = {};
  for (const product of products) {
    const qty = 500 + rand(1500);
    ledger[product.id] = qty;
    await tx.stockMovement.create({
      data: {
        companyId,
        productId: product.id,
        warehouseId,
        type: StockMovementType.RECEIVE,
        qty,
        refType: 'SeedInitialStock',
        note: 'Boshlang’ich qoldiq (demo)',
      },
    });
    await tx.stockLevel.upsert({
      where: { productId_warehouseId: { productId: product.id, warehouseId } },
      update: { onHand: { increment: qty } },
      create: { productId: product.id, warehouseId, onHand: qty, reserved: 0 },
    });
  }
  return ledger;
}

async function seedPriceLists(tx: TenantClient, companyId: string, products: { id: string }[]) {
  const retail = await tx.priceList.create({ data: { companyId, name: 'Chakana narx', isDefault: true } });
  const wholesale = await tx.priceList.create({ data: { companyId, name: 'Ulgurji narx', isDefault: false } });

  for (const product of products) {
    const basePrice = round2(2000 + rand(20000));
    await tx.priceListItem.create({ data: { priceListId: retail.id, productId: product.id, price: basePrice } });
    await tx.priceListItem.create({
      data: { priceListId: wholesale.id, productId: product.id, price: round2(basePrice * 0.9) },
    });
  }

  return { retail, wholesale };
}

// --- Customers & outlets ---------------------------------------------------

async function seedCustomers(
  tx: TenantClient,
  companyId: string,
  priceLists: { retail: { id: string }; wholesale: { id: string } },
) {
  const customers: { id: string }[] = [];
  const outlets: { id: string; customerId: string }[] = [];

  for (let i = 1; i <= 80; i++) {
    const district = pick(TASHKENT_DISTRICTS);
    const name = `"${district} Savdo ${i}" savdo nuqtasi`;
    const priceList = i % 5 === 0 ? priceLists.wholesale : priceLists.retail;
    const customer = await tx.customer.create({
      data: {
        companyId,
        code: `CUST-${String(i).padStart(4, '0')}`,
        name,
        phone: `+99890${String(2000000 + rand(7000000)).padStart(7, '0')}`,
        contactPerson: (() => {
          const firstName = pick(FIRST_NAMES_M.concat(FIRST_NAMES_F));
          return `${firstName} ${lastNameFor(firstName)}`;
        })(),
        priceListId: priceList.id,
        paymentTermDays: pick([0, 7, 14, 30]),
      },
    });
    customers.push(customer);

    // 95 outlets across 80 customers — most 1:1, a handful of customers get a second outlet.
    const outlet = await tx.outlet.create({
      data: {
        companyId,
        customerId: customer.id,
        name: `${district} do'koni`,
        type: pick([OutletType.SHOP, OutletType.MINIMARKET, OutletType.SUPERMARKET, OutletType.BAZAAR]),
        address: `Toshkent sh., ${district} tumani`,
        latitude: jitterCoord(TASHKENT_CENTER.lat, 0.16),
        longitude: jitterCoord(TASHKENT_CENTER.lng, 0.16),
      },
    });
    outlets.push({ id: outlet.id, customerId: customer.id });

    if (outlets.length < 95 && i % 6 === 0) {
      const outlet2 = await tx.outlet.create({
        data: {
          companyId,
          customerId: customer.id,
          name: `${district} filiali`,
          type: OutletType.SHOP,
          address: `Toshkent sh., ${district} tumani, 2-filial`,
          latitude: jitterCoord(TASHKENT_CENTER.lat, 0.16),
          longitude: jitterCoord(TASHKENT_CENTER.lng, 0.16),
        },
      });
      outlets.push({ id: outlet2.id, customerId: customer.id });
    }
  }

  return { customers, outlets };
}

// --- Routes ----------------------------------------------------------------

async function seedRoutes(
  tx: TenantClient,
  companyId: string,
  agents: { id: string }[],
  outlets: { id: string }[],
) {
  const routes = [];
  const weekdays = [1, 2, 3, 4, 5];
  const chunkSize = Math.ceil(outlets.length / weekdays.length);

  for (let i = 0; i < 5; i++) {
    const agent = agents[i % agents.length]!;
    const weekday = weekdays[i]!;
    const route = await tx.route.create({
      data: { companyId, agentId: agent.id, weekday, name: `Marshrut #${i + 1}` },
    });
    const stops = outlets.slice(i * chunkSize, (i + 1) * chunkSize);
    let sortOrder = 1;
    for (const outlet of stops) {
      await tx.routeStop.create({ data: { routeId: route.id, outletId: outlet.id, sortOrder: sortOrder++ } });
    }
    routes.push(route);
  }
  return routes;
}

// --- 30 days of historical activity (11.5) ---------------------------------

async function seedHistory(
  tx: TenantClient,
  companyId: string,
  ctx: {
    warehouseId: string;
    agents: { id: string }[];
    courierId: string;
    outlets: { id: string; customerId: string }[];
    products: { id: string; vatRate: number }[];
    packagingsByProduct: Record<string, { id: string; qtyInBaseUnit: number }[]>;
    stockLedger: Record<string, number>;
  },
) {
  let soSeq = 1;
  let invSeq = 1;
  let paySeq = 1;
  const year = new Date().getFullYear();

  for (let dayOffset = 30; dayOffset >= 1; dayOffset--) {
    const day = new Date();
    day.setDate(day.getDate() - dayOffset);

    for (const agent of ctx.agents) {
      const visitsToday = 4 + rand(5); // 4-8 visits/agent/day
      for (let v = 0; v < visitsToday; v++) {
        const outlet = pick(ctx.outlets);
        const startedAt = new Date(day);
        startedAt.setHours(9 + rand(8), rand(60));
        const ordered = Math.random() < 0.75;

        await tx.visit.create({
          data: {
            companyId,
            agentId: agent.id,
            outletId: outlet.id,
            startedAt,
            endedAt: new Date(startedAt.getTime() + 10 * 60 * 1000),
            latitude: jitterCoord(TASHKENT_CENTER.lat, 0.16),
            longitude: jitterCoord(TASHKENT_CENTER.lng, 0.16),
            gpsOk: true,
            outcome: ordered ? VisitOutcome.ORDERED : VisitOutcome.NO_ORDER,
            noOrderReason: ordered ? null : pick(['Qoldiq yetarli', 'Yopiq edi', 'Qarzi bor']),
          },
        });

        if (!ordered) continue;

        const lineCount = 1 + rand(5);
        const lines: {
          productId: string;
          packagingId: string;
          qty: number;
          unitPrice: number;
          discountPct: number;
          vatRate: number;
          lineTotal: number;
        }[] = [];
        for (let l = 0; l < lineCount; l++) {
          // Only ever sell what the ledger says is actually on hand — the
          // seed used to issue random qty*packaging combinations without
          // checking availability, which drove several SKUs' onHand
          // negative (a single "quti" line could consume 96x its qty).
          const productsInStock = ctx.products.filter((p) => (ctx.stockLedger[p.id] ?? 0) > 0);
          if (productsInStock.length === 0) break;

          const product = pick(productsInStock);
          const affordablePackagings = ctx.packagingsByProduct[product.id]!.filter(
            (p) => ctx.stockLedger[product.id]! >= p.qtyInBaseUnit,
          );
          if (affordablePackagings.length === 0) continue;

          const packaging = pick(affordablePackagings);
          const maxQty = Math.floor(ctx.stockLedger[product.id]! / packaging.qtyInBaseUnit);
          const qty = 1 + rand(Math.min(20, maxQty));
          const unitPrice = round2(2000 + rand(20000));
          const discountPct = pick([0, 0, 0, 5]);
          const lineTotal = round2(qty * unitPrice * (1 - discountPct / 100) * (1 + product.vatRate / 100));

          ctx.stockLedger[product.id]! -= qty * packaging.qtyInBaseUnit;
          lines.push({
            productId: product.id,
            packagingId: packaging.id,
            qty,
            unitPrice,
            discountPct,
            vatRate: product.vatRate,
            lineTotal,
          });
        }
        if (lines.length === 0) continue;

        const orderTotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
        // Every third delivered order was handed to the kuryer instead of
        // being delivered by the agent, so the courier screens have data.
        const deliveredByCourier = soSeq % 3 === 0;
        const order = await tx.salesOrder.create({
          data: {
            companyId,
            number: `SO-${year}-${String(soSeq++).padStart(6, '0')}`,
            customerId: outlet.customerId,
            outletId: outlet.id,
            agentId: agent.id,
            courierId: deliveredByCourier ? ctx.courierId : null,
            warehouseId: ctx.warehouseId,
            status: OrderStatus.DELIVERED,
            createdAt: startedAt,
            lines: { create: lines },
          },
        });

        // Historical order already delivered — net stock effect is consumption.
        for (const line of lines) {
          const packagingsForProduct = ctx.packagingsByProduct[line.productId] ?? [];
          const packaging = packagingsForProduct.find((p) => p.id === line.packagingId)!;
          const baseQty = line.qty * packaging.qtyInBaseUnit;
          await tx.stockMovement.create({
            data: {
              companyId,
              productId: line.productId,
              warehouseId: ctx.warehouseId,
              type: StockMovementType.ISSUE,
              qty: -baseQty,
              refType: 'SalesOrder',
              refId: order.id,
            },
          });
          await tx.stockLevel.updateMany({
            where: { productId: line.productId, warehouseId: ctx.warehouseId },
            data: { onHand: { decrement: baseQty } },
          });
        }

        const invoice = await tx.invoice.create({
          data: {
            companyId,
            number: `INV-${year}-${String(invSeq++).padStart(6, '0')}`,
            customerId: outlet.customerId,
            orderId: order.id,
            total: orderTotal,
            status: InvoiceStatus.OPEN,
            createdAt: startedAt,
            lines: {
              create: lines.map((l) => ({
                productId: l.productId,
                qty: l.qty,
                unitPrice: l.unitPrice,
                vatRate: l.vatRate,
                lineTotal: l.lineTotal,
              })),
            },
          },
        });

        // ~70% of historical invoices get paid (fully or partially) so the
        // aging/receivables screens have something real to show.
        const paymentRoll = Math.random();
        if (paymentRoll < 0.7) {
          const paidAmount = paymentRoll < 0.5 ? orderTotal : round2(orderTotal * (0.3 + Math.random() * 0.5));
          const payment = await tx.payment.create({
            data: {
              companyId,
              number: `PAY-${year}-${String(paySeq++).padStart(6, '0')}`,
              customerId: outlet.customerId,
              amount: paidAmount,
              method: pick([PaymentMethod.CASH, PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.TRANSFER]),
              collectedBy: agent.id,
              createdAt: new Date(startedAt.getTime() + 24 * 3600 * 1000),
            },
          });
          await tx.paymentAllocation.create({
            data: { paymentId: payment.id, invoiceId: invoice.id, amount: paidAmount },
          });
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { status: paidAmount >= orderTotal ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID },
          });
          await tx.customer.update({
            where: { id: outlet.customerId },
            data: { cachedBalance: { increment: orderTotal - paidAmount } },
          });
        } else {
          await tx.customer.update({
            where: { id: outlet.customerId },
            data: { cachedBalance: { increment: orderTotal } },
          });
        }
      }
    }
  }

  // This function numbers documents with its own local counters instead of
  // apps/api's DocumentNumberingService (packages/database can't depend on
  // an apps/api NestJS service). Sync DocumentCounter to match what was
  // actually used, so the first real order created through the API
  // continues the sequence instead of colliding with seeded numbers.
  await tx.documentCounter.upsert({
    where: { companyId_docType_year: { companyId, docType: 'SO', year } },
    update: { lastNumber: soSeq - 1 },
    create: { companyId, docType: 'SO', year, lastNumber: soSeq - 1 },
  });
  await tx.documentCounter.upsert({
    where: { companyId_docType_year: { companyId, docType: 'INV', year } },
    update: { lastNumber: invSeq - 1 },
    create: { companyId, docType: 'INV', year, lastNumber: invSeq - 1 },
  });
  await tx.documentCounter.upsert({
    where: { companyId_docType_year: { companyId, docType: 'PAY', year } },
    update: { lastNumber: paySeq - 1 },
    create: { companyId, docType: 'PAY', year, lastNumber: paySeq - 1 },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await systemPrisma.$disconnect();
    await prisma.$disconnect();
  });
