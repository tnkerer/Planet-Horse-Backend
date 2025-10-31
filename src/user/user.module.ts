import { forwardRef, Module }            from '@nestjs/common';
import { PrismaModule }      from '../prisma/prisma.module';
import { UserService }       from './user.service';
import { UserController }    from './user.controller';
import { HorseModule } from 'src/horse/horse.module';
import { QuestModule } from '../quest/quest.module';

@Module({
  imports: [PrismaModule, forwardRef(() => HorseModule), forwardRef(() => QuestModule)],
  providers: [UserService],
  controllers: [UserController],
  exports: [UserService],
})
export class UserModule {}
