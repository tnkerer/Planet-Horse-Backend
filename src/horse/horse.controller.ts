import { Controller, Get, UseGuards, Request, Param, Post, Put, Req, BadGatewayException, Body, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HorseService, RewardsSuccess } from './horse.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { RewardsThrottlerGuard } from 'src/guards/rewards-throttler.guard';
import { EquipItemDto } from './dto/equip-item.dto';
import { UnequipItemDto } from './dto/unequip-item.dto';

interface ConsumeDto {
  itemName: string;
  usesLeft?: number;
}

@Controller('horses')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class HorseController {
  constructor(private readonly horseService: HorseService) { }

  /** GET /horses → [{ id, tokenId, name, … }] */
  @Get()
  async listHorses(@Request() req) {
    // req.user.wallet is set by JwtStrategy.validate()
    return this.horseService.listHorses(req.user.wallet);
  }

  /**
  * PUT /horses/:tokenId/level-up
  *   - No request body needed (growth is rolled internally).
  *   - Throttle: max 10 calls per 60s per user.
  */
  @Put(':tokenId/level-up')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async levelUp(
    @Request() req,
    @Param('tokenId') tokenId: string,
  ) {
    const ownerWallet = req.user.wallet as string;
    return this.horseService.levelUp(ownerWallet, tokenId);
  }

  /**
  * PUT /horses/:tokenId/start-race
  *   - Requires JWT authentication
  *   - Throttled to 50 calls/minute per user (to avoid spam)
  */
  @Put(':tokenId/start-race')
  @Throttle({ default: { limit: 50, ttl: 60_000 } })
  async startRace(@Request() req, @Param('tokenId') tokenId: string) {
    const ownerWallet = req.user.wallet as string;
    return this.horseService.startRace(ownerWallet, tokenId);
  }

  /**
  * PUT /horses/:tokenId/restore
  *   - Must be authenticated
  *   - Throttled to 50 calls/minute to prevent repeated abuse
  */
  @Put(':tokenId/restore')
  @Throttle({ default: { limit: 50, ttl: 60_000 } })
  async restoreHorse(@Request() req, @Param('tokenId') tokenId: string) {
    const ownerWallet = req.user.wallet as string;
    return this.horseService.restoreHorse(ownerWallet, tokenId);
  }

  /**
   * PUT /horses/claim-horse  
   *    - Only in development/beta builds (DevOnlyGuard).  
   *    - Throttled to 50 calls per minute.
   */
  @Put('claim-horse')
  @Throttle({ default: { limit: 50, ttl: 60_000 } })
  async claimHorse(@Request() req) {
    // req.user is populated by your JWT/SIWE guard; assume it has `.wallet`
    const ownerWallet = req.user.wallet as string;
    if (!ownerWallet) {
      throw new BadGatewayException('No authenticated wallet found.');
    }
    return this.horseService.claimHorse(ownerWallet);
  }

  /**
* GET /horses/:tokenId/rewards
* Returns { xpReward, tokenReward, position }
*/
  @Get(':tokenId/rewards')
  @UseGuards(JwtAuthGuard)
  async getRewards(
    @Request() req,
    @Param('tokenId') tokenId: string,
  ): Promise<RewardsSuccess> {
    return this.horseService.calculateRewards(req.user.wallet, tokenId);
  }

  /**
  * PUT /horses/:tokenId/equip-item
  *  Body: { name: string, usesLeft: number }
  */
  @Put(':tokenId/equip-item')
  @UseGuards(JwtAuthGuard)
  async equipItem(
    @Request() req,
    @Param('tokenId') tokenId: string,
    @Body() dto: EquipItemDto,
  ) {
    const wallet = req.user.wallet as string;
    if (!wallet) {
      throw new BadRequestException('No authenticated wallet found.');
    }
    return this.horseService.equipItem(wallet, tokenId, dto);
  }

  /**
  * PUT /horses/:tokenId/unequip-item
  *  Body: { name: string }
  */
  @Put(':tokenId/unequip-item')
  @UseGuards(JwtAuthGuard)
  async unequipItem(
    @Request() req,
    @Param('tokenId') tokenId: string,
    @Body() dto: UnequipItemDto,
  ) {
    const wallet = req.user.wallet as string;
    if (!wallet) {
      throw new BadRequestException('No authenticated wallet found.');
    }
    return this.horseService.unequipItem(wallet, tokenId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':tokenId/consume')
  async consumeItem(
    @Param('tokenId') tokenId: string,
    @Body() body: ConsumeDto,
    @Request() req: any,
  ) {
    const callerWallet = req.user.wallet as string;
    if (!body.itemName || typeof body.itemName !== 'string') {
      throw new BadRequestException(`"itemName" must be a nonempty string`);
    }
    return this.horseService.consumeItem(
      callerWallet,
      tokenId,
      body.itemName,
    );
  }

}
