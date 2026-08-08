'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useRolesQuery } from '@/lib/api/roles';
import { useCreateUserMutation, type CreateUserInput } from '@/lib/api/users';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserForm } from '@/components/users/user-form';

export default function NewUserPage() {
  const t = useTranslations('Users.form');
  const locale = useLocale();
  const router = useRouter();
  const { data: roles, isLoading: rolesLoading } = useRolesQuery();
  const createMutation = useCreateUserMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleSubmit(input: CreateUserInput) {
    setSubmitError(null);
    createMutation.mutate(input, {
      onSuccess: () => {
        toast.success(t('created'));
        router.push('/users');
      },
      onError: (err) => setSubmitError(errorMessage(err, locale)),
    });
  }

  return (
    <div className="space-y-4">
      <Link href="/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <h1 className="text-xl font-semibold">{t('createTitle')}</h1>

      <Card>
        <CardContent className="pt-6">
          {rolesLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <UserForm
              mode="create"
              roles={roles ?? []}
              isSubmitting={createMutation.isPending}
              submitError={submitError}
              onSubmit={handleSubmit}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
