import { Prisma, type TenantClient } from '@velto/database';

/**
 * F-M01 / 6.3: "Dublikat aniqlash telefon, koordinata (50m radius) va
 * nom o'xshashligi bo'yicha ogohlantirish beradi" — these are WARNINGS, not
 * hard blocks. Callers surface `warnings` alongside the created/updated
 * record rather than rejecting the request.
 */
export interface DuplicateWarning {
  type: 'PHONE' | 'NAME_SIMILARITY' | 'LOCATION_PROXIMITY';
  customerId: string;
  customerName: string;
  detail: string;
}

const NAME_SIMILARITY_THRESHOLD = 0.4;
const LOCATION_RADIUS_METERS = 50;

export async function findCustomerDuplicates(
  tx: TenantClient,
  input: { name: string; phone?: string | null },
  excludeCustomerId?: string,
): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  const excludeFilter: Prisma.CustomerWhereInput = excludeCustomerId ? { NOT: { id: excludeCustomerId } } : {};

  if (input.phone) {
    const matches = await tx.customer.findMany({
      where: { phone: input.phone, deletedAt: null, ...excludeFilter },
      select: { id: true, name: true },
    });
    warnings.push(...matches.map((c) => toWarning('PHONE', c, input.phone!)));
  }

  const excludeClause = excludeCustomerId ? Prisma.sql`AND id != ${excludeCustomerId}::uuid` : Prisma.empty;
  const nameMatches = await tx.$queryRaw<{ id: string; name: string; score: number }[]>(Prisma.sql`
    SELECT id, name, similarity(name, ${input.name}) AS score
    FROM "Customer"
    WHERE "deletedAt" IS NULL
      ${excludeClause}
      AND similarity(name, ${input.name}) > ${NAME_SIMILARITY_THRESHOLD}
    ORDER BY score DESC
    LIMIT 5
  `);
  warnings.push(
    ...nameMatches.map((c) => toWarning('NAME_SIMILARITY', c, `${Math.round(c.score * 100)}% o'xshash`)),
  );

  return warnings;
}

export async function findOutletLocationDuplicates(
  tx: TenantClient,
  latitude: number,
  longitude: number,
  excludeOutletId?: string,
): Promise<DuplicateWarning[]> {
  // Generous bounding box first (cheap index-friendly range scan); the exact
  // 50m radius is enforced by the haversine check below.
  const box = 0.001;
  const candidates = await tx.outlet.findMany({
    where: {
      deletedAt: null,
      latitude: { gte: latitude - box, lte: latitude + box },
      longitude: { gte: longitude - box, lte: longitude + box },
      ...(excludeOutletId ? { NOT: { id: excludeOutletId } } : {}),
    },
    include: { customer: { select: { id: true, name: true } } },
  });

  const warnings: DuplicateWarning[] = [];
  for (const outlet of candidates) {
    if (outlet.latitude == null || outlet.longitude == null) continue;
    const distance = haversineMeters(latitude, longitude, Number(outlet.latitude), Number(outlet.longitude));
    if (distance <= LOCATION_RADIUS_METERS) {
      warnings.push({
        type: 'LOCATION_PROXIMITY',
        customerId: outlet.customer.id,
        customerName: outlet.customer.name,
        detail: `${Math.round(distance)}m (${outlet.name})`,
      });
    }
  }
  return warnings;
}

function toWarning(type: DuplicateWarning['type'], c: { id: string; name: string }, detail: string): DuplicateWarning {
  return { type, customerId: c.id, customerName: c.name, detail };
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusMeters = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}
