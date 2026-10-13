import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';

/** 10.3 / F4: a push batch larger than the configured SYNC_PUSH_MAX_BATCH. */
export class SyncBatchTooLargeException extends AppException {
  constructor(max: number, received: number) {
    super(
      HttpStatus.BAD_REQUEST,
      'SYNC_BATCH_TOO_LARGE',
      {
        uz: `Bir so'rovda ko'pi bilan ${max} ta hujjat yuborish mumkin`,
        ru: `За один запрос можно отправить не более ${max} документов`,
        en: `At most ${max} documents can be pushed per request`,
      },
      { max, received },
    );
  }
}
