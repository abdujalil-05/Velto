import { registerDecorator, type ValidationOptions } from 'class-validator';

// SEC-010: "keng tarqalgan parollarga qarshi tekshiruv" — a small denylist of
// the passwords real users pick most often (English + common local patterns).
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'qwerty123', '11111111', '00000000', 'iloveyou1', 'admin1234',
  'welcome1', 'welcome123', 'letmein123', 'sunshine1', 'princess1', 'football1',
  'baseball1', 'dragon123', 'monkey123', 'trustno1a', 'abcd12345', 'passw0rd1',
  'p@ssw0rd1', 'uzbekiston', 'toshkent12', 'parol12345', 'parol123456', '999999999',
]);

/** MinLength should be applied alongside this — it only checks the denylist, not length. */
export function NotCommonPassword(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'notCommonPassword',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && !COMMON_PASSWORDS.has(value.toLowerCase());
        },
        defaultMessage() {
          return 'password is too common — choose a less predictable one';
        },
      },
    });
  };
}
