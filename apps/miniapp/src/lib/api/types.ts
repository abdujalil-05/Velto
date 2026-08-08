// Mirrors apps/api/src/common/auth/auth.types.ts — kept in sync by hand since
// the web app has no shared-types package with the API (11.2 lists no such package).
export interface AuthenticatedUser {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  roles: string[];
  permissions: string[]; // "module.action", e.g. "orders.create"
}

export interface PublicUser {
  id: string;
  firstName: string;
  lastName: string;
  roles: string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

// 7.1/9.1/14.6: API errors are always { code, message, details }, with
// `message` pre-translated into all three locales by the backend
// (apps/api/src/common/errors/app-exception.ts).
export interface LocalizedMessage {
  uz: string;
  ru: string;
  en: string;
}

export interface ApiErrorBody {
  code: string;
  message: LocalizedMessage;
  details?: unknown;
}

// Mirrors apps/api/src/common/pagination/pagination.dto.ts.
export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}
