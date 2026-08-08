/** Signed into the access token — kept small and never trusted for permission checks (those are re-read from DB per request, see TenantContextInterceptor). */
export interface AccessTokenPayload {
  sub: string; // userId
  companyId: string;
  roles: string[]; // role codes, e.g. ["OWNER"]
}

/** Hydrated fresh from DB every request and attached to `request.user`. */
export interface AuthenticatedUser {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  roles: string[];
  permissions: string[]; // "module.action"
}
