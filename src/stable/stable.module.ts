import { forwardRef, Module }            from '@nestjs/common';
import { PrismaModule }      from '../prisma/prisma.module';
import { UserModule } from 'src/user/user.module';
import { StableService } from './stable.service';
import { StableController } from './stable.controller';
import { CacheModule } from '@nestjs/cache-manager';


@Module({
  imports: [PrismaModule, forwardRef(() => UserModule), CacheModule.register({ ttl: 0 })],
  providers: [StableService],
  controllers: [StableController],
  exports: [StableService],
})
export class StableModule {}
