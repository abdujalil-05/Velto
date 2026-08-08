'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/lib/auth/auth-context';
import { SyncEngineProvider } from '@/lib/offline/sync-engine';

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
        <SyncEngineProvider>
          {children}
          <Toaster richColors position="top-center" />
        </SyncEngineProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
