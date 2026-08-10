'use client';

import { useAuth } from '@/lib/auth/auth-context';
import { isCourierOnly } from '@/lib/auth/roles';
import { AgentHome } from '@/components/home/agent-home';
import { CourierHome } from '@/components/courier/courier-home';

/**
 * Role switch for the app's single entry screen. The agent home (9.4 Ekran 1)
 * moved verbatim into <AgentHome/> so a courier's session never mounts its
 * offline hooks — a courier device syncs no routes/customers/prices at all.
 */
export default function HomePage() {
  const { user } = useAuth();
  return isCourierOnly(user?.roles) ? <CourierHome /> : <AgentHome />;
}
