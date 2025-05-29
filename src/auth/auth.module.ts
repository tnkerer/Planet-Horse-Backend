import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import {
  ConfigModule,
  ConfigService
} from '@nestjs/config'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { PrismaModule } from '../prisma/prisma.module'
import { UserModule } from 'src/user/user.module'
import { JwtStrategy } from './jwt.strategy'
import { PassportModule } from '@nestjs/passport'
import { JwtAuthGuard } from './jwt-auth.guard'

@Module({
  imports: [
    UserModule,
    PrismaModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    ConfigModule,               // for ConfigService
    JwtModule.registerAsync({   // makes JwtService available here
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cs: ConfigService) => ({
        secret: cs.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: cs.get<string>('JWT_EXPIRES_IN', '1h'),
        },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy, JwtAuthGuard],
  controllers: [AuthController],
  exports: [PassportModule, JwtModule, JwtAuthGuard]
})
export class AuthModule { }
