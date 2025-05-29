import { Controller, Get, UseGuards, Request, NotFoundException, Post, Body } from '@nestjs/common';
import { JwtAuthGuard }       from '../auth/jwt-auth.guard';
import { UserService }        from './user.service';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('balance')
  async balance(@Request() req) {
    // req.user.wallet comes from JwtStrategy.validate()
    const phorse = await this.users.getBalance(req.user.wallet);
    const medals = await this.users.getMedals(req.user.wallet);
    if (phorse === null || phorse === undefined) {
      throw new NotFoundException('User not found');
    }
    return { phorse , medals };
  }

    /**
   * POST /user/chests/buy
   * Body: { chestType: number; chestQuantity: number }
   */
  @Post('chests/buy')
  async buyChest(
    @Request() req,
    @Body() body: { chestType: number; chestQuantity: number },
  ) {
    const wallet = req.user.wallet;
    return this.users.buyChest(
      wallet,
      body.chestType,
      body.chestQuantity,
    );
  }

  @Get('chests')
  async listChests(@Request() req) {
    return this.users.listChests(req.user.wallet);
  }


  @Get('transactions')
  async listTransactions(@Request() req) {
    return this.users.listTransactions(req.user.wallet);
  }

}
