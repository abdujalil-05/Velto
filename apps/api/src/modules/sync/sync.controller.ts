import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SyncPullQueryDto } from './dto/sync-pull.query';
import { SyncPushDto } from './dto/sync-push.dto';
import { SyncService } from './sync.service';

/** 7.3/10: offline-first sync for the agent's Telegram Mini App — gated by the existing `field.*` permissions (M06 Dala). */
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  // SEC-015: per-user buckets (UserThrottlerGuard). One push request = 1 hit regardless of batch size.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('pull')
  @RequirePermission('field.read')
  pull(@Query() query: SyncPullQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sync.pull({ cursor: query.cursor ?? query.since, limit: query.limit, agentId: query.agentId }, user);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('push')
  @RequirePermission('field.create')
  push(@Body() dto: SyncPushDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sync.push(dto.documents, user);
  }
}
