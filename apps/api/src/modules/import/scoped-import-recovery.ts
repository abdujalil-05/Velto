import { systemPrisma } from '@velto/database';
import { fetchAllById } from '../../common/pagination/fetch-all-by-id';
import { ImportRecoveryService } from './import-recovery.service';

/** Test-only: scopes the sweep candidate lookup to one company so parallel test files do not sweep each other's rows. */
export class ScopedImportRecoveryService extends ImportRecoveryService {
  private onlyCompanyId?: string;

  override async sweep(now: Date = new Date(), onlyCompanyId?: string): Promise<number> {
    this.onlyCompanyId = onlyCompanyId;
    return super.sweep(now);
  }

  protected override findStuck() {
    const companyId = this.onlyCompanyId;
    return fetchAllById((page) => systemPrisma.importJob.findMany({ where: { status: 'PROCESSING', ...(companyId ? { companyId } : {}) }, select: { id: true, companyId: true, createdBy: true }, orderBy: { id: 'asc' }, ...page }));
  }
}
