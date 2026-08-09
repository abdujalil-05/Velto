'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { Role } from '@/lib/api/roles';
import type { CreateUserInput } from '@/lib/api/users';

const PHONE_DIGITS_RE = /^\d{9}$/;

function userSchema(t: (key: string) => string) {
  return z.object({
    firstName: z.string().min(1, t('required')).max(100),
    lastName: z.string().min(1, t('required')).max(100),
    phoneDigits: z.string().regex(PHONE_DIGITS_RE, t('phoneInvalid')),
    email: z.string().email(t('emailInvalid')).max(200).optional().or(z.literal('')),
    // Optional in both modes: create allows Telegram-only agents with no password;
    // edit leaves the password unchanged when blank.
    password: z.string().min(10, t('passwordTooShort')).optional().or(z.literal('')),
    roleCodes: z.array(z.string()).min(1, t('roleRequired')),
  });
}

export type UserFormValues = z.infer<ReturnType<typeof userSchema>>;

interface UserFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<UserFormValues>;
  roles: Role[];
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: CreateUserInput) => void;
}

export function UserForm({ mode, defaultValues, roles, isSubmitting, submitError, onSubmit }: UserFormProps) {
  const t = useTranslations('Users.form');
  // Role display names are localised under AppShell.roles keyed by role code —
  // `role.name` off the API is the untranslated backend catalog name.
  const tRoles = useTranslations('AppShell.roles');

  const schema = userSchema(t);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<UserFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { roleCodes: [], ...defaultValues },
  });

  const selectedRoles = watch('roleCodes') ?? [];

  function toggleRole(code: string) {
    const next = selectedRoles.includes(code) ? selectedRoles.filter((c) => c !== code) : [...selectedRoles, code];
    setValue('roleCodes', next, { shouldValidate: true });
  }

  function submit(values: UserFormValues) {
    onSubmit({
      firstName: values.firstName,
      lastName: values.lastName,
      phone: `+998${values.phoneDigits}`,
      email: values.email || undefined,
      password: values.password || undefined,
      roleCodes: values.roleCodes,
    });
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit(submit)} noValidate>
      {submitError && (
        <Alert variant="destructive">
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="firstName">{t('firstName')}</Label>
          <Input id="firstName" {...register('firstName')} aria-invalid={!!errors.firstName} />
          {errors.firstName && <p className="text-sm text-destructive">{errors.firstName.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName">{t('lastName')}</Label>
          <Input id="lastName" {...register('lastName')} aria-invalid={!!errors.lastName} />
          {errors.lastName && <p className="text-sm text-destructive">{errors.lastName.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phoneDigits">{t('phone')}</Label>
          <div className="flex h-10 items-center rounded-md border border-input bg-background pl-3 ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
            <span className="text-base text-muted-foreground">+998</span>
            <input
              id="phoneDigits"
              type="tel"
              inputMode="numeric"
              maxLength={9}
              className="h-full flex-1 bg-transparent px-2 text-base outline-none md:text-sm"
              aria-invalid={!!errors.phoneDigits}
              {...register('phoneDigits', {
                onChange: (e) => {
                  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 9);
                },
              })}
            />
          </div>
          {errors.phoneDigits && <p className="text-sm text-destructive">{errors.phoneDigits.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">{t('email')}</Label>
          <Input id="email" type="email" {...register('email')} aria-invalid={!!errors.email} />
          {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="password">{mode === 'create' ? t('password') : t('passwordEdit')}</Label>
          <Input id="password" type="password" autoComplete="new-password" {...register('password')} aria-invalid={!!errors.password} />
          <p className="text-xs text-muted-foreground">{mode === 'create' ? t('passwordHint') : t('passwordEditHint')}</p>
          {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t('roles')}</Label>
        <div className="grid grid-cols-1 gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
          {roles.map((role) => (
            <label key={role.code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedRoles.includes(role.code)}
                onChange={() => toggleRole(role.code)}
                className="h-4 w-4 rounded border-input"
              />
              {tRoles(role.code)}
            </label>
          ))}
        </div>
        {errors.roleCodes && <p className="text-sm text-destructive">{errors.roleCodes.message}</p>}
      </div>

      <Button type="submit" size="lg" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t(mode === 'create' ? 'submitCreate' : 'submitUpdate')}
      </Button>
    </form>
  );
}
