import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

export class CustomerNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'CUSTOMER_NOT_FOUND', {
      uz: 'Mijoz topilmadi',
      ru: 'Клиент не найден',
      en: 'Customer not found',
    });
  }
}

export class DuplicateCustomerCodeException extends AppException {
  constructor(code: string) {
    super(
      HttpStatus.CONFLICT,
      'CUSTOMER_DUPLICATE_CODE',
      {
        uz: `"${code}" kodli mijoz allaqachon mavjud`,
        ru: `Клиент с кодом "${code}" уже существует`,
        en: `A customer with code "${code}" already exists`,
      },
      { code },
    );
  }
}

export class OutletNotFoundException extends AppException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', {
      uz: 'Savdo nuqtasi topilmadi',
      ru: 'Торговая точка не найдена',
      en: 'Outlet not found',
    });
  }
}

export class PriceListNotFoundForCustomerException extends AppException {
  constructor() {
    super(HttpStatus.BAD_REQUEST, 'PRICE_LIST_NOT_FOUND', {
      uz: "Narx ro'yxati topilmadi",
      ru: 'Прайс-лист не найден',
      en: 'Price list not found',
    });
  }
}

export class CustomerAlreadyBlockedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'CUSTOMER_ALREADY_BLOCKED', {
      uz: 'Mijoz allaqachon bloklangan',
      ru: 'Клиент уже заблокирован',
      en: 'Customer is already blocked',
    });
  }
}

export class CustomerNotBlockedException extends AppException {
  constructor() {
    super(HttpStatus.CONFLICT, 'CUSTOMER_NOT_BLOCKED', {
      uz: 'Mijoz bloklanmagan',
      ru: 'Клиент не заблокирован',
      en: 'Customer is not blocked',
    });
  }
}
