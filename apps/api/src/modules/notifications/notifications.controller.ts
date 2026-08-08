import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ListNotificationsQueryDto } from './dto/list-notifications.query';
import { NotificationsService } from './notifications.service';

// No @RequirePermission anywhere here: every route is inherently scoped to
// the caller's own notifications (CurrentUser().id) — there's no
// permission concept for "read your own inbox" beyond being authenticated,
// which JwtAuthGuard/TenantContextInterceptor already enforce.
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query() query: ListNotificationsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.list(user.id, query);
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  @Post(':id/read')
  markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(id, user.id);
  }

  @Post('read-all')
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    await this.notifications.markAllRead(user.id);
    return { success: true };
  }
}
