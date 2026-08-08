'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogCloseButton, DialogFooter } from '@/components/ui/dialog';

const RESEND_COOLDOWN_SECONDS = 60;

interface ForgotPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fills from whatever the user already typed into the login form's phone field. */
  initialPhoneDigits: string;
}

type Step = 'phone' | 'code';

export function ForgotPasswordDialog({ open, onOpenChange, initialPhoneDigits }: ForgotPasswordDialogProps) {
  const t = useTranslations('Auth.reset');
  const tAuth = useTranslations('Auth');
  const locale = useLocale();

  const [step, setStep] = useState<Step>('phone');
  const [phoneDigits, setPhoneDigits] = useState(initialPhoneDigits);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (open) {
      setStep('phone');
      setPhoneDigits(initialPhoneDigits);
      setCode('');
      setNewPassword('');
      setError(null);
      setCooldown(0);
    }
  }, [open, initialPhoneDigits]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const phone = `+998${phoneDigits}`;

  async function sendCode() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/auth/password-reset/request', { method: 'POST', body: { phone }, skipAuth: true });
      setStep('code');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(errorMessage(err, locale));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmReset() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/auth/password-reset/confirm', {
        method: 'POST',
        body: { phone, code, newPassword },
        skipAuth: true,
      });
      toast.success(t('success'));
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, locale));
    } finally {
      setSubmitting(false);
    }
  }

  const phoneValid = /^\d{9}$/.test(phoneDigits);
  const codeValid = /^\d{6}$/.test(code);
  const passwordValid = newPassword.length >= 10;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogCloseButton onClick={() => onOpenChange(false)} />
        </DialogHeader>

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {step === 'phone' ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('phoneStepDescription')}</p>
            <div className="space-y-2">
              <Label htmlFor="reset-phone">{tAuth('phoneLabel')}</Label>
              <div className="flex h-10 items-center rounded-md border border-input bg-background pl-3 ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                <span className="text-base text-muted-foreground">+998</span>
                <input
                  id="reset-phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="901110001"
                  maxLength={9}
                  value={phoneDigits}
                  onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, '').slice(0, 9))}
                  className="h-full flex-1 bg-transparent px-2 text-base outline-none md:text-sm"
                  autoFocus
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('cancel')}
              </Button>
              <Button type="button" disabled={!phoneValid || submitting} onClick={sendCode}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sendCode')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('codeStepDescription', { phone: phoneDigits })}</p>

            <div className="space-y-2">
              <Label htmlFor="reset-code">{t('codeLabel')}</Label>
              <Input
                id="reset-code"
                type="tel"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="reset-new-password">{t('newPasswordLabel')}</Label>
              <Input
                id="reset-new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('newPasswordHint')}</p>
            </div>

            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              disabled={cooldown > 0 || submitting}
              onClick={sendCode}
            >
              {cooldown > 0 ? t('resendIn', { seconds: cooldown }) : t('resend')}
            </button>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep('phone')}>
                {t('back')}
              </Button>
              <Button type="button" disabled={!codeValid || !passwordValid || submitting} onClick={confirmReset}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('confirm')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
