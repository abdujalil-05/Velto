'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useLocale, useTranslations } from 'next-intl';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { ApiError, consumeAuthNotice, errorMessage } from '@/lib/api/client';
import type { CompanySelectionRequired } from '@/lib/api/auth';
import { isMfaChallenge, type MfaChallenge } from '@/lib/api/mfa';
import { MfaFlow } from '@/components/auth/mfa-flow';
import { AccountPicker } from '@/components/auth/account-picker';
import { ForgotPasswordDialog } from '@/components/auth/forgot-password-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { LanguageSwitcher } from '@/components/language-switcher';

const PHONE_DIGITS_RE = /^\d{9}$/;

function loginSchema(t: (key: string) => string) {
  return z.object({
    phoneDigits: z.string().regex(PHONE_DIGITS_RE, t('phoneInvalid')),
    password: z.string().min(1, t('passwordRequired')),
  });
}

type LoginFormValues = z.infer<ReturnType<typeof loginSchema>>;

export default function LoginPage() {
  const t = useTranslations('Auth');
  const locale = useLocale();
  const router = useRouter();
  const { login, selectCompany, completeMfa, status } = useAuth();

  const [showPassword, setShowPassword] = useState(false);
  const [showForgotDialog, setShowForgotDialog] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Held in component state only (ADR-057): never persisted, never in the URL.
  const [challenge, setChallenge] = useState<CompanySelectionRequired | null>(null);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [mfa, setMfa] = useState<MfaChallenge | null>(null);

  const schema = loginSchema(t);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(schema), defaultValues: { phoneDigits: '', password: '' } });

  useEffect(() => {
    // Set by apiFetch when the server ended the session with MFA_REQUIRED (ADR-058).
    const notice = consumeAuthNotice();
    if (notice === 'mfaRequired') setSubmitError(t('mfa.sessionRequired'));
    else if (notice === 'sessionExpired') setSubmitError(t('sessionExpired'));
  }, [t]);

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/');
    }
  }, [status, router]);

  async function onSubmit(values: LoginFormValues) {
    setSubmitError(null);
    try {
      const pending = await login(`+998${values.phoneDigits}`, values.password);
      if (pending && isMfaChallenge(pending)) {
        setMfa(pending);
        return;
      }
      if (pending) {
        setChallenge(pending);
        setOptionId(null);
        return;
      }
      router.replace('/');
    } catch (error) {
      setSubmitError(errorMessage(error, locale));
    }
  }

  async function onSelectCompany() {
    if (!challenge || !optionId) return;
    setSubmitError(null);
    setSelecting(true);
    try {
      const next = await selectCompany(challenge.challengeId, optionId);
      if (next) {
        setMfa(next);
        return;
      }
      router.replace('/');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'AUTH_CHALLENGE_INVALID') {
        // Challenge is single-use/expired: back to the password step.
        setChallenge(null);
        setOptionId(null);
        setSubmitError(t('challengeInvalid'));
      } else if (error instanceof ApiError && error.code === 'AUTH_CHALLENGE_RATE_LIMITED') {
        setSubmitError(`${errorMessage(error, locale)} ${t('challengeRateLimited')}`);
      } else {
        setSubmitError(errorMessage(error, locale));
      }
    } finally {
      setSelecting(false);
    }
  }

  function restartFromMfa(message: string) {
    setMfa(null);
    setChallenge(null);
    setOptionId(null);
    setSubmitError(message);
  }

  function backToPassword() {
    setMfa(null);
    setChallenge(null);
    setOptionId(null);
    setSubmitError(null);
  }

  if (status === 'loading' || status === 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex justify-end">
          <LanguageSwitcher />
        </div>

        <Card>
          <CardHeader className="items-center text-center">
            <CardTitle className="text-2xl text-primary">Velto</CardTitle>
            <CardDescription>{t('subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            {mfa ? (
              <div className="space-y-4">
                {submitError && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{submitError}</AlertDescription>
                  </Alert>
                )}
                <MfaFlow
                  key={mfa.mfaChallenge}
                  mode={mfa.mfa}
                  requireEnrollmentCode
                  challenge={mfa.mfaChallenge}
                  onAuthenticated={async (tokens) => {
                    await completeMfa(tokens);
                    setMfa(null);
                    router.replace('/');
                  }}
                  onRestart={restartFromMfa}
                />
                <Button type="button" variant="outline" className="w-full" onClick={backToPassword}>
                  {t('backToPassword')}
                </Button>
              </div>
            ) : challenge ? (
              <div className="space-y-4">
                {submitError && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{submitError}</AlertDescription>
                  </Alert>
                )}
                <AccountPicker
                  legend={t('chooseCompany')}
                  options={challenge.companies}
                  value={optionId}
                  onChange={setOptionId}
                  disabled={selecting}
                />
                <Button type="button" size="lg" className="w-full" disabled={!optionId || selecting} onClick={onSelectCompany}>
                  {selecting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('continue')}
                </Button>
                <Button type="button" variant="outline" className="w-full" disabled={selecting} onClick={backToPassword}>
                  {t('backToPassword')}
                </Button>
              </div>
            ) : (
            <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
              {submitError && (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="phoneDigits">{t('phoneLabel')}</Label>
                <div
                  className="flex h-10 items-center rounded-md border border-input bg-background pl-3 ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
                >
                  <span className="text-base text-muted-foreground">+998</span>
                  <input
                    id="phoneDigits"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    placeholder="901110001"
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
                <Label htmlFor="password">{t('passwordLabel')}</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    aria-invalid={!!errors.password}
                    className="pr-10"
                    {...register('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground"
                    aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
              </div>

              <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('submit')}
              </Button>

              <div className="text-center text-sm">
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-4 hover:underline"
                  onClick={() => setShowForgotDialog(true)}
                >
                  {t('forgotPassword')}
                </button>
              </div>
            </form>
            )}
          </CardContent>
        </Card>
      </div>

      <ForgotPasswordDialog
        open={showForgotDialog}
        onOpenChange={setShowForgotDialog}
        initialPhoneDigits={watch('phoneDigits')}
      />
    </main>
  );
}
