import {
  Controller,
  Get,
  Post,
  Body,
  Request,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { QuestAdminGuard } from './guards/quest-admin.guard';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { QuestService } from './quest.service';
import { CreateQuestDto } from './dto/create-quest.dto';
import { ClaimQuestDto } from './dto/claim-quest.dto';

@Controller('quest')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class QuestController {
  constructor(private readonly questService: QuestService) {}

  /**
   * GET /quest/list
   * Returns all active quests with user progress
   */
  @Get('list')
  async listQuests(@Request() req) {
    const wallet = req.user.wallet;
    if (!wallet) {
      throw new BadRequestException('Invalid wallet');
    }
    return this.questService.listQuestsForUser(wallet);
  }

  /**
   * POST /quest/claim
   * Claim rewards for a completed quest
   * Throttled to prevent spam
   */
  @Throttle({ default: { limit: 50, ttl: 60_000 } })
  @Post('claim')
  async claimQuest(@Request() req, @Body() dto: ClaimQuestDto) {
    const wallet = req.user.wallet;
    if (!wallet) {
      throw new BadRequestException('Invalid wallet');
    }

    if (!dto.questId || typeof dto.questId !== 'number') {
      throw new BadRequestException('Request body must include a numeric "questId"');
    }

    return this.questService.claimQuest(wallet, dto.questId);
  }

  /**
   * POST /quest/checkin
   * Daily check-in with 24-hour cooldown
   * Throttled to prevent abuse
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkin')
  async dailyCheckin(@Request() req) {
    const wallet = req.user.wallet;
    if (!wallet) {
      throw new BadRequestException('Invalid wallet');
    }
    return this.questService.dailyCheckin(wallet);
  }

  /**
   * GET /quest/checkin/status
   * Check if user can perform daily check-in
   */
  @Get('checkin/status')
  async checkinStatus(@Request() req) {
    const wallet = req.user.wallet;
    if (!wallet) {
      throw new BadRequestException('Invalid wallet');
    }
    return this.questService.getCheckinStatus(wallet);
  }

  /**
   * POST /quest/create [ADMIN ONLY]
   * Create a new quest (admin endpoint)
   * 🔐 SECURITY: Only accessible by authorized admin wallet
   * Protected by QuestAdminGuard - verifies wallet address
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(QuestAdminGuard)
  @Post('create')
  async createQuest(@Request() req, @Body() dto: CreateQuestDto) {
    // Validation
    if (!dto.id || !dto.title || !dto.description || !dto.reward || !dto.questsToComplete) {
      throw new BadRequestException('Missing required quest fields');
    }

    // Log admin action for audit trail
    console.log(`[ADMIN] Quest creation initiated by ${req.user.wallet}: Quest ID ${dto.id}`);

    return this.questService.createQuest(dto);
  }

  /**
   * GET /quest/admin/panel [ADMIN ONLY]
   * Get admin panel metadata
   * 🔐 SECURITY: Only accessible by authorized admin wallet
   * Protected by QuestAdminGuard - verifies wallet address
   */
  @UseGuards(QuestAdminGuard)
  @Get('admin/panel')
  async getAdminPanelData(@Request() req) {
    return {
      message: 'Admin panel accessible',
      adminWallet: req.user.wallet,
      difficultyRanges: {
        SIMPLE: '1-9999',
        MEDIUM: '10000-19999',
        ADVANCED: '20000-29999',
      },
    };
  }

  /**
   * POST /quest/admin/sync [ADMIN ONLY]
   * Sync quest seed data to all users
   * 🔐 SECURITY: Only accessible by authorized admin wallet
   * Protected by QuestAdminGuard - verifies wallet address
   *
   * This endpoint:
   * - Upserts all quests from QUEST_SEED_DATA
   * - Initializes UserQuest records for all users who don't have them
   * - Does NOT reset existing progress (safe to run multiple times)
   * - Useful for adding new quests or updating quest data
   */
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @UseGuards(QuestAdminGuard)
  @Post('admin/sync')
  async syncQuestSeedData(@Request() req) {
    console.log(`[ADMIN] Quest sync initiated by ${req.user.wallet}`);
    const result = await this.questService.syncQuestSeedData();
    console.log(`[ADMIN] Quest sync completed by ${req.user.wallet}:`, result);
    return result;
  }
}
