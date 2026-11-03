'use client';

import { useParams } from 'next/navigation';
import { VisitScreen } from '@/components/visit/visit-screen';

/** Online deep link kept for old URLs. Offline cold start uses the param-agnostic /visit?outletId= shell (ADR-071). */
export default function VisitByIdPage() {
  const params = useParams<{ outletId: string }>();
  return <VisitScreen outletId={params.outletId} />;
}
