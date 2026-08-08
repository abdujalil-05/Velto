// Thin typed wrapper around Telegram's official WebApp JS bridge
// (https://core.telegram.org/bots/webapps), loaded via a <script> tag in the
// root layout rather than an npm SDK — the surface we need (initData, the
// two hardware buttons, haptics) is small and stable, and this keeps the
// same "no dependency for what a few typed calls cover" approach the rest
// of the codebase uses.

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramMainButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  setText(text: string): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
}

export interface TelegramBackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

export interface TelegramHapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: TelegramWebAppUser; [key: string]: unknown };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  /** Native "share my phone number" popup (Bot API 6.9+) — the number itself
   * goes to the bot as a message, not to this callback; it only reports
   * whether the user agreed. See auth-context.tsx's linkPhone(). */
  requestContact(callback: (shared: boolean) => void): void;
  MainButton: TelegramMainButton;
  BackButton: TelegramBackButton;
  HapticFeedback: TelegramHapticFeedback;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

/** `null` outside Telegram (PWA fallback, plain browser) — every caller must handle that case. */
export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}
