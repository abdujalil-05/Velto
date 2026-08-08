import { memoryStorage } from 'multer';
import { Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ListImportsQueryDto } from './dto/list-imports.query';
import { validateImportFile } from './file-validation';
import { ImportService } from './import.service';
import { buildCustomersImportTemplate, buildProductsImportTemplate } from './templates';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Onboarding/bulk-import is company setup, not routine daily work — gated
// like warehouse creation (stock/warehouses/warehouses.controller.ts),
// which also matches 9.2's onboarding wizard being OWNER-only.
const IMPORT_READ = 'settings.read';
const IMPORT_WRITE = 'settings.update';

@Controller('import')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Get('customers/template')
  @RequirePermission(IMPORT_READ)
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="customers-import-template.xlsx"')
  async customersTemplate() {
    return new StreamableFile(await buildCustomersImportTemplate());
  }

  @Get('products/template')
  @RequirePermission(IMPORT_READ)
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="products-import-template.xlsx"')
  async productsTemplate() {
    return new StreamableFile(await buildProductsImportTemplate());
  }

  @Post('customers')
  @RequirePermission(IMPORT_WRITE)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadCustomers(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    const buffer = validateImportFile(file);
    return this.importService.uploadAndValidate('customers', buffer, user);
  }

  @Post('products')
  @RequirePermission(IMPORT_WRITE)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadProducts(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    const buffer = validateImportFile(file);
    return this.importService.uploadAndValidate('products', buffer, user);
  }

  @Get()
  @RequirePermission(IMPORT_READ)
  list(@Query() query: ListImportsQueryDto) {
    return this.importService.list(query);
  }

  // Polled right after upload for the "validatsiya xatolari jadvali" review
  // screen (9.2), then again after confirm() until status is DONE/FAILED.
  @Get(':id')
  @RequirePermission(IMPORT_READ)
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.importService.getById(id);
  }

  @Post(':id/confirm')
  @RequirePermission(IMPORT_WRITE)
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.importService.confirm(id, user);
  }
}
