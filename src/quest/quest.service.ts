import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CreateQuestDto } from './dto/create-quest.dto';
import { QuestType, getNextMidnightUTC, isPastMidnightUTC } from './quest.types';
import { QUEST_SEED_DATA } from '../data/quests';
import { items as ITEM_DEFS } from '../data/items';

type ItemDef = (typeof ITEM_DEFS)[keyof typeof ITEM_DEFS];

function resolveItemDef(rawName: string): ItemDef | null {
  if (!rawName) return null;

  // exact match first
  if (ITEM_DEFS[rawName]) return ITEM_DEFS[rawName];

  // case-insensitive match as fallback
  const key = Object.keys(ITEM_DEFS).find(k => k.toLowerCase() === rawName.toLowerCase());
  return key ? ITEM_DEFS[key] : null;
}

function windowStartUtc(d: Date): Date {
  // returns the 00:05:00 UTC anchor for the day of `d`
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 5, 0, 0));
}
function tomorrowWindowStartUtc(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5, 0, 0));
  return t;
}
function utcDayKey(d: Date): string {
  // YYYY-MM-DD in UTC (for streak calc)
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

@Injectable()
export class QuestService {
  constructor(private prisma: PrismaService) { }

  async createQuest(dto: CreateQuestDto) {
    const difficulty = this.getDifficultyFromId(dto.id);
    if (difficulty !== dto.difficulty) {
      throw new BadRequestException(
        `Quest ID ${dto.id} does not match difficulty ${dto.difficulty}. ` +
        `Expected: ${difficulty} (1-9999: SIMPLE, 10000-19999: MEDIUM, 20000-29999: ADVANCED)`
      );
    }

    const existing = await this.prisma.quest.findUnique({
      where: { id: dto.id },
    });

    if (existing) {
      throw new BadRequestException(`Quest with ID ${dto.id} already exists`);
    }

    return this.prisma.quest.create({
      data: {
        id: dto.id,
        title: dto.title,
        description: dto.description,
        questType: dto.questType,
        reward: dto.reward as any,
        questsToComplete: dto.questsToComplete,
        difficulty: dto.difficulty,
        isDailyQuest: dto.isDailyQuest || false,
        horsesToUnlock: dto.horsesToUnlock || 0,
      },
    });
  }

  async listQuestsForUser(wallet: string) {
    const user = await this.prisma.user.findUnique({
      where: { wallet },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Clean up expired daily quests first
    await this.cleanupExpiredQuests(user.id);

    // Get user's horse count for filtering quests
    const horseCount = await this.prisma.horse.count({
      where: { ownerId: user.id },
    });

    const activeQuests = await this.prisma.quest.findMany({
      where: {
        isActive: true,
        horsesToUnlock: {
          lte: horseCount, // Only show quests where user has enough horses
        },
      },
      orderBy: { id: 'asc' },
    });

    const userQuests = await this.prisma.userQuest.findMany({
      where: { userId: user.id },
      include: { quest: true },
    });

    const userQuestMap = new Map(userQuests.map(uq => [uq.questId, uq]));

    const questProgressList = activeQuests.map(quest => {
      const userQuest = userQuestMap.get(quest.id);

      // Check if quest is expired (only daily quests have expiresAt)
      const isExpired = userQuest?.expiresAt && isPastMidnightUTC(userQuest.expiresAt);

      return {
        quest,
        progress: isExpired ? 0 : (userQuest?.progress || 0),
        completed: isExpired ? false : (userQuest?.completed || false),
        claimed: userQuest?.claimed || false,
        completedAt: isExpired ? null : (userQuest?.completedAt || null),
        claimedAt: userQuest?.claimedAt || null,
        expiresAt: userQuest?.expiresAt || null,
        isExpired,
      };
    });

    // Sort quests: incomplete first (by progress descending), then completed quests
    return questProgressList.sort((a, b) => {
      // Both completed or both incomplete
      if (a.completed === b.completed) {
        if (!a.completed) {
          // Both incomplete: sort by progress descending (more progress first)
          return b.progress - a.progress;
        }
        // Both completed: maintain original order (by quest ID)
        return a.quest.id - b.quest.id;
      }
      // Incomplete quests come before completed quests
      return a.completed ? -1 : 1;
    });
  }

  async claimQuest(wallet: string, questId: number) {
    const user = await this.prisma.user.findUnique({
      where: { wallet },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const quest = await this.prisma.quest.findUnique({
      where: { id: questId },
    });

    if (!quest) {
      throw new NotFoundException('Quest not found');
    }

    const userQuest = await this.prisma.userQuest.findUnique({
      where: {
        userId_questId: {
          userId: user.id,
          questId: questId,
        },
      },
    });

    if (!userQuest) {
      throw new BadRequestException('Quest not started');
    }

    if (!userQuest.completed) {
      throw new BadRequestException('Quest not completed yet');
    }

    if (userQuest.claimed) {
      throw new BadRequestException('Quest already claimed');
    }

    // ⏰ EXPIRATION CHECK: Prevent claiming expired daily quests
    // Check if the quest has expired before allowing claim
    if (userQuest.expiresAt && isPastMidnightUTC(userQuest.expiresAt)) {
      throw new BadRequestException(
        'This quest has expired and cannot be claimed. Daily quests reset at 00:00 UTC.'
      );
    }

    // 🔒 SECURITY CHECK: Prevent NFT transfer exploit
    // Users cannot claim quests if they acquired any horse within the last 24 hours
    const horses = await this.prisma.horse.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        tokenId: true,
        ownedSince: true,
        nickname: true,
      },
    });

    // Check if user has horses (they need at least one to complete quests)
    if (horses.length === 0) {
      throw new BadRequestException('You must own at least one horse to claim quest rewards');
    }

    /*     // Check ownership duration for anti-exploit protection
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
        const recentlyAcquiredHorses = horses.filter((horse) => {
          // If ownedSince is null, treat it as recently acquired for safety
          if (!horse.ownedSince) {
            return true;
          }
          return horse.ownedSince > twentyFourHoursAgo;
        });
    
        if (recentlyAcquiredHorses.length > 0) {
          // Log security event for monitoring
          console.warn(
            `[SECURITY] Quest claim blocked for user ${user.wallet} (${user.id}). ` +
            `Recently acquired horses: ${recentlyAcquiredHorses.map(h => h.tokenId).join(', ')}`
          );
    
          throw new ForbiddenException(
            'Quest rewards cannot be claimed within 24 hours of acquiring a new horse. ' +
            'This is to prevent exploitation. Please try again later.'
          );
        } */

    const rewards = quest.reward as Array<{
      type: string;
      amount: number;
      itemName?: string;
    }>;

    let phorseEarned = 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.userQuest.update({
        where: { id: userQuest.id },
        data: {
          claimed: true,
          claimedAt: new Date(),
        },
      });

      for (const reward of rewards) {
        if (reward.type === 'phorse') {
          await tx.user.update({
            where: { id: user.id },
            data: {
              phorse: { increment: reward.amount },
              totalPhorseEarned: { increment: reward.amount },
            },
          });
          phorseEarned += reward.amount;
        } else if (reward.type === 'wron') {
          await tx.user.update({
            where: { id: user.id },
            data: {
              wron: { increment: reward.amount },
            },
          });
        } else if (reward.type === 'medals') {
          await tx.user.update({
            where: { id: user.id },
            data: {
              medals: { increment: reward.amount },
            },
          });
        } else if (reward.type === 'shards') {
          await tx.user.update({
            where: { id: user.id },
            data: {
              shards: { increment: reward.amount },
            },
          });
        } else if (reward.type === 'item' && reward.itemName) {
          const def = resolveItemDef(reward.itemName);
          if (!def) {
            throw new BadRequestException(`Unknown item "${reward.itemName}" in quest reward`);
          }

          // Build payload using definition; only include props that exist
          const data: any = {
            ownerId: user.id,
            name: def.name,                 // canonical name
            value: 1,                       // keep your current default
            uses: def.uses ?? 1,
            breakable: def.breakable,
          };

          await tx.item.create({ data });
        }
      }
    });

    // Quest progression: track quest claims and PHORSE earned
    try {
      await this.incrementQuestProgress(user.id, QuestType.CLAIM_REWARDS, 1);
      if (phorseEarned > 0) {
        await this.incrementQuestProgress(user.id, QuestType.EARN_PHORSE, phorseEarned);
      }
    } catch (err) {
      console.error('Failed to update quest progress for claiming quest:', err);
    }

    return { success: true, rewards };
  }

  async dailyCheckin(wallet: string) {
    const user = await this.prisma.user.findUnique({ where: { wallet } });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const todayWindow = windowStartUtc(now);           // today's 00:05 UTC
    const nextWindow = now < todayWindow
      ? todayWindow                                      // later today at 00:05
      : tomorrowWindowStartUtc(now);                     // tomorrow 00:05 UTC

    const checkin = await this.prisma.dailyCheckin.findUnique({
      where: { userId: user.id },
    });

    // First-time checkin
    if (!checkin) {
      // Only allow if we're past today's window start
      if (now < todayWindow) {
        const ms = todayWindow.getTime() - now.getTime();
        const hrs = ms / 3_600_000;
        throw new ForbiddenException(
          `Check-in cooldown active. ${hrs.toFixed(1)} hours remaining`
        );
      }

      await this.prisma.dailyCheckin.create({
        data: {
          userId: user.id,
          lastCheckinAt: now,
          streak: 1,
          totalCheckins: 1,
        },
      });

      await this.incrementQuestProgress(user.id, QuestType.DAILY_CHECKIN);

      return {
        success: true,
        streak: 1,
        totalCheckins: 1,
        reward: { shards: 250 },
      };
    }

    // Has prior checkin:
    // Rule: exactly one checkin per UTC day (window opens at 00:05).
    // If the last checkin was **on or after** today's window, user has already checked in today.
    if (checkin.lastCheckinAt >= todayWindow) {
      // next allowed is nextWindow (tomorrow 00:05, or today 00:05 if we’re before it)
      const ms = nextWindow.getTime() - now.getTime();
      const hrs = ms / 3_600_000;
      throw new ForbiddenException(
        `Check-in cooldown active. ${Math.max(0, hrs).toFixed(1)} hours remaining`
      );
    }

    // If we are before today's window, user must wait until today 00:05 UTC
    if (now < todayWindow) {
      const ms = todayWindow.getTime() - now.getTime();
      const hrs = ms / 3_600_000;
      throw new ForbiddenException(
        `Check-in cooldown active. ${hrs.toFixed(1)} hours remaining`
      );
    }

    // Eligible: we are past today's window and lastCheckin was before it (i.e., not today)
    // Streak: compare UTC day keys of lastCheckinAt and now
    const lastKey = utcDayKey(checkin.lastCheckinAt);
    const todayKey = utcDayKey(now);

    // Compute yesterday's UTC key for streak check
    const yesterday = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1
    ));
    const yKey = utcDayKey(yesterday);

    const isConsecutiveDay = (lastKey === yKey);
    const newStreak = isConsecutiveDay ? checkin.streak + 1 : 1;

    await this.prisma.dailyCheckin.update({
      where: { userId: user.id },
      data: {
        lastCheckinAt: now,
        streak: newStreak,
        totalCheckins: { increment: 1 },
      },
    });

    await this.incrementQuestProgress(user.id, QuestType.DAILY_CHECKIN);

    return {
      success: true,
      streak: newStreak,
      totalCheckins: checkin.totalCheckins + 1,
      reward: { shards: 250 },
    };
  }

  async getCheckinStatus(wallet: string) {
    const user = await this.prisma.user.findUnique({ where: { wallet } });
    if (!user) throw new NotFoundException('User not found');

    const checkin = await this.prisma.dailyCheckin.findUnique({
      where: { userId: user.id },
    });

    const now = new Date();
    const todayWindow = windowStartUtc(now);
    const nextWindow = now < todayWindow
      ? todayWindow
      : tomorrowWindowStartUtc(now);

    if (!checkin) {
      const canCheckin = now >= todayWindow;
      return {
        canCheckin,
        streak: 0,
        totalCheckins: 0,
        lastCheckinAt: null,
        nextCheckinAt: canCheckin ? null : todayWindow,
      };
    }

    // Can check in if: we're past today's 00:05 and the user hasn't checked in since then.
    const alreadyCheckedToday = checkin.lastCheckinAt >= todayWindow;
    const canCheckin = (now >= todayWindow) && !alreadyCheckedToday;

    return {
      canCheckin,
      streak: checkin.streak,
      totalCheckins: checkin.totalCheckins,
      lastCheckinAt: checkin.lastCheckinAt,
      nextCheckinAt: canCheckin ? null : nextWindow,
    };
  }

  /**
   * Increment quest progress for a specific quest type
   * @param userId - User ID
   * @param questType - Type of quest (e.g., WIN_RACES, BREED_HORSES)
   * @param amount - Amount to increment (default 1)
   */
  async incrementQuestProgress(userId: string, questType: QuestType, amount: number = 1) {
    const quests = await this.prisma.quest.findMany({
      where: {
        isActive: true,
        questType: questType,
      },
    });

    for (const quest of quests) {
      let userQuest = await this.prisma.userQuest.findUnique({
        where: {
          userId_questId: {
            userId,
            questId: quest.id,
          },
        },
      });

      if (!userQuest) {
        // Create new userQuest with expiration for daily quests
        const expiresAt = quest.isDailyQuest ? getNextMidnightUTC() : null;
        userQuest = await this.prisma.userQuest.create({
          data: {
            userId,
            questId: quest.id,
            progress: 0,
            expiresAt,
          },
        });
      }

      // Check if quest is expired
      if (userQuest.expiresAt && isPastMidnightUTC(userQuest.expiresAt)) {
        // Reset expired daily quest
        await this.prisma.userQuest.update({
          where: { id: userQuest.id },
          data: {
            progress: 0,
            completed: false,
            claimed: false,
            completedAt: null,
            claimedAt: null,
            expiresAt: getNextMidnightUTC(),
          },
        });
        userQuest.progress = 0;
        userQuest.completed = false;
      }

      if (!userQuest.completed) {
        const newProgress = Math.min(
          userQuest.progress + amount,
          quest.questsToComplete
        );
        const isCompleted = newProgress >= quest.questsToComplete;

        await this.prisma.userQuest.update({
          where: { id: userQuest.id },
          data: {
            progress: newProgress,
            completed: isCompleted,
            completedAt: isCompleted ? new Date() : undefined,
          },
        });
      }
    }
  }

  /**
   * Clean up expired daily quests
   * Resets progress for quests that have passed their expiration time
   */
  private async cleanupExpiredQuests(userId: string) {
    const now = new Date();

    await this.prisma.userQuest.updateMany({
      where: {
        userId,
        expiresAt: {
          lte: now,
        },
        claimed: false, // Don't reset if already claimed
      },
      data: {
        progress: 0,
        completed: false,
        completedAt: null,
        expiresAt: getNextMidnightUTC(),
      },
    });
  }

  /**
   * Cron job that runs daily at 00:30 UTC
   * Resets all unclaimed daily quests (progress goes to 0, but quests remain visible)
   */
  @Cron('5 0 * * *', { timeZone: 'UTC' })
  async resetDailyQuests() {
    const now = new Date();
    const nextMidnight = getNextMidnightUTC(); // still points to the next 00:00 UTC

    const result = await this.prisma.userQuest.updateMany({
      where: {
        expiresAt: { lte: now },          // keep the “expired” guard
        quest: { is: { isDailyQuest: true } }, // only quests whose Quest.isDailyQuest = true
      },
      data: {
        progress: 0,
        completed: false,
        claimed: false,
        completedAt: null,
        expiresAt: nextMidnight,          // reset to the next midnight UTC
      },
    });

    console.log(
      `[Quest System] Daily reset completed at ${now.toISOString()}. ` +
      `Reset ${result.count} unclaimed daily quests.`
    );
  }

  private getDifficultyFromId(id: number): string {
    if (id >= 1 && id <= 9999) return 'SIMPLE';
    if (id >= 10000 && id <= 19999) return 'MEDIUM';
    if (id >= 20000 && id <= 29999) return 'ADVANCED';
    throw new BadRequestException('Quest ID must be between 1 and 29999');
  }

  /**
   * 🔄 SYNC SEED DATA TO DATABASE
   * Efficiently syncs quest seed data to all users
   * - Upserts quests from seed data (creates new, updates existing)
   * - Initializes UserQuest records for all users who don't have them
   * - Uses batch operations for performance
   * - Admin-only operation
   */
  async syncQuestSeedData() {
    const startTime = Date.now();
    console.log('[Quest Sync] Starting quest seed data synchronization...');

    try {
      // Step 1: Upsert quests from seed data
      console.log('[Quest Sync] Step 1/3: Upserting quests from seed data...');
      const questUpsertPromises = QUEST_SEED_DATA.map((questData) =>
        this.prisma.quest.upsert({
          where: { id: questData.id },
          update: {
            title: questData.title,
            description: questData.description,
            questType: questData.questType as QuestType,
            reward: questData.reward as any,
            questsToComplete: questData.questsToComplete,
            difficulty: questData.difficulty as any,
            isDailyQuest: questData.isDailyQuest,
            horsesToUnlock: questData.horsesToUnlock,
            isActive: true,
          },
          create: {
            id: questData.id,
            title: questData.title,
            description: questData.description,
            questType: questData.questType as QuestType,
            reward: questData.reward as any,
            questsToComplete: questData.questsToComplete,
            difficulty: questData.difficulty as any,
            isDailyQuest: questData.isDailyQuest,
            horsesToUnlock: questData.horsesToUnlock,
            isActive: true,
          },
        })
      );

      await Promise.all(questUpsertPromises);
      console.log(`[Quest Sync] ✓ Upserted ${QUEST_SEED_DATA.length} quests`);

      // Step 2: Get all users
      console.log('[Quest Sync] Step 2/3: Fetching all users...');
      const users = await this.prisma.user.findMany({
        select: { id: true },
      });
      console.log(`[Quest Sync] ✓ Found ${users.length} users`);

      // Step 3: Initialize UserQuest records for users who don't have them
      console.log('[Quest Sync] Step 3/3: Initializing UserQuest records...');
      let totalInitialized = 0;

      // Process in batches to avoid overwhelming the database
      const batchSize = 50;
      for (let i = 0; i < users.length; i += batchSize) {
        const userBatch = users.slice(i, i + batchSize);

        const userQuestPromises = userBatch.flatMap((user) =>
          QUEST_SEED_DATA.map((questData) =>
            this.prisma.userQuest.upsert({
              where: {
                userId_questId: {
                  userId: user.id,
                  questId: questData.id,
                },
              },
              update: {}, // Don't update existing progress
              create: {
                userId: user.id,
                questId: questData.id,
                progress: 0,
                completed: false,
                claimed: false,
                expiresAt: questData.isDailyQuest ? getNextMidnightUTC() : null,
              },
            }).catch((err) => {
              // Log error but don't fail the entire sync
              console.warn(`[Quest Sync] Warning: Failed to create UserQuest for user ${user.id}, quest ${questData.id}:`, err.message);
              return null;
            })
          )
        );

        const results = await Promise.all(userQuestPromises);
        const successCount = results.filter((r) => r !== null).length;
        totalInitialized += successCount;

        console.log(`[Quest Sync] Progress: ${Math.min(i + batchSize, users.length)}/${users.length} users processed`);
      }

      const duration = Date.now() - startTime;
      console.log(`[Quest Sync] ✓ Synchronization complete in ${duration}ms`);
      console.log(`[Quest Sync] Summary: ${QUEST_SEED_DATA.length} quests, ${users.length} users, ${totalInitialized} UserQuest records initialized`);

      return {
        success: true,
        questsUpserted: QUEST_SEED_DATA.length,
        usersProcessed: users.length,
        userQuestsInitialized: totalInitialized,
        durationMs: duration,
      };
    } catch (error) {
      console.error('[Quest Sync] ✗ Synchronization failed:', error);
      throw new BadRequestException(`Quest synchronization failed: ${error.message}`);
    }
  }
}
