import { forwardRef, Module }            from '@nestjs/common';
import { PrismaModule }      from '../prisma/prisma.module';
import { UserModule } from 'src/user/user.module';
import { StableService } from './stable.service';
import { StableController } from './stable.controller';


@Module({
  imports: [PrismaModule, forwardRef(() => UserModule)],
  providers: [StableService],
  controllers: [StableController],
  exports: [StableService],
})
export class StableModule {}
