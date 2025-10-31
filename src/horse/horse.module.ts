import { forwardRef, Module }               from '@nestjs/common';
import { PrismaModule }         from '../prisma/prisma.module';
import { AuthModule }           from '../auth/auth.module';
import { HorseService }         from './horse.service';
import { HorseController }      from './horse.controller';
import { EnergyRecoveryService } from './energy-recovery.service';
import { CacheModule } from '@nestjs/cache-manager';
import { QuestModule } from '../quest/quest.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), CacheModule.register({ ttl: 0 }), forwardRef(() => QuestModule)],
  providers: [EnergyRecoveryService, HorseService],
  controllers: [HorseController],
  exports: [HorseService]
})
export class HorseModule {}
