import { forwardRef, Module }               from '@nestjs/common';
import { PrismaModule }         from '../prisma/prisma.module';
import { AuthModule }           from '../auth/auth.module';
import { CacheModule } from '@nestjs/cache-manager';
import { QuestModule } from '../quest/quest.module';
import { DerbyService } from './derby.service';
import { DerbyController } from './derby.controller';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), CacheModule.register({ ttl: 0 }), forwardRef(() => QuestModule)],
  providers: [DerbyService],
  controllers: [DerbyController],
  exports: [DerbyService]
})

export class DerbyModule {}
