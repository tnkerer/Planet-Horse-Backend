import { Module }            from '@nestjs/common';
import { PrismaModule }      from '../prisma/prisma.module';
import { UserService }       from './user.service';
import { UserController }    from './user.controller';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [PrismaModule],
  providers: [UserService],
  controllers: [UserController],
  exports: [UserService],
})
export class UserModule {}
