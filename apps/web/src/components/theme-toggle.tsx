'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { Moon, Sun, SunMoon } from 'lucide-react';
import { Button } from '@/components/ui/button';

const NEXT_THEME: Record<string, string> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const THEME_ICON: Record<string, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: SunMoon,
};

export function ThemeToggle() {
  const t = useTranslations('AppShell');
  const { theme, setTheme } = useTheme();
  // next-themes only knows the real theme after mount (it reads localStorage
  // client-side) — render a stable icon until then to avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = mounted ? (theme ?? 'system') : 'system';
  const Icon = THEME_ICON[current] ?? SunMoon;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(NEXT_THEME[current] ?? 'system')}
      aria-label={t(`theme.${current}`)}
      title={t(`theme.${current}`)}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
