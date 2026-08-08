import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export interface ProductPackaging {
  id: string;
  name: string;
  qtyInBaseUnit: string;
  isDefault: boolean;
}

export interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  baseUnit: string;
  imageUrl: string | null;
  vatRate: string;
  minPrice: string | null;
  price: string | null;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  isActive: boolean;
  packagings: ProductPackaging[];
}

export interface ListProductsParams {
  page?: number;
  pageSize?: number;
  search?: string;
  categoryId?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  [key: string]: string | number | undefined;
}

export function useProductsQuery(params: ListProductsParams, enabled = true) {
  return useQuery({
    queryKey: ['products', params],
    queryFn: () => apiFetch<PaginatedResult<Product>>(`/products${toQueryString(params)}`),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useProductQuery(id: string) {
  return useQuery({
    queryKey: ['products', id],
    queryFn: () => apiFetch<Product>(`/products/${id}`),
    enabled: !!id,
  });
}

export interface ProductPackagingInput {
  name: string;
  qtyInBaseUnit: number;
  isDefault?: boolean;
}

export interface ProductFormInput {
  sku: string;
  barcode?: string;
  name: string;
  brand?: string;
  baseUnit: string;
  categoryId?: string;
  vatRate?: number;
  minPrice?: number;
  price?: number;
  packagings: ProductPackagingInput[];
}

export function useCreateProductMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProductFormInput) => apiFetch<Product>('/products', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useUpdateProductMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<ProductFormInput>) => apiFetch<Product>(`/products/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['products', id] });
    },
  });
}

export function useDeleteProductMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<Product>(`/products/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useUploadProductImageMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append('image', file);
      return apiFetch<Product>(`/products/${id}/image`, { method: 'POST', body: formData });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['products', id] });
    },
  });
}
