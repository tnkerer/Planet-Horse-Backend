import { Controller, Get, UseGuards, Request, NotFoundException, Post, Body, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserService } from './user.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
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
     * Body: { name: string; uses: number; quantity: number }
     * Returns: { rewards: Array<string | null> }
     */
  @Post('items/recycle')
  async recyle(
    @Request() req,
    @Body() dto: RecycleDto
  ): Promise<{ rewards: (string | null)[] }> {
    const rewards = await this.users.recyle(
      req.user.wallet,
      dto.name,
      dto.uses,
      dto.quantity
    );
    return { rewards };
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
      throw new BadRequestException('Request body must include a non empty "name"');
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
    if (amount > 100000) {
      throw new BadRequestException('Amount must be lower than or exactly 100000');
    }

    // 3) Delegate to the service
    return this.users.phorseWithdraw(req.user.wallet, amount);
  }

  /**
* POST /user/item-withdraw
* Body: { name: string; quantity: number }
*/
  @Throttle({ default: { limit: 25, ttl: 60_000 } })
  @Post('item-withdraw')
  async itemWithdraw(
    @Request() req,
    @Body() body: any = {}
  ): Promise<{ requestId: string }> {
    // 1) Validate body structure
    if (typeof body !== 'object' || body === null) {
      throw new BadRequestException('Request body must be JSON');
    }

    const { name, quantity } = body;

    // 2) Validate fields
    if (typeof name !== 'string' || name.trim() === '') {
      throw new BadRequestException('Request body must include a valid "name" string');
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('"quantity" must be a positive integer');
    }

    // 3) Delegate to the service
    const result = await this.users.itemWithdraw(req.user.wallet, name, quantity);
    return { requestId: result.requestId };
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

  @Post('ref-code')
  async setRefCode(
    @Request() req,
    @Body() body: { custom?: string }
  ) {
    try {
      return await this.users.createRefCode(req.user.wallet, body?.custom);
    } catch (error) {
      // Ensure clean 4xx errors and avoid leaking details
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      console.error('Unexpected error in setRefCode:', error);
      throw new BadRequestException('Could not set referral code');
    }
  }

  @Get('ref-code')
  async getRefCode(@Request() req) {
    try {
      return await this.users.getRefCode(req.user.wallet);
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      console.error('Unexpected error in getRefCode:', error);
      throw new BadRequestException('Could not fetch referral code');
    }
  }

  @Get('referral/stats')
  async getReferralStats(@Request() req) {
    return await this.users.getReferralStats(req.user.wallet);
  }

  @Get('profile')
  async getProfile(@Request() req) {
    const wallet = req.user.wallet;
    return this.users.getProfile(wallet);
  }

  @Post('set-referred-by')
  async setReferredBy(@Request() req, @Body('refCode') refCode: string) {
    const wallet = req.user.wallet; // Or however you're getting current user
    return this.users.setReferredBy(wallet, refCode);
  }

  /**
  * POST /user/items/open-bag
  * Optional: Idempotency-Key header or { idempotencyKey?: string } in body
  * Returns: { added: number; newMedals: number; remainingBags: number }
  */
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('items/open-bag')
  async openMedalBag(
    @Request() req,
    @Body() body: { idempotencyKey?: string } = {},
  ) {
    try {
      const wallet = req.user?.wallet;
      if (!wallet || typeof wallet !== 'string') {
        throw new BadRequestException('Invalid authenticated wallet');
      }

      const bodyKey =
        body && typeof body.idempotencyKey === 'string'
          ? body.idempotencyKey.trim()
          : undefined;

      const idempotencyKey = bodyKey || undefined;

      if (idempotencyKey && idempotencyKey.length > 128) {
        throw new BadRequestException('idempotencyKey too long (max 128 chars)');
      }

      const result = await this.users.openBag(wallet, idempotencyKey);
      return result;
    } catch (error) {
      // Preserve known 4xx from service; coerce unknowns to 400 to avoid 500s
      if (
        error?.status &&
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status < 500
      ) {
        throw error;
      }
      // Minimal log, avoid heavy stringification
      // eslint-disable-next-line no-console
      console.error('openMedalBag unexpected error');
      throw new BadRequestException('Could not open Medal Bag');
    }
  }

  @Post('items/craft')
  async craft(
    @Request() req,
    @Body() body: { name: string; idempotencyKey?: string }
  ) {
    if (!body || typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestException('Body must include non-empty "name"');
    }
    const idemp =
      typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : undefined;

    try {
      return await this.users.craftItem(req.user.wallet, body.name.trim(), idemp);
    } catch (error) {
      if (error?.status && error.status >= 400 && error.status < 500) {
        throw error;
      }
      // eslint-disable-next-line no-console
      console.error('craft unexpected error');
      throw new BadRequestException('Could not craft item');
    }
  }
}
