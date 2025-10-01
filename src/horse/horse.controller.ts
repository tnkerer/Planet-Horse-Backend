import { Controller, Get, UseGuards, Request, Param, Post, Put, Req, BadGatewayException, Body, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HorseService, RewardsSuccess } from './horse.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { EnergyRecoveryService } from './energy-recovery.service';
import { EquipItemDto } from './dto/equip-item.dto';
import { UnequipItemDto } from './dto/unequip-item.dto';
import { IsOwnerGuard } from 'src/guards/is-owner.guard';
import { IsMultipleOwnerGuard } from 'src/guards/is-multiple-owner.guard';
import { IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer'

interface ConsumeDto {
  itemName: string;
  usesLeft?: number;
}

interface ChangeNicknameDto {
  nickname: string;
}

class LevelUpDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  useTicket?: boolean = false;
}

@Controller('horses')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class HorseController {
  constructor(private readonly horseService: HorseService, private readonly energyRecoveryService: EnergyRecoveryService) { }

  @Get('blockchain')
  async listBlockchainHorses(@Request() req) {
    // req.user.wallet is set by JwtStrategy.validate()
    return this.horseService.listBlockchainHorses(req.user.wallet);
  }

  @Get(':id/races')
  async getHorseRaceHistory(@Param('id') horseId: string, @Request() req) {
    return this.horseService.getRaceHistoryByHorseId(horseId, req.user.id);
  }

  /**
  * PUT /horses/:tokenId/level-up
  *   - No request body needed (growth is rolled internally).
  *   - Throttle: max 10 calls per 60s per user.
  */
  @UseGuards(IsOwnerGuard)
  @Put(':tokenId/level-up')
  @Throttle({ default: { limit: 100, ttl: 30_000 } })
  async levelUp(
    @Request() req,
    @Param('tokenId') tokenId: string,
    @Body() body: LevelUpDto,
  ) {
    const ownerWallet = req.user.wallet as string;
    const useTicket = Boolean(body?.useTicket);
    return this.horseService.levelUp(ownerWallet, tokenId, { useTicket });
  }

  /**
  * PUT /horses/:tokenId/start-race
  *   - Requires JWT authentication
  *   - Throttled to 50 calls/minute per user (to avoid spam)
  */
  @UseGuards(IsOwnerGuard)
  @Put(':tokenId/start-race')
  @Throttle({ default: { limit: 250, ttl: 30_000 } })
  async startRace(@Request() req, @Param('tokenId') tokenId: string) {
    const ownerWallet = req.user.wallet as string;
    return this.horseService.startRace(ownerWallet, tokenId);
  }

  @UseGuards(IsMultipleOwnerGuard)
  @Put('start-multiple-race')
  @Throttle({ default: { limit: 250, ttl: 30_000 } })
  async startMultipleRace(
    @Request() req,
    @Body('tokenIds') tokenIds: string[],
  ) {
    const ownerWallet = req.user.wallet as string;
    return this.horseService.startMultipleRace(ownerWallet, tokenIds);
  }

  /**
  * PUT /horses/:tokenId/restore
  *   - Must be authenticated
  *   - Throttled to 50 calls/minute to prevent repeated abuse
  */
  @UseGuards(IsOwnerGuard)
  @Put(':tokenId/restore')
  @Throttle({ default: { limit: 250, ttl: 30_000 } })
  async restoreHorse(@Request() req, @Param('tokenId') tokenId: string) {
    const ownerWallet = req.user.wallet as string;
    return this.horseService.restoreHorse(ownerWallet, tokenId);
  }

  @UseGuards(IsOwnerGuard)
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
  @UseGuards(IsOwnerGuard)
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

  @Get('next-energy-recovery')
  getNextEnergyRecovery() {
    return this.energyRecoveryService.getNextEnergyRecoveryTime();
  }

  @Get('next-stable-energy')
  getNextStableEnergy() {
    return this.energyRecoveryService.getNextStableEnergyTick();
  }

  /**
  * PUT /horses/:tokenId/change-nickname
  * Body: { nickname: string }
  */
  @UseGuards(IsOwnerGuard)
  @Put(':tokenId/change-nickname')
  @Throttle({ default: { limit: 50, ttl: 60_000 } }) // Limit abuse of nickname changes
  async changeNickname(
    @Request() req,
    @Param('tokenId') tokenId: string,
    @Body() body: ChangeNicknameDto,
  ) {
    if (!body.nickname || typeof body.nickname !== 'string') {
      throw new BadRequestException('Nickname must be a nonempty string');
    }
    return this.horseService.changeNickname(req.user.wallet, tokenId, body.nickname);
  }

}
