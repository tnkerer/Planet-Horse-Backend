import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UserModule } from 'src/user/user.module';
import { StableService } from './stable.service';
import { StableController } from './stable.controller';
import { CacheModule } from '@nestjs/cache-manager';
import { IsStableOwnerGuard } from 'src/guards/is-stable-owner.guard';
import { QuestModule } from 'src/quest/quest.module';


@Module({
  imports: [PrismaModule, forwardRef(() => UserModule), CacheModule.register({ ttl: 0 }), forwardRef(() => QuestModule)],
  providers: [StableService],
  controllers: [StableController],
  exports: [StableService],
})
export class StableModule { }
