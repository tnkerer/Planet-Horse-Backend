import { Controller, Get, UseGuards, Request, NotFoundException, Post, Body, BadRequestException, Param } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserService } from './user.service';
import { WithdrawDto } from './dto/withdraw.dto';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CreatePresaleIntentDto } from './dto/create-presale-intent.dto';
import { RecycleDto } from './dto/recycle.dto';
import { UpgradeItemDto } from './dto/upgrade-item.dto';

@Controller('user')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class UserController {
  constructor(private readonly users: UserService) { }

  @Get('balance')
  async balance(@Request() req) {
    // req.user.wallet comes from JwtStrategy.validate()
    const phorse = await this.users.getBalance(req.user.wallet);
    const medals = await this.users.getMedals(req.user.wallet);
    if (phorse === null || phorse === undefined) {
      throw new NotFoundException('User not found');
    }
    return { phorse, medals };
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

  /**
  * POST /user/chests/open
  * Body: { chestType: number; chestQuantity: number }
  * Returns: { drops: string[] }
  */
  @Post('chests/open')
  async openChest(
    @Request() req,
    @Body() body: { chestType: number; chestQuantity: number }
  ) {
    const drops = await this.users.openChest(
      req.user.wallet,
      body.chestType,
      body.chestQuantity
    );
    return { drops };
  }

  @Get('chests')
  async listChests(@Request() req) {
    return this.users.listChests(req.user.wallet);
  }

  /**
  * POST /user/items/recycle
  * Body: { name: string; uses: number }
  * Returns: { reward: string | null }
  */
  @Post('items/recycle')
  async recyle(
    @Request() req,
    @Body() dto: RecycleDto
  ): Promise<{ reward: string | null }> {
    // dto.name is guaranteed to be string and dto.uses ≥ 1 by class-validator
    const reward = await this.users.recyle(
      req.user.wallet,
      dto.name,
      dto.uses
    );
    return { reward };
  }

  /**
   * POST /user/items/upgrade
   * Body: { name: string }
   */
  @Post('items/upgrade')
  async upgradeItem(
    @Request() req,
    @Body() dto: UpgradeItemDto
  ) {
    if (typeof dto.name !== 'string' || !dto.name.trim()) {
      throw new BadRequestException('Request body must include a non-empty "name"');
    }

    const updatedItem = await this.users.upgradeItem(
      req.user.wallet,
      dto.name.trim()
    );

    if (!updatedItem) {
      throw new NotFoundException(`Failed to upgrade item "${dto.name}"`);
    }

    return { item: updatedItem };
  }

  @Get('transactions')
  async listTransactions(@Request() req) {
    return this.users.listTransactions(req.user.wallet);
  }

  @Get('items')
  async listItems(@Request() req) {
    return this.users.listItems(req.user.wallet);
  }

  /**
  * POST /user/withdraw
  * Body: { amount: number }
  */
  @Throttle({ default: { limit: 25, ttl: 60_000 } })
  @Post('withdraw')
  async withdraw(
    @Request() req,
    @Body() body: any = {},            // ← default to empty object
  ): Promise<{ transactionId: string }> {
    // 1) Ensure we actually got an object
    if (typeof body !== 'object' || body === null) {
      throw new BadRequestException('Request body must be JSON');
    }

    // 2) Now safely pull out `amount`
    const amount = body.amount;
    if (typeof amount !== 'number') {
      throw new BadRequestException('Request body must include a numeric "amount"');
    }
    if (amount <= 999) {
      throw new BadRequestException('Amount must be greater than 999');
    }

    // 3) Delegate to the service
    return this.users.phorseWithdraw(req.user.wallet, amount);
  }

  @Get('withdraw-tax')
  async checkWithdrawTax(@Request() req) {
    return this.users.getWithdrawTax(req.user.wallet);
  }

  @Post('link-discord')
  async linkDiscord(
    @Request() req,
    @Body() body: { discordId: string; discordTag: string }
  ) {
    return this.users.linkDiscord(req.user.wallet, body.discordId, body.discordTag);
  }

  @Get('get-discord')
  async getDiscord(@Request() req) {
    return this.users.getUserDiscord(req.user.wallet);
  }
}
