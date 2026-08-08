'use client';

import { useRef, type ChangeEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ImagePlus, Loader2 } from 'lucide-react';
import { useUploadProductImageMutation } from '@/lib/api/products';
import { errorMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';

interface ProductImageUploadProps {
  productId: string;
  imageUrl: string | null;
}

export function ProductImageUpload({ productId, imageUrl }: ProductImageUploadProps) {
  const t = useTranslations('Products.form');
  const locale = useLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadMutation = useUploadProductImageMutation(productId);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    uploadMutation.mutate(file, {
      onSuccess: () => toast.success(t('imageUploaded')),
      onError: (err) => toast.error(errorMessage(err, locale)),
    });
  }

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImagePlus className="h-8 w-8 text-muted-foreground" />
        )}
      </div>
      <div>
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploadMutation.isPending}
        >
          {uploadMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('uploadImage')}
        </Button>
      </div>
    </div>
  );
}
