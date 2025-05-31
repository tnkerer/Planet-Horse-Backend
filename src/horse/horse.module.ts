import { Module }               from '@nestjs/common';
import { PrismaModule }         from '../prisma/prisma.module';
import { AuthModule }           from '../auth/auth.module';
import { HorseService }         from './horse.service';
import { HorseController }      from './horse.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [HorseService],
  controllers: [HorseController],
})
export class HorseModule {}
