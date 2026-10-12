import type { TraceableJobData } from '../../../common/queue/trace-job';

export const EXPORT_1C_QUEUE = '1c-export';

export interface Export1cJobData extends TraceableJobData {
  exportJobId: string;
  companyId: string;
}
