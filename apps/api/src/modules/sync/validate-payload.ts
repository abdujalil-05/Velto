import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * Mirrors the global ValidationPipe (main.ts: whitelist + forbidNonWhitelisted
 * + transform) so a document's `payload` gets exactly the same validation its
 * own dedicated endpoint (POST /orders, /visits, /payments) would apply — a
 * discriminated-union body can't go through the pipe itself, since NestJS has
 * no built-in way to pick a DTO class by a sibling field's value.
 */
export async function validatePayload<T extends object>(cls: new () => T, plain: unknown): Promise<T> {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });

  if (errors.length > 0) {
    throw new BadRequestException({
      code: 'SYNC_VALIDATION_FAILED',
      message: {
        uz: "Hujjat ma'lumotlari noto'g'ri",
        ru: 'Некорректные данные документа',
        en: 'Invalid document data',
      },
      details: errors.map((e) => ({ property: e.property, constraints: e.constraints })),
    });
  }

  return instance;
}
