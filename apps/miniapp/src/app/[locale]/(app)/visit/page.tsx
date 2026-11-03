'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { VisitScreen } from '@/components/visit/visit-screen';

/**
 * Param-agnostic visit shell: one static HTML (warmed by the service worker) that reads the outlet id from the
 * query at runtime, so an offline cold start opens the CORRECT outlet and never another id's page (ADR-071).
 */
function Inner() {
  const outletId = useSearchParams().get('outletId');
  return outletId ? <VisitScreen outletId={outletId} /> : null;
}

export default function VisitPage() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
