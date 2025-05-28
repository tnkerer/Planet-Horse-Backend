import { Module } from '@nestjs/common';
import { UtilsService } from './utils.service';
import { UtilsController } from './utils.controller';

@Module({
  providers: [UtilsService],
  exports: [UtilsService],
  controllers: [UtilsController]
})
export class UtilsModule {}
