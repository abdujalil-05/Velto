'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { useMfaReenrollMutation, useRegenerateRecoveryCodesMutation, type MfaChallenge } from '@/lib/api/mfa';
import { CodeField, MfaFlow, RecoveryCodesPanel, isSixDigits, useMfaErrorMessage } from '@/components/auth/mfa-flow';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function ReenrollCard() {
  const t = useTranslations('Security');
  const toMessage = useMfaErrorMessage();
  const { completeMfa } = useAuth();
  const mutation = useMfaReenrollMutation();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setChallenge(await mutation.mutateAsync({ password, code }));
    } catch (err) {
      setError(toMessage(err).message);
    } finally {
      setPassword('');
      setCode('');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('reenroll.title')}</CardTitle>
        <CardDescription>{t('reenroll.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {challenge ? (
          <div className="max-w-sm space-y-4">
            <ErrorAlert message={error} />
            <MfaFlow
              key={challenge.mfaChallenge}
              mode="enroll"
              challenge={challenge.mfaChallenge}
              finishLabel={t('reenroll.done')}
              onAuthenticated={async (tokens) => {
                await completeMfa(tokens);
                setChallenge(null);
                toast.success(t('reenroll.success'));
              }}
              onRestart={(message) => {
                setChallenge(null);
                setError(message);
              }}
            />
          </div>
        ) : (
          <form className="max-w-sm space-y-4" onSubmit={submit} noValidate>
            <ErrorAlert message={error} />
            <div className="space-y-2">
              <Label htmlFor="reenroll-password">{t('password')}</Label>
              <Input
                id="reenroll-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <CodeField id="reenroll-code" label={t('currentCode')} value={code} onChange={setCode} />
            <Button type="submit" disabled={mutation.isPending || !password || !isSixDigits(code)}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('reenroll.submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function RegenerateCard() {
  const t = useTranslations('Security');
  const toMessage = useMfaErrorMessage();
  const mutation = useRegenerateRecoveryCodesMutation();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await mutation.mutateAsync({ code });
      setCodes(res.recoveryCodes);
    } catch (err) {
      setError(toMessage(err).message);
    } finally {
      setCode('');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('regenerate.title')}</CardTitle>
        <CardDescription>{t('regenerate.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {codes ? (
          <div className="max-w-sm">
            <RecoveryCodesPanel codes={codes} continueLabel={t('regenerate.done')} onContinue={() => setCodes(null)} />
          </div>
        ) : (
          <form className="max-w-sm space-y-4" onSubmit={submit} noValidate>
            <ErrorAlert message={error} />
            <CodeField id="regen-code" label={t('currentCode')} value={code} onChange={setCode} />
            <Button type="submit" disabled={mutation.isPending || !isSixDigits(code)}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('regenerate.submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function SecurityCards() {
  return (
    <div className="space-y-4">
      <ReenrollCard />
      <RegenerateCard />
    </div>
  );
}
