import { Module } from '@nestjs/common';
import { DocumentNumberingService } from './document-numbering.service';

@Module({
  providers: [DocumentNumberingService],
  exports: [DocumentNumberingService],
})
export class DocumentNumberingModule {}
