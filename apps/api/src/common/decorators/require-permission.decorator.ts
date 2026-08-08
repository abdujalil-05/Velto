import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/** RBAC per SEC-020..024: `module.action` format, e.g. `customers.read`. Checked by TenantContextInterceptor. */
export const RequirePermission = (permission: string) => SetMetadata(REQUIRE_PERMISSION_KEY, permission);
