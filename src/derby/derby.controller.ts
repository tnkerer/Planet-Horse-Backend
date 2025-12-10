import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { DerbyService } from './derby.service';
import { AssignHorseDto, CreateDerbyDto, RemoveHorseDto, PlaceBetDto, DerbyOddsResponse } from './derby.dto';

@Controller('derby')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class DerbyController {
  constructor(private readonly derbyService: DerbyService) { }

  @Get('admin/panel')
  async checkDerbyAdmin(@Request() req: any) {
    const wallet: string | undefined = req.user?.wallet;
    if (!this.derbyService.isDerbyAdmin(wallet)) {
      throw new ForbiddenException('Access denied. Derby admin only.');
    }
    return { ok: true };
  }

  /**
   * POST /derby/create
   *  - Admin-only (validated inside DerbyService via wallet allowlist)
   *  - Creates a new Derby (PvP race)
   */
  @Post('create')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async createDerby(
    @Request() req,
    @Body() dto: CreateDerbyDto,
  ) {
    const wallet = req.user.wallet as string;
    if (!wallet) {
      throw new BadRequestException('Missing authenticated user wallet');
    }
    return this.derbyService.createDerby(wallet, dto);
  }

  /**
   * GET /derby
   *  - Alias to list OPEN derbies (for current UI)
   */
  @Get()
  async listDerbies() {
    return this.derbyService.listAllDerbies();
  }

  /**
   * GET /derby/open
   *  - List all derbies that are OPEN
   */
  @Get('open')
  async listOpenDerbies() {
    return this.derbyService.listOpenDerbies();
  }

  /**
   * GET /derby/:id
   *  - Get a single derby with its active entries
   */
  @Get(':id')
  async getDerby(@Param('id') id: string, @Request() req: any) {
    if (!id) {
      throw new BadRequestException('Derby id is required');
    }

    const wallet: string | undefined = req.user?.wallet;
    return this.derbyService.getDerbyById(id, wallet);
  }

  /**
   * POST /derby/:id/assign
   *  - User assigns a horse they own into a derby
   *  - 1 entry per user per derby (enforced in DB + service)
   */
  @Post(':id/assign')
  @Throttle({ default: { limit: 100, ttl: 30_000 } })
  async assignHorseToDerby(
    @Request() req,
    @Param('id') derbyId: string,
    @Body() dto: AssignHorseDto,
  ) {
    const wallet = req.user.wallet as string;
    if (!wallet) {
      throw new BadRequestException('Missing authenticated user wallet');
    }
    if (!dto.horseId || typeof dto.horseId !== 'string') {
      throw new BadRequestException('"horseId" must be a nonempty string');
    }

    return this.derbyService.assignHorseToDerby(wallet, derbyId, dto);
  }

  /**
   * POST /derby/:id/remove
   *  - User removes their horse from the derby (if >30m before start)
   *  - Refunds WRON + PHORSE entry fees
   */
  @Post(':id/remove')
  @Throttle({ default: { limit: 100, ttl: 30_000 } })
  async removeHorseFromDerby(
    @Request() req,
    @Param('id') derbyId: string,
    @Body() dto: RemoveHorseDto,
  ) {
    const wallet = req.user.wallet as string;
    if (!wallet) {
      throw new BadRequestException('Missing authenticated user wallet');
    }
    if (!dto.horseId || typeof dto.horseId !== 'string') {
      throw new BadRequestException('"horseId" must be a nonempty string');
    }

    return this.derbyService.removeHorseFromDerby(wallet, derbyId, dto);
  }

  /**
   * GET /derby/history/horse/:horseId
   *  - Get PvP history for a given horse
   *  - (You can add ownership enforcement later using wallet)
   */
  @Get('history/horse/:horseId')
  async getDerbyHistoryForHorse(
    @Param('horseId') horseId: string,
    @Request() _req,
  ) {
    if (!horseId) {
      throw new BadRequestException('horseId is required');
    }
    return this.derbyService.getDerbyHistoryForHorse(horseId);
  }

  /**
   * POST /derby/:id/finalize
   *  - Anyone can call
   *  - Finalizes a derby whose start time has passed
   *  - Picks winners (stats + luck), distributes WRON prizes, updates MMR, logs history
   */
  @Post(':id/finalize')
  @Throttle({ default: { limit: 25, ttl: 60_000 } })
  async finalizeDerby(@Param('id') derbyId: string) {
    if (!derbyId) {
      throw new BadRequestException('Derby id is required');
    }
    return this.derbyService.finalizeDerby(derbyId);
  }

  /**
  * POST /derby/:id/bet
  *  - Place a WRON bet on a specific horse in this derby
  *  - Uses user's authenticated wallet to resolve User
  */
  @Post(':id/bet')
  @Throttle({ default: { limit: 50, ttl: 30_000 } })
  async placeBet(
    @Request() req,
    @Param('id') derbyId: string,
    @Body() dto: PlaceBetDto,
  ) {
    const wallet = req.user.wallet as string;
    if (!wallet) {
      throw new BadRequestException('Missing authenticated user wallet');
    }
    if (!dto.horseId || typeof dto.horseId !== 'string') {
      throw new BadRequestException('"horseId" must be a nonempty string');
    }
    if (
      dto.amount === undefined ||
      dto.amount === null ||
      typeof dto.amount !== 'number' ||
      !Number.isFinite(dto.amount) ||
      dto.amount <= 0
    ) {
      throw new BadRequestException('"amount" must be a positive number');
    }

    return this.derbyService.placeBet(wallet, derbyId, dto.horseId, dto.amount);
  }

  /**
  * GET /derby/:id/odds
  *  - Returns current betting odds + potential payout per horse
  *  - If user is authenticated, includes userStake and userPotentialPayout
  */
  @Get(':id/odds')
  @Throttle({ default: { limit: 100, ttl: 30_000 } })
  async getDerbyOdds(
    @Request() req,
    @Param('id') derbyId: string,
  ): Promise<DerbyOddsResponse> {
    if (!derbyId) {
      throw new BadRequestException('Derby id is required');
    }

    const wallet: string | undefined = req.user?.wallet;
    return this.derbyService.getDerbyOdds(derbyId, wallet);
  }

}
