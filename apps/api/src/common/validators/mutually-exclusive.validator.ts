import { isUUID, registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isValidUuidIfSet(value: unknown): boolean {
  return !isSet(value) || (typeof value === 'string' && isUUID(value));
}

/**
 * "Exactly one of these two UUID properties must be provided" — apply to
 * both properties, each naming the other. Used by CreateRouteDto (9.x
 * courier delivery flow): a route is served either by an own field agent
 * (`agentId`) or by a kuryer (`courierId`), never
 * both and never neither — the same invariant the DB enforces with a CHECK
 * constraint (see schema.prisma's `Route` model doc).
 *
 * Deliberately does its own UUID-format check inline rather than being
 * stacked alongside a separate `@IsOptional() @IsUUID()` pair: class-validator's
 * `@IsOptional()` skips *every* decorator on a property (including custom
 * ones) once the value is undefined, which would silently skip this check
 * too on the exact case it exists to catch — neither property provided.
 */
export function ExactlyOneUuidOf(otherProperty: string, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'exactlyOneUuidOf',
      target: object.constructor,
      propertyName,
      constraints: [otherProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [other] = args.constraints as [string];
          const otherValue = (args.object as Record<string, unknown>)[other];
          if (!isValidUuidIfSet(value)) return false;
          return isSet(value) !== isSet(otherValue);
        },
        defaultMessage(args: ValidationArguments) {
          const [other] = args.constraints as [string];
          return `Exactly one of "${args.property}" or "${other}" must be provided, as a UUID`;
        },
      },
    });
  };
}

/**
 * "At most one of these two UUID properties may be provided" — the
 * partial-update counterpart of ExactlyOneUuidOf above: neither field
 * present means "leave the route's current agent/courier assignment
 * unchanged" (a valid no-op for a PATCH), but both present at once is still
 * rejected outright rather than left for the DB's CHECK constraint to 500
 * on. Same inline-UUID-check reasoning as ExactlyOneUuidOf re: `@IsOptional()`.
 */
export function AtMostOneUuidOf(otherProperty: string, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'atMostOneUuidOf',
      target: object.constructor,
      propertyName,
      constraints: [otherProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [other] = args.constraints as [string];
          const otherValue = (args.object as Record<string, unknown>)[other];
          if (!isValidUuidIfSet(value)) return false;
          return !(isSet(value) && isSet(otherValue));
        },
        defaultMessage(args: ValidationArguments) {
          const [other] = args.constraints as [string];
          return `Only one of "${args.property}" or "${other}" may be provided, and must be a UUID`;
        },
      },
    });
  };
}
