import type { MetadataRoute } from 'next';
import { buildManifest } from '@/lib/pwa/manifest';

export default function manifest(): MetadataRoute.Manifest {
  return buildManifest(process.env.NEXT_PUBLIC_BASE_PATH ?? '');
}
