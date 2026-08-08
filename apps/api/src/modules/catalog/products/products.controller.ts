import { memoryStorage } from 'multer';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { StorageService } from '../../../common/storage/storage.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQueryDto } from './dto/list-products.query';
import { UpdateProductDto } from './dto/update-product.dto';
import { validateProductImage } from './image-validation';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @RequirePermission('catalog.read')
  list(@Query() query: ListProductsQueryDto) {
    return this.products.list(query);
  }

  @Get(':id')
  @RequirePermission('catalog.read')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.getById(id);
  }

  @Post()
  @RequirePermission('catalog.create')
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthenticatedUser) {
    return this.products.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('catalog.update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: AuthenticatedUser) {
    return this.products.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermission('catalog.delete')
  softDelete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.products.softDelete(id, user);
  }

  @Post(':id/image')
  @RequirePermission('catalog.update')
  @UseInterceptors(FileInterceptor('image', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async uploadImage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { mimeType, extension } = validateProductImage(file);
    const imageUrl = await this.storage.upload({
      buffer: file!.buffer,
      mimeType,
      extension,
      keyPrefix: `products/${user.companyId}`,
    });
    return this.products.setImage(id, imageUrl, user);
  }
}
