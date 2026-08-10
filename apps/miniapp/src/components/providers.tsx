'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { isCourierOnly } from '@/lib/auth/roles';
import { SyncEngineProvider } from '@/lib/offline/sync-engine';

/**
 * The offline layer is agent-only. A courier's role grants neither `field.read`
 * nor `field.create`, so /sync/pull and /sync/push answer 403 for them — mounting
 * the engine would only produce a failing sync badge and an exponential backoff
 * loop over requests that can never succeed. Unmounting (rather than gating
 * inside the engine) also means a courier device never opens the encrypted
 * Dexie store at all. The agent path is untouched: for anyone who isn't a
 * courier-only user, and for every pre-authentication status, the provider
 * mounts exactly as before.
 */
function OfflineLayer({ children }: { children: React.ReactNode }) {
  const { user, status } = useAuth();
  if (status === 'authenticated' && isCourierOnly(user?.roles)) return <>{children}</>;
  return <SyncEngineProvider>{children}</SyncEngineProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OfflineLayer>
          {children}
          <Toaster richColors position="top-center" />
        </OfflineLayer>
      </AuthProvider>
    </QueryClientProvider>
  );
}
