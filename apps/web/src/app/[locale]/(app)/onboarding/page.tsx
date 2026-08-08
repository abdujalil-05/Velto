'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useSettingsQuery, useUpdateSettingsMutation } from '@/lib/api/settings';
import { useCreateWarehouseMutation } from '@/lib/api/warehouses';
import { useCategoriesQuery } from '@/lib/api/categories';
import { useCreateProductMutation } from '@/lib/api/products';
import { usePriceListsQuery } from '@/lib/api/price-lists';
import { useCreateCustomerMutation, type DuplicateWarning } from '@/lib/api/customers';
import { useRolesQuery } from '@/lib/api/roles';
import { useCreateUserMutation } from '@/lib/api/users';
import { errorMessage } from '@/lib/api/client';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SettingsForm } from '@/components/settings/settings-form';
import { WarehouseStepForm } from '@/components/onboarding/warehouse-step-form';
import { ProductForm } from '@/components/products/product-form';
import { CustomerForm } from '@/components/customers/customer-form';
import { UserForm } from '@/components/users/user-form';
import { StepIndicator } from '@/components/onboarding/step-indicator';

const LAST_STEP = 4;
const DONE_STEP = 5;

export default function OnboardingPage() {
  const t = useTranslations('Onboarding');
  const locale = useLocale();

  const [stepIndex, setStepIndex] = useState(0);
  const [completed, setCompleted] = useState<Set<number>>(new Set());
  const [submitError, setSubmitError] = useState<string | null>(null);

  function markDoneAndAdvance(index: number) {
    setCompleted((prev) => new Set(prev).add(index));
    setSubmitError(null);
    setStepIndex((i) => Math.min(i + 1, DONE_STEP));
  }

  function skip() {
    setSubmitError(null);
    setStepIndex((i) => Math.min(i + 1, DONE_STEP));
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {stepIndex <= LAST_STEP && (
        <StepIndicator currentIndex={stepIndex} completed={completed} onSelect={setStepIndex} />
      )}

      {stepIndex === 0 && <CompanyStep onDone={() => markDoneAndAdvance(0)} onSkip={skip} submitError={submitError} setSubmitError={setSubmitError} locale={locale} />}
      {stepIndex === 1 && <WarehouseStep onDone={() => markDoneAndAdvance(1)} onSkip={skip} submitError={submitError} setSubmitError={setSubmitError} locale={locale} />}
      {stepIndex === 2 && <ProductStep onDone={() => markDoneAndAdvance(2)} onSkip={skip} submitError={submitError} setSubmitError={setSubmitError} locale={locale} />}
      {stepIndex === 3 && <CustomerStep onDone={() => markDoneAndAdvance(3)} onSkip={skip} locale={locale} />}
      {stepIndex === 4 && <AgentStep onDone={() => markDoneAndAdvance(4)} onSkip={skip} submitError={submitError} setSubmitError={setSubmitError} locale={locale} />}
      {stepIndex === DONE_STEP && <DoneStep />}
    </div>
  );
}

interface StepProps {
  onDone: () => void;
  onSkip: () => void;
  submitError: string | null;
  setSubmitError: (v: string | null) => void;
  locale: string;
}

function StepCard({ titleKey, children }: { titleKey: string; children: React.ReactNode }) {
  const t = useTranslations('Onboarding.steps');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(titleKey)}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SkipButton({ onSkip }: { onSkip: () => void }) {
  const t = useTranslations('Onboarding');
  return (
    <Button variant="ghost" size="sm" onClick={onSkip} className="mt-2">
      {t('skip')}
    </Button>
  );
}

function CompanyStep({ onDone, onSkip, submitError, setSubmitError, locale }: StepProps) {
  const { data: settings, isLoading } = useSettingsQuery();
  const updateMutation = useUpdateSettingsMutation();

  return (
    <StepCard titleKey="company">
      {isLoading && <Skeleton className="h-64 w-full" />}
      {settings && (
        <SettingsForm
          settings={settings}
          readOnly={false}
          isSubmitting={updateMutation.isPending}
          submitError={submitError}
          onSubmit={(input) => {
            setSubmitError(null);
            updateMutation.mutate(input, {
              onSuccess: onDone,
              onError: (err) => setSubmitError(errorMessage(err, locale)),
            });
          }}
        />
      )}
      <SkipButton onSkip={onSkip} />
    </StepCard>
  );
}

function WarehouseStep({ onDone, onSkip, submitError, setSubmitError, locale }: StepProps) {
  const createMutation = useCreateWarehouseMutation();
  return (
    <StepCard titleKey="warehouse">
      <WarehouseStepForm
        isSubmitting={createMutation.isPending}
        submitError={submitError}
        onSubmit={(input) => {
          setSubmitError(null);
          createMutation.mutate(input, {
            onSuccess: onDone,
            onError: (err) => setSubmitError(errorMessage(err, locale)),
          });
        }}
      />
      <SkipButton onSkip={onSkip} />
    </StepCard>
  );
}

function ProductStep({ onDone, onSkip, submitError, setSubmitError, locale }: StepProps) {
  const { data: categories } = useCategoriesQuery();
  const createMutation = useCreateProductMutation();
  return (
    <StepCard titleKey="product">
      <ProductForm
        mode="create"
        categories={categories ?? []}
        isSubmitting={createMutation.isPending}
        submitError={submitError}
        onSubmit={(input) => {
          setSubmitError(null);
          createMutation.mutate(input, {
            onSuccess: onDone,
            onError: (err) => setSubmitError(errorMessage(err, locale)),
          });
        }}
      />
      <SkipButton onSkip={onSkip} />
    </StepCard>
  );
}

function CustomerStep({ onDone, onSkip, locale }: Omit<StepProps, 'submitError' | 'setSubmitError'>) {
  const t = useTranslations('Customers.form');
  const { data: priceListsData } = usePriceListsQuery();
  const createMutation = useCreateCustomerMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<DuplicateWarning[] | null>(null);

  return (
    <StepCard titleKey="customer">
      <CustomerForm
        mode="create"
        priceLists={priceListsData?.data ?? []}
        isSubmitting={createMutation.isPending}
        submitError={submitError}
        onSubmit={(input) => {
          setSubmitError(null);
          createMutation.mutate(input, {
            onSuccess: (result) => {
              if (result.warnings.length > 0) {
                setWarnings(result.warnings);
              } else {
                onDone();
              }
            },
            onError: (err) => setSubmitError(errorMessage(err, locale)),
          });
        }}
      />
      <SkipButton onSkip={onSkip} />

      <Dialog open={warnings !== null} onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-warning" />
              {t('duplicateWarningsTitle')}
            </DialogTitle>
          </DialogHeader>
          <ul className="space-y-2 text-sm">
            {warnings?.map((w, i) => (
              <li key={i} className="rounded-md bg-muted p-2">
                <span className="font-medium">{w.customerName}</span> — {t(`duplicateType.${w.type}`)} ({w.detail})
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              onClick={() => {
                setWarnings(null);
                onDone();
              }}
            >
              {t('duplicateWarningsAck')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StepCard>
  );
}

function AgentStep({ onDone, onSkip, submitError, setSubmitError, locale }: StepProps) {
  const { data: roles } = useRolesQuery();
  const createMutation = useCreateUserMutation();
  return (
    <StepCard titleKey="agent">
      <UserForm
        mode="create"
        defaultValues={{ roleCodes: ['SALES_AGENT'] }}
        roles={roles ?? []}
        isSubmitting={createMutation.isPending}
        submitError={submitError}
        onSubmit={(input) => {
          setSubmitError(null);
          createMutation.mutate(input, {
            onSuccess: onDone,
            onError: (err) => setSubmitError(errorMessage(err, locale)),
          });
        }}
      />
      <SkipButton onSkip={onSkip} />
    </StepCard>
  );
}

function DoneStep() {
  const t = useTranslations('Onboarding');
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <CheckCircle2 className="h-12 w-12 text-success" />
        <div>
          <p className="text-lg font-semibold">{t('doneTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('doneSubtitle')}</p>
        </div>
        <Link href="/" className={buttonVariants({})}>
          {t('goToDashboard')}
        </Link>
      </CardContent>
    </Card>
  );
}
