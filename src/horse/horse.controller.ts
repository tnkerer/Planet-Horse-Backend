import { Controller, Get, UseGuards, Request, Param, Post, Put } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HorseService, RewardsSuccess } from './horse.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { RewardsThrottlerGuard } from 'src/guards/rewards-throttler-guard';

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
  *   - Throttled to 25 calls/minute per user (to avoid spam)
  */
  @Put(':tokenId/start-race')
  @Throttle({ default: { limit: 25, ttl: 60_000 } })
  async startRace(@Request() req, @Param('tokenId') tokenId: string) {
    const ownerWallet = req.user.wallet as string;
    return this.horseService.startRace(ownerWallet, tokenId);
  }

  /**
  * PUT /horses/:tokenId/restore
  *   - Must be authenticated
  *   - Throttled to 5 calls/minute to prevent repeated abuse
  */
  @Put(':tokenId/restore')
  @Throttle({ default: { limit: 25, ttl: 60_000 } })
  async restoreHorse(@Request() req, @Param('tokenId') tokenId: string) {
    const ownerWallet = req.user.wallet as string;
    return this.horseService.restoreHorse(ownerWallet, tokenId);
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


}
