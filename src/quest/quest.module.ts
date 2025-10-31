import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QuestService } from './quest.service';
import { QuestController } from './quest.controller';

@Module({
  imports: [PrismaModule],
  providers: [QuestService],
  controllers: [QuestController],
  exports: [QuestService],
})
export class QuestModule {}
