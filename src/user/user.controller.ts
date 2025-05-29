import { Controller, Get, UseGuards, Request, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard }       from '../auth/jwt-auth.guard';
import { UserService }        from './user.service';

@Controller('user')
@UseGuards(JwtAuthGuard)      // ← protects all routes in this controller
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('balance')
  async balance(@Request() req) {
    // req.user.wallet comes from JwtStrategy.validate()
    const phorse = await this.users.getBalance(req.user.wallet);
    if (phorse === null || phorse === undefined) {
      throw new NotFoundException('User not found');
    }
    return { phorse };
  }
}
