// src/auth/auth.controller.ts
import { Controller, Get, Query, Post, Body, Res, UseGuards, Req, UnauthorizedException } from '@nestjs/common'
import { Response, Request } from 'express'
import { AuthService } from './auth.service'
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';

@Controller('auth')
export class AuthController {
  constructor(private readonly jwtService: JwtService, private auth: AuthService) { }

  @Get('nonce')
  getNonce(@Query('address') address: string) {
    return this.auth.createAuthMessage(address)
      .then(message => ({ message }))
  }

  @Post('verify')
  async verify(
    @Body() body: { message: string; signature: string },
    @Res({ passthrough: true }) res: Response
  ) {
    const jwt = await this.auth.verifyAndSign(body.message, body.signature)
    res.cookie('jid', jwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60
    })
    return { ok: true }
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)   // optional, ensures only authenticated can hit this
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('jid', {
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    })
    return { ok: true }
  }

  @Get('me')
  me(@Req() req: Request) {
    // 1) grab the token from the cookie
    const token = req.cookies?.jid;
    if (!token) {
      throw new UnauthorizedException('No auth token');
    }

    let payload: { address: string; exp?: number };
    let expired = false;

    try {
      // 2) verify() will throw if expired or invalid
      payload = this.jwtService.verify(token);
    } catch (err: any) {
      if (err.name === 'TokenExpiredError') {
        // 3) token is expired → decode so we can still read `address`
        expired = true;
        payload = this.jwtService.decode(token) as any;
      } else {
        // any other error: invalid signature, malformed, etc.
        throw new UnauthorizedException('Invalid auth token');
      }
    }

    // 4) return what the client needs
    return {
      address: payload.address,
      expired,
    };
  }
}
