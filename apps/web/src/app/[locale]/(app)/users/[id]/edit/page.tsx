'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useRolesQuery } from '@/lib/api/roles';
import { useUserQuery, useUpdateUserMutation, type CreateUserInput } from '@/lib/api/users';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { UserForm, type UserFormValues } from '@/components/users/user-form';

export default function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('Users.form');
  const locale = useLocale();
  const router = useRouter();

  const { data: user, isLoading, isError, error, refetch } = useUserQuery(id);
  const { data: roles, isLoading: rolesLoading } = useRolesQuery();
  const updateMutation = useUpdateUserMutation(id);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleSubmit(input: CreateUserInput) {
    setSubmitError(null);
    // Blank password field means "leave unchanged" — don't send it.
    const { password, ...rest } = input;
    updateMutation.mutate(
      { ...rest, ...(password ? { password } : {}) },
      {
        onSuccess: () => {
          toast.success(t('updated'));
          router.push('/users');
        },
        onError: (err) => setSubmitError(errorMessage(err, locale)),
      },
    );
  }

  if (isLoading || rolesLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !user) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{errorMessage(error, locale)}</span>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t('retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const defaultValues: Partial<UserFormValues> = {
    firstName: user.firstName,
    lastName: user.lastName,
    phoneDigits: user.phone.replace('+998', ''),
    email: user.email ?? '',
    roleCodes: user.roles.map((r) => r.code),
  };

  return (
    <div className="space-y-4">
      <Link href="/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <h1 className="text-xl font-semibold">{t('editTitle', { name: `${user.firstName} ${user.lastName}` })}</h1>

      <Card>
        <CardContent className="pt-6">
          <UserForm
            mode="edit"
            defaultValues={defaultValues}
            roles={roles ?? []}
            isSubmitting={updateMutation.isPending}
            submitError={submitError}
            onSubmit={handleSubmit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
