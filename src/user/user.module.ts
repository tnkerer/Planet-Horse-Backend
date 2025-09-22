import { forwardRef, Module }            from '@nestjs/common';
import { PrismaModule }      from '../prisma/prisma.module';
import { UserService }       from './user.service';
import { UserController }    from './user.controller';
import { HorseModule } from 'src/horse/horse.module';

@Module({
  imports: [PrismaModule, forwardRef(() => HorseModule)],
  providers: [UserService],
  controllers: [UserController],
  exports: [UserService],
})
export class UserModule {}
