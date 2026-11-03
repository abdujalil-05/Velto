import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/** Optional `Idempotency-Key` replay for mutating routes (TZ 7.1). Replays stored status+body for 72h. */
export const Idempotent = () => applyDecorators(UseInterceptors(IdempotencyInterceptor));
