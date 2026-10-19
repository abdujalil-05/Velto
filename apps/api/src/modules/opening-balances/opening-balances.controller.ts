import { memoryStorage } from 'multer';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { OpeningBalanceKind } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ReverseReasonDto } from '../../common/dto/reverse-reason.dto';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { TenantTx } from '../../common/tenant/tenant-tx-options.decorator';
import { validateSpreadsheetUpload } from '../import/file-validation';
import { ListOpeningBatchesQueryDto } from './dto/list-opening-batches.query';
import { PostOpeningBatchDto } from './dto/post-opening-batch.dto';
import { OPENING_TX_OPTIONS } from './opening-balances.constants';
import { OpeningBalancesService } from './opening-balances.service';

const FILE_UPLOAD = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * F6 opening balances (ADR-041..043). preview/read: `opening.read` (OWNER,
 * ACCOUNTANT — preview writes no ledger row); post/void: OWNER only.
 */
@Controller('opening-balances')
export class OpeningBalancesController {
  constructor(private readonly openingBalances: OpeningBalancesService) {}

  @Post('customers/preview')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('opening.read')
  @TenantTx(OPENING_TX_OPTIONS)
  @UseInterceptors(FILE_UPLOAD)
  previewCustomers(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    const { buffer, format } = validateSpreadsheetUpload(file);
    return this.openingBalances.preview(OpeningBalanceKind.CUSTOMER_BALANCE, { buffer, format, fileName: file!.originalname }, user);
  }

  @Post('stock/preview')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('opening.read')
  @TenantTx(OPENING_TX_OPTIONS)
  @UseInterceptors(FILE_UPLOAD)
  previewStock(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    const { buffer, format } = validateSpreadsheetUpload(file);
    return this.openingBalances.preview(OpeningBalanceKind.STOCK, { buffer, format, fileName: file!.originalname }, user);
  }

  @Get()
  @RequirePermission('opening.read')
  list(@Query() query: ListOpeningBatchesQueryDto) {
    return this.openingBalances.list(query);
  }

  @Get(':id')
  @RequirePermission('opening.read')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.openingBalances.getById(id);
  }

  @Post(':id/post')
  @Idempotent()
  @RequirePermission('opening.post')
  @TenantTx(OPENING_TX_OPTIONS)
  post(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostOpeningBatchDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingBalances.post(id, dto, user);
  }

  @Post(':id/void')
  @Idempotent()
  @RequirePermission('opening.void')
  @TenantTx(OPENING_TX_OPTIONS)
  void(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReverseReasonDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingBalances.void(id, dto.reason, user);
  }
}
