import { Body, Controller, Get, Post, Query } from '@nestjs/common';
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

  @Get('pull')
  @RequirePermission('field.read')
  pull(@Query() query: SyncPullQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sync.pull(query.since, query.agentId, user);
  }

  @Post('push')
  @RequirePermission('field.create')
  push(@Body() dto: SyncPushDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sync.push(dto.documents, user);
  }
}
