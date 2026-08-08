import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class ProductNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'PRODUCT_NOT_FOUND', {
      uz: 'Mahsulot topilmadi',
      ru: 'Товар не найден',
      en: 'Product not found',
    });
  }
}

export class DuplicateSkuException extends AppException {
  constructor(sku: string) {
    super(
      HttpStatus.CONFLICT,
      'PRODUCT_DUPLICATE_SKU',
      {
        uz: `"${sku}" SKU bilan mahsulot allaqachon mavjud`,
        ru: `Товар с артикулом "${sku}" уже существует`,
        en: `A product with SKU "${sku}" already exists`,
      },
      { sku },
    );
  }
}

export class CategoryNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'CATEGORY_NOT_FOUND', {
      uz: 'Kategoriya topilmadi',
      ru: 'Категория не найдена',
      en: 'Category not found',
    });
  }
}

export class DuplicateCategoryException extends AppException {
  constructor(name: string) {
    super(
      HttpStatus.CONFLICT,
      'CATEGORY_DUPLICATE_NAME',
      {
        uz: `"${name}" nomli kategoriya shu joyda allaqachon mavjud`,
        ru: `Категория с названием "${name}" уже существует здесь`,
        en: `A category named "${name}" already exists here`,
      },
      { name },
    );
  }
}

export class InvalidPackagingException extends AppException {
  constructor(message: string) {
    super(HttpStatus.BAD_REQUEST, 'PRODUCT_INVALID_PACKAGING', {
      uz: message,
      ru: 'Некорректная упаковка товара',
      en: 'Invalid product packaging',
    });
  }
}

export class PackagingInUseException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'PRODUCT_PACKAGING_IN_USE', {
      uz: "Bu qadoqlash birligi buyurtmalarda ishlatilgan bo'lgani uchun uni o'chirib bo'lmaydi",
      ru: 'Эта упаковка уже использована в заказах, её нельзя удалить',
      en: 'This packaging is referenced by existing orders and cannot be removed',
    });
  }
}

export class PriceListNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'PRICE_LIST_NOT_FOUND', {
      uz: "Narx ro'yxati topilmadi",
      ru: 'Прайс-лист не найден',
      en: 'Price list not found',
    });
  }
}

export class UnknownProductsException extends AppException {
  constructor(productIds: string[]) {
    super(
      HttpStatus.BAD_REQUEST,
      'PRICE_LIST_UNKNOWN_PRODUCTS',
      {
        uz: "Ba'zi mahsulotlar topilmadi",
        ru: 'Некоторые товары не найдены',
        en: 'Some products could not be found',
      },
      { productIds },
    );
  }
}

export class InvalidImageException extends AppException {
  constructor(reason: string) {
    super(
      HttpStatus.BAD_REQUEST,
      'PRODUCT_INVALID_IMAGE',
      {
        uz: "Rasm formati yoki hajmi noto'g'ri",
        ru: 'Некорректный формат или размер изображения',
        en: 'Invalid image format or size',
      },
      { reason },
    );
  }
}
