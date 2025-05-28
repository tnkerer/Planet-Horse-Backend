import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UtilsModule } from './utils/utils.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [UtilsModule, PrismaModule],
  controllers: [AppController],
  providers: [AppService,],
})
export class AppModule {}
