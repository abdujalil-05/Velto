import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { TenantContext } from '../tenant/tenant-context';
import { StorageService } from './storage.service';

describe('StorageService.getObject tenant prefix guard', () => {
  const config = new ConfigService({ S3_ENDPOINT: 'http://localhost:1', S3_BUCKET: 'b', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 's' });
  const storage = new StorageService(config);
  const store = (companyId: string) => ({ companyId, tx: {} as never, afterCommit: [] });

  it('rejects keys outside exports/1c/<companyId>/ before any S3 call', async () => {
    await TenantContext.run(store('co-1'), async () => {
      await expect(storage.getObject('exports/1c/co-2/x.csv')).rejects.toThrow('outside');
      await expect(storage.getObject('other/co-1/x.csv')).rejects.toThrow('outside');
      await expect(storage.getObject('exports/1c/co-1/../co-2/x.csv')).rejects.toThrow('outside');
    });
  });
});
