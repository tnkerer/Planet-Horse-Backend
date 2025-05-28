import {
  Controller,
  Post,
  Param,
  Body,
  HttpException,
  HttpStatus,
  ParseFloatPipe,
  Get,
  Header,
} from '@nestjs/common';
import { UtilsService, LevelUpSuccess, LevelUpError } from './utils.service';
import { RewardsSuccess, RewardsError } from './utils.service';

interface Attribute {
  trait_type: string;
  value: string | number;
}

interface Metadata {
  name: string;
  description: string;
  image: string;
  attributes: Attribute[];
}

@Controller('horses')
export class UtilsController {
  constructor(private readonly utilsService: UtilsService) { }

  /**
   * Level up a horse:
   * POST /horses/:horseId/level-up
   * Body: { "growth": number }
   */
  @Post(':horseId/level-up')
  async levelUp(
    @Param('horseId') horseId: string,
    @Body('growth', ParseFloatPipe) growth: number
  ): Promise<LevelUpSuccess> {
    const result = await this.utilsService.levelUpOld(horseId, growth);

    if ('data' in result) {
      return {
        status: HttpStatus.OK,
        data: result.data,
      };
    }

    const err = result as LevelUpError;
    throw new HttpException({ error: err.error }, err.status);
  }

  /**
   * Calculate rewards for a horse:
   * POST /horses/:horseId/rewards
   */
  @Post(':horseId/rewards')
  async calculateRewards(
    @Param('horseId') horseId: string
  ): Promise<RewardsSuccess> {
    const result = await this.utilsService.calculateRewardsOld(horseId);

    if ('data' in result) {
      return {
        status: HttpStatus.OK,
        data: result.data,
      };
    }

    const err = result as RewardsError;
    throw new HttpException({ error: err.error }, err.status);
  }

  @Get(':horseId/metadata')
  @Header('Content-Type', 'application/json')
  async getHorseMetadata(@Param('horseId') horseId: string): Promise<Metadata> {
    try {
      return await this.utilsService.getHorseMetadataOld(horseId);
    } catch (err) {
      // Re‐throw Nest’s HTTP exceptions, or wrap other errors
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { error: 'Unexpected error loading metadata' },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
