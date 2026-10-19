import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { toExportJobView } from '../integrations/export-1c/dto/export-job.view';
import { ListExportsQueryDto } from '../integrations/export-1c/dto/list-exports.query';
import { CompanyExportDownloadService } from './company-export-download.service';
import { CompanyExportService } from './company-export.service';

const PER_MINUTE = 60_000;

/** ADR-045: OWNER-only (`company.export`). There is deliberately NO delete-all endpoint (§11.7.2). */
@Controller('company-export')
export class CompanyExportController {
  constructor(
    private readonly exports: CompanyExportService,
    private readonly downloads: CompanyExportDownloadService,
  ) {}

  @Post()
  @RequirePermission('company.export')
  @Throttle({ default: { limit: 1, ttl: PER_MINUTE } })
  @Idempotent()
  async create(@CurrentUser() user: AuthenticatedUser) {
    return toExportJobView(await this.exports.create(user));
  }

  @Get()
  @RequirePermission('company.export')
  async list(@Query() query: ListExportsQueryDto) {
    const page = await this.exports.list(query);
    return { ...page, data: page.data.map(toExportJobView) };
  }

  @Get(':id')
  @RequirePermission('company.export')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    return toExportJobView(await this.exports.getById(id));
  }

  @Get(':id/download')
  @RequirePermission('company.export')
  @Throttle({ default: { limit: 30, ttl: PER_MINUTE } })
  async download(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) {
    const file = await this.downloads.download(id, user);
    res.setHeader('X-Content-SHA256', file.fileHash);
    return new StreamableFile(file.stream, { type: file.mimeType, disposition: `attachment; filename="${file.fileName}"`, length: file.size });
  }
}
