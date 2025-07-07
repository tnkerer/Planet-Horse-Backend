// src/auth/auth.controller.ts
import { Controller, Get, Query, Post, Body, Res, UseGuards, Req, UnauthorizedException, Request as NestRequest, BadRequestException } from '@nestjs/common'
import { Response, Request } from 'express'
import { AuthService } from './auth.service'
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';
import { UserService } from 'src/user/user.service';
import axios from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly jwtService: JwtService, private auth: AuthService, private users: UserService, private prisma: PrismaService) { }

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
      maxAge: 1000 * 60 * 60 * 24
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

  @Post('discord-token')
  @UseGuards(JwtAuthGuard)
  async getDiscordToken(@NestRequest() req) {
    const wallet = req.user.wallet;

    const userId = await this.prisma.user.findUnique({
        where: { wallet: wallet },
        select: {
          id: true,
        },
      });

    const tempToken = this.jwtService.sign(
      { userId: userId?.id },
      { expiresIn: '5m' } // short expiry!
    );

    return { token: tempToken };
  }

  @Get('discord/callback')
  async handleDiscordCallback(
    @Query('code') code: string,
    @Query('state') stateToken: string,
    @Res() res: Response
  ) {
    try {
      const payload = this.jwtService.verify(stateToken) as { userId: string };

      // Token is valid, extract user ID
      const userId = payload.userId;
      // 1. Exchange code for access token
      const tokenResponse = await axios.post(
        'https://discord.com/api/oauth2/token',
        new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID!,
          client_secret: process.env.DISCORD_CLIENT_SECRET!,
          grant_type: 'authorization_code',
          code,
          redirect_uri: process.env.DISCORD_REDIRECT_URI!,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const accessToken = tokenResponse.data.access_token;

      // 2. Fetch Discord user info
      const userResponse = await axios.get('https://discord.com/api/users/@me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const discordData = userResponse.data;

      // 3. Retrieve authenticated PlanetHorse user (wallet login)
      const userWallet = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          wallet: true,
        },
      });

      if (!userWallet) {
        throw new BadRequestException('Not user found!')
      }

      // 4. Link Discord
      await this.users.linkDiscord(
        userWallet.wallet,
        discordData.id,
        discordData.username
      );

      return res.redirect(`${process.env.SITE_URL}/game#`);
    } catch (error) {
      console.error('Discord OAuth error:', error.response?.data || error.message);
      return res.status(400).json({ message: 'Failed to link Discord account' });
    }
  }
}
