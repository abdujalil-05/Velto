import { Module } from '@nestjs/common';
import { ReportConcurrencyLimiter } from './report-concurrency.limiter';
import { ReportConcurrencyGuard } from './report-concurrency.guard';

// Imported by every module with report controllers; Nest module singletons
// make the limiter one instance per process.
@Module({
  providers: [ReportConcurrencyLimiter, ReportConcurrencyGuard],
  exports: [ReportConcurrencyLimiter, ReportConcurrencyGuard],
})
export class ReportConcurrencyModule {}
