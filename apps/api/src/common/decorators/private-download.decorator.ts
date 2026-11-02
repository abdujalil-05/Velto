import { Header, SetMetadata, applyDecorators } from '@nestjs/common';

export const REQUIRE_ACTIVE_SESSION_KEY = 'requireActiveSession';

/** Re-checks (per request, in DB) that the token's session was not revoked. Enforced by TenantContextInterceptor. */
export const RequireActiveSession = () => SetMetadata(REQUIRE_ACTIVE_SESSION_KEY, true);

/**
 * Private file/report download: live-session check (401 AUTH_SESSION_EXPIRED after logout) and
 * `Cache-Control: private, no-store` so no browser/proxy cache keeps tenant data.
 */
export const PrivateDownload = () =>
  applyDecorators(RequireActiveSession(), Header('Cache-Control', 'private, no-store'), Header('Pragma', 'no-cache'));
