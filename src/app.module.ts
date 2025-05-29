import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UtilsModule } from './utils/utils.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { ConfigModule } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import * as csurf from 'csurf';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    UtilsModule,
    PrismaModule,
    AuthModule,
    UserModule
  ],
  controllers: [AppController],
  providers: [AppService],
})

export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // First parse cookies
    consumer
      .apply(cookieParser())
      .forRoutes('*')

    // Then apply csurf *only* to non‐auth routes
    consumer
      .apply(
        csurf({
          cookie: {
            httpOnly: true,
            sameSite: 'strict',
            secure: true,
          },
        })
      )
      .exclude(
        // skip CSRF for your SIWE endpoints
        { path: 'auth/nonce', method: RequestMethod.GET },
        { path: 'auth/verify', method: RequestMethod.POST },
        { path: 'auth/logout', method: RequestMethod.POST },
        { path: 'user/chests/buy', method: RequestMethod.POST },
      )
      .forRoutes('*')
  }
}

