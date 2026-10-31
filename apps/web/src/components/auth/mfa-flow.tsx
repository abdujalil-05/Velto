'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { ApiError, errorMessage } from '@/lib/api/client';
import {
  mfaEnrollConfirmRequest,
  mfaEnrollStartRequest,
  mfaVerifyRequest,
  type MfaEnrollStart,
} from '@/lib/api/mfa';
import type { TokenPair } from '@/lib/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const CODE_RE = /^\d{6}$/;

/** Maps an MFA ApiError to a localized message; `restart` means the challenge cannot be reused. */
export function useMfaErrorMessage() {
  const t = useTranslations('Auth.mfa');
  const locale = useLocale();
  return useCallback(
    (error: unknown): { message: string; restart: boolean } => {
      if (error instanceof ApiError) {
        switch (error.code) {
          case 'MFA_CHALLENGE_INVALID':
            return { message: t('challengeExpired'), restart: true };
          case 'MFA_WEB_LOGIN_REQUIRED':
            return { message: t('webLoginRequired'), restart: true };
          case 'MFA_CODE_INVALID':
            return { message: t('codeInvalid'), restart: false };
          case 'MFA_RATE_LIMITED':
            return { message: t('rateLimited'), restart: false };
          case 'MFA_SERVICE_UNAVAILABLE':
            return { message: t('serviceUnavailable'), restart: false };
        }
      }
      return { message: errorMessage(error, locale), restart: false };
    },
    [t, locale],
  );
}

interface CodeFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  recovery?: boolean;
}

export function CodeField({ id, label, value, onChange, disabled, recovery }: CodeFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {recovery ? (
        <Input
          id={id}
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          disabled={disabled}
          maxLength={64}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      ) : (
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={6}
          className="text-center text-xl tracking-[0.5em]"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      )}
    </div>
  );
}

export function isSixDigits(v: string) {
  return CODE_RE.test(v);
}

interface RecoveryCodesPanelProps {
  codes: string[];
  continueLabel: string;
  pending?: boolean;
  error?: string | null;
  onContinue: () => void;
}

/** One-time display: the user must confirm they saved the codes before continuing. */
export function RecoveryCodesPanel({ codes, continueLabel, pending, error, onContinue }: RecoveryCodesPanelProps) {
  const t = useTranslations('Auth.mfa');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'velto-recovery-codes.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{t('recoveryTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('recoveryHint')}</p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ul className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/40 p-3 font-mono text-sm" aria-label={t('recoveryTitle')}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={copy}>
          {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
          {copied ? t('copied') : t('copy')}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={download}>
          <Download className="mr-2 h-4 w-4" />
          {t('download')}
        </Button>
      </div>
      <label className="flex min-h-12 items-center gap-3 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {t('savedCheck')}
      </label>
      <Button type="button" size="lg" className="w-full" disabled={!saved || pending} onClick={onContinue}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : continueLabel}
      </Button>
    </div>
  );
}

interface MfaFlowProps {
  mode: 'verify' | 'enroll';
  challenge: string;
  /** Called with tokens once the user is through (after the recovery screen for enrollment). */
  onAuthenticated: (tokens: TokenPair) => Promise<void>;
  /** Challenge is unusable: parent returns to the first step and shows `message`. */
  onRestart: (message: string) => void;
  /** Label of the final button on the recovery screen. */
  finishLabel?: string;
  /** First enrollment of a privileged account needs the owner-issued code (ADR-058); not for self-service reenroll. */
  requireEnrollmentCode?: boolean;
}

export function MfaFlow({ mode, challenge, onAuthenticated, onRestart, finishLabel, requireEnrollmentCode = false }: MfaFlowProps) {
  const t = useTranslations('Auth.mfa');
  const toMessage = useMfaErrorMessage();

  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<MfaEnrollStart | null>(null);
  const [setupLoading, setSetupLoading] = useState(mode === 'enroll' && !requireEnrollmentCode);
  const [enrollmentCode, setEnrollmentCode] = useState('');
  const [secretCopied, setSecretCopied] = useState(false);
  // Held until the user confirms the recovery codes are saved; cleared right after use.
  const [pendingTokens, setPendingTokens] = useState<{ tokens: TokenPair; codes: string[] } | null>(null);
  const startedFor = useRef<string | null>(null);

  const fail = useCallback(
    (err: unknown) => {
      const { message, restart } = toMessage(err);
      if (restart) {
        onRestart(message);
        return;
      }
      setError(message);
    },
    [toMessage, onRestart],
  );

  const loadSetup = useCallback(async () => {
    setSetupLoading(true);
    setError(null);
    try {
      setSetup(await mfaEnrollStartRequest(challenge, requireEnrollmentCode ? enrollmentCode : undefined));
    } catch (err) {
      fail(err);
    } finally {
      setSetupLoading(false);
    }
  }, [challenge, fail, requireEnrollmentCode, enrollmentCode]);

  useEffect(() => {
    if (mode !== 'enroll' || requireEnrollmentCode || startedFor.current === challenge) return;
    startedFor.current = challenge;
    void loadSetup();
  }, [mode, challenge, loadSetup, requireEnrollmentCode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const validCode = useRecovery ? code.length > 0 : isSixDigits(code);
    if (!validCode) {
      setError(useRecovery ? t('recoveryRequired') : t('codeFormat'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'verify') {
        const tokens = await mfaVerifyRequest(challenge, useRecovery ? { recoveryCode: code } : { code });
        setCode('');
        await onAuthenticated({ accessToken: tokens.accessToken, user: tokens.user });
      } else {
        const res = await mfaEnrollConfirmRequest(challenge, code, requireEnrollmentCode ? enrollmentCode : undefined);
        setCode('');
        setEnrollmentCode('');
        setSetup(null);
        setPendingTokens({ tokens: { accessToken: res.accessToken, user: res.user }, codes: res.recoveryCodes });
      }
    } catch (err) {
      setCode('');
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!pendingTokens) return;
    setBusy(true);
    setError(null);
    try {
      await onAuthenticated(pendingTokens.tokens);
      setPendingTokens(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setSecretCopied(true);
    } catch {
      setSecretCopied(false);
    }
  }

  if (pendingTokens) {
    return (
      <RecoveryCodesPanel
        codes={pendingTokens.codes}
        continueLabel={finishLabel ?? t('continue')}
        pending={busy}
        error={error}
        onContinue={finish}
      />
    );
  }

  const errorAlert = error && (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );

  if (mode === 'enroll') {
    return (
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div>
          <h2 className="text-base font-semibold">{t('enrollTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('enrollHint')}</p>
        </div>
        {errorAlert}
        {setupLoading && (
          <div className="flex justify-center py-8" role="status" aria-label={t('loading')}>
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {requireEnrollmentCode && !setup && !setupLoading && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('enrollmentCodeHint')}</p>
            <Label htmlFor="mfa-enrollment-code">{t('enrollmentCodeLabel')}</Label>
            <Input
              id="mfa-enrollment-code"
              value={enrollmentCode}
              onChange={(e) => setEnrollmentCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={20}
              className="font-mono"
            />
            <Button
              type="button"
              size="lg"
              className="w-full"
              disabled={enrollmentCode.replace(/[\s-]/g, '').length !== 12}
              onClick={() => void loadSetup()}
            >
              {t('enrollmentCodeContinue')}
            </Button>
          </div>
        )}
        {!requireEnrollmentCode && !setupLoading && !setup && (
          <Button type="button" variant="outline" className="w-full" onClick={() => void loadSetup()}>
            {t('retry')}
          </Button>
        )}
        {setup && (
          <>
            <div className="flex justify-center">
              {setup.qrDataUrl.startsWith('data:image/') && (
                <img src={setup.qrDataUrl} alt={t('qrAlt')} width={192} height={192} className="rounded-md border border-border bg-white p-2" />
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mfa-secret">{t('manualKey')}</Label>
              <div className="flex gap-2">
                <Input id="mfa-secret" readOnly value={setup.secret} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onClick={copySecret} aria-label={t('copy')}>
                  {secretCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <CodeField id="mfa-code" label={t('confirmCodeLabel')} value={code} onChange={setCode} disabled={busy} />
            <Button type="submit" size="lg" className="w-full" disabled={busy || !isSixDigits(code)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('confirmEnroll')}
            </Button>
          </>
        )}
      </form>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div>
        <h2 className="text-base font-semibold">{t('verifyTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{useRecovery ? t('recoveryPrompt') : t('verifyHint')}</p>
      </div>
      {errorAlert}
      <CodeField
        id="mfa-code"
        label={useRecovery ? t('recoveryLabel') : t('codeLabel')}
        value={code}
        onChange={setCode}
        disabled={busy}
        recovery={useRecovery}
      />
      <Button type="submit" size="lg" className="w-full" disabled={busy || (useRecovery ? !code : !isSixDigits(code))}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('verify')}
      </Button>
      <div className="text-center text-sm">
        <button
          type="button"
          className="text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => {
            setUseRecovery((v) => !v);
            setCode('');
            setError(null);
          }}
        >
          {useRecovery ? t('useAuthenticator') : t('useRecovery')}
        </button>
      </div>
    </form>
  );
}
