// src/auth/jwt.strategy.ts
import { Injectable }        from '@nestjs/common';
import { PassportStrategy }  from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { Request }           from 'express';
import { ConfigService }     from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(cs: ConfigService) {
    super({
      // look in the 'jid' cookie for your token
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => {
          return req?.cookies?.jid ?? null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: cs.get<string>('JWT_SECRET'),
    });
  }

  // payload was { address }, so we attach wallet to req.user
  async validate(payload: { address: string }) {
    return { wallet: payload.address };
  }
}
