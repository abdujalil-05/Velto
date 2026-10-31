import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { requestMeta } from '../auth/session-http';
import { TenantTx } from '../../common/tenant/tenant-tx-options.decorator';
import { IssueMfaEnrollmentCodeDto } from './dto/issue-mfa-enrollment-code.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { DeleteUserQueryDto } from './dto/delete-user.query';
import { ListUsersQueryDto } from './dto/list-users.query';
import { ResetMfaDto } from './dto/reset-mfa.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users.read')
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermission('users.read')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.getById(id);
  }

  @Post()
  @RequirePermission('users.create')
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.users.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('users.update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.users.update(id, dto, user);
  }

  @Post(':id/deactivate')
  @RequirePermission('users.update')
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.users.deactivate(id, user);
  }

  /** ADR-058 step-up stage 1: challenge bound to this session + target (5 min, 5 attempts). */
  @Post(':id/mfa/reset/challenge')
  @RequirePermission('users.mfa_reset')
  @TenantTx({ scope: 'handler' })
  createMfaResetChallenge(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.users.createMfaResetChallenge(id, user, requestMeta(req));
  }

  /** ADR-058 step-up stage 2: needs the challenge + OWNER password + current TOTP; clears the target's TOTP + recovery codes, revokes their sessions, issues a new enrollment code. */
  @Post(':id/mfa/reset')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users.mfa_reset')
  @TenantTx({ scope: 'handler' })
  resetMfa(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetMfaDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.users.resetMfa(id, dto, user, requestMeta(req));
  }

  /** ADR-058: one-time out-of-band code (1h); requires currentPassword + the actor's TOTP/recovery code a privileged user without TOTP must present to enroll. Returned once, never logged. */
  @Post(':id/mfa/enrollment-code')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users.mfa_reset')
  @TenantTx({ scope: 'handler' })
  issueMfaEnrollmentCode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueMfaEnrollmentCodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.users.issueMfaEnrollmentCode(id, dto, user, requestMeta(req));
  }

  /** Returns 200 with `{ mode: 'soft' | 'hard', references }` — a soft delete is a successful outcome, not a partial failure. */
  @Delete(':id')
  @RequirePermission('users.delete')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteUserQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.remove(id, query, user);
  }

  @Post(':id/activate')
  @RequirePermission('users.update')
  activate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.users.activate(id, user);
  }

  // Revokes a Telegram link (the read side is `telegramLinked` on every user
  // response). 'users.update', not 'users.delete': it edits an attribute of a
  // user who stays, same as deactivate/activate above.
  @Delete(':id/telegram')
  @RequirePermission('users.update')
  unlinkTelegram(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.users.unlinkTelegram(id, user);
  }
}
