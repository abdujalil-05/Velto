import { ConfigService } from '@nestjs/config';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { NotificationsService } from './notifications.service';
import { OwnerAlertsService } from './owner-alerts';

/** Real OwnerAlertsService for tests that build Stock/Payments services with `new` (no delivery queue). */
export const makeOwnerAlerts = (tenantPrisma: TenantPrismaService) => new OwnerAlertsService(new NotificationsService(tenantPrisma, new ConfigService()));
