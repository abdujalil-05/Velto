'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Copy, Loader2 } from 'lucide-react';
import { ApiError, errorMessage } from '@/lib/api/client';
import { useMfaResetChallengeMutation, useResetUserMfaMutation, type MfaResetResult } from '@/lib/api/mfa';
import type { User } from '@/lib/api/users';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface ResetMfaDialogProps {
  user: User | null;
  onClose: () => void;
}

export function ResetMfaDialog({ user, onClose }: ResetMfaDialogProps) {
  const t = useTranslations('Users.mfaReset');
  const locale = useLocale();
  const challengeMutation = useMfaResetChallengeMutation();
  const mutation = useResetUserMfaMutation();
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Challenge, credentials and the one-time code live in component state only; dropped on close.
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [challengeFailed, setChallengeFailed] = useState(false);
  const [result, setResult] = useState<MfaResetResult | null>(null);
  const [copied, setCopied] = useState(false);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { mutateAsync: requestChallenge } = challengeMutation;

  const userId = user?.id ?? null;

  const loadChallenge = useCallback(async () => {
    if (!userId) return;
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    setChallengeId(null);
    setChallengeFailed(false);
    try {
      const c = await requestChallenge({ id: userId });
      setChallengeId(c.challengeId);
      expiryTimer.current = setTimeout(() => void loadChallenge(), Math.max(1, c.expiresIn) * 1000);
    } catch (err) {
      setChallengeFailed(true);
      setError(errorMessage(err, locale));
    }
  }, [userId, requestChallenge, locale]);

  useEffect(() => {
    if (userId) void loadChallenge();
    return () => {
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
    };
  }, [userId, loadChallenge]);

  function close() {
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    setReason('');
    setPassword('');
    setTotp('');
    setError(null);
    setChallengeId(null);
    setChallengeFailed(false);
    setResult(null);
    setCopied(false);
    mutation.reset();
    challengeMutation.reset();
    onClose();
  }

  const totpValid = /^\d{6}$/.test(totp);
  const canSubmit = !!challengeId && reason.trim().length > 0 && password.length > 0 && totpValid;

  async function confirm() {
    if (!user || !challengeId || !canSubmit) return;
    setError(null);
    try {
      setResult(
        await mutation.mutateAsync({
          id: user.id,
          challengeId,
          currentPassword: password,
          totpCode: totp,
          reason: reason.trim(),
        }),
      );
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_CHALLENGE_INVALID') {
        setError(t('challengeRenewed'));
        void loadChallenge();
      } else if (err instanceof ApiError && err.code === 'MFA_CODE_INVALID') {
        setError(t('codeInvalid'));
      } else if (err instanceof ApiError && err.code === 'MFA_RATE_LIMITED') {
        setError(t('rateLimited'));
      } else if (err instanceof ApiError && err.code === 'MFA_SERVICE_UNAVAILABLE') {
        setError(t('unavailable'));
      } else {
        setError(errorMessage(err, locale));
      }
    } finally {
      setPassword('');
      setTotp('');
    }
  }

  async function copy() {
    if (!result?.enrollmentCode) return;
    try {
      await navigator.clipboard.writeText(result.enrollmentCode.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const name = user ? `${user.firstName} ${user.lastName}` : '';
  const busy = mutation.isPending;
  const code = result?.enrollmentCode ?? null;

  return (
    <Dialog open={user !== null} onOpenChange={(open) => (!open && !busy ? close() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="space-y-3">
            <p className="text-sm">{t('success', { name })}</p>
            <p className="text-sm text-muted-foreground">{t('sessionsRevoked', { count: result.sessionsRevoked })}</p>
            {code ? (
              <>
                <p className="text-sm text-muted-foreground">{t('shownOnce', { name })}</p>
                <div className="flex gap-2">
                  <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-center font-mono text-lg tracking-widest">
                    {code.code}
                  </code>
                  <Button type="button" variant="outline" onClick={copy} aria-label={t('copy')}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-sm">{t('expires', { at: new Date(code.expiresAt).toLocaleString(locale) })}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noCode')}</p>
            )}
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <p className="text-sm text-muted-foreground">{t('description', { name })}</p>
            <div className="space-y-1">
              <Label htmlFor="mfa-reset-reason">{t('reason')}</Label>
              <Textarea
                id="mfa-reset-reason"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
              />
            </div>
            <p className="text-sm text-muted-foreground">{t('proofHint')}</p>
            <div className="space-y-1">
              <Label htmlFor="mfa-reset-password">{t('password')}</Label>
              <Input
                id="mfa-reset-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mfa-reset-totp">{t('totp')}</Label>
              <Input
                id="mfa-reset-totp"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={busy}
              />
              {totp.length > 0 && !totpValid && (
                <p className="text-sm text-destructive" role="alert">
                  {t('totpFormat')}
                </p>
              )}
            </div>
            {!challengeId && !challengeFailed && (
              <p className="flex items-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('preparing')}
              </p>
            )}
          </form>
        )}
        {error && (
          <Alert variant="destructive" className="mt-4" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && challengeFailed && (
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                void loadChallenge();
              }}
            >
              {t('retry')}
            </Button>
          )}
          {!result && (
            <Button variant="destructive" onClick={confirm} disabled={busy || !canSubmit}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('confirm')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
