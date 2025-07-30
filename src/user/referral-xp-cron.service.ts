import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { xpConfig } from '../user/referral/xp-config';
import { levels } from '../user/referral/level';
import { ReferralService } from '../user/referral/referral-tools';

@Injectable()
export class ReferralXpCronService {
    private readonly logger = new Logger(ReferralXpCronService.name);

    constructor(private readonly prisma: PrismaService) { }

    @Cron('0 */4 * * *') // every 4 hours
    // @Cron('30 * * * * *') // run every 30s for debug
    async processReferralXP() {
        this.logger.log('🔄 Starting Referral XP CRON job');

        try {
            const users = await this.prisma.user.findMany({
                where: { referrals: { some: {} } },
                select: {
                    id: true,
                    xp: true,
                    referralLevel: true,
                    referrals: { select: { id: true } },
                },
            });

            this.logger.debug(`Found ${users.length} users with referrals`);

            for (const user of users) {
                if (user.referrals.length === 0) {
                    this.logger.debug(`User ${user.id} has no referrals. Skipping.`);
                    continue;
                }

                // Calculate reward %
                const currentLevel = levels.find((lvl) => lvl.level === user.referralLevel);
                const percentReward = currentLevel?.percentReward ?? 0;

                // Build referee ID list
                const refereeIds = user.referrals.map((r) => `'${r.id}'`).join(',');
                if (!refereeIds) continue;

                // Fetch referee spending and what was already processed
                const phorseData = await this.prisma.$queryRawUnsafe<
                    { refereeId: string; totalPhorseSpent: number; alreadyProcessed: number }[]
                >(`
                    SELECT u.id as "refereeId",
                        u."totalPhorseSpent" as "totalPhorseSpent",
                        COALESCE(MAX(l."phorseSpent"), 0) as "alreadyProcessed"
                    FROM "User" u
                        LEFT JOIN "ReferralXPLog" l
                        ON l."refereeId" = u.id AND l."referrerId" = '${user.id}'
                    WHERE u.id IN (${refereeIds})
                    GROUP BY u.id, u."totalPhorseSpent"
                `);


                if (phorseData.length === 0) {
                    this.logger.debug(`User ${user.id}: no referee data found.`);
                    continue;
                }

                let totalNewXP = 0;
                let totalEarnings = 0;

                // Explicit debug output per referee
                const debugDeltaOutput: Array<{
                    refereeId: string;
                    totalPhorseSpent: number;
                    alreadyProcessed: number;
                    delta: number;
                }> = [];

                const logsToInsert: {
                    referrerId: string;
                    refereeId: string;
                    phorseSpent: number;
                }[] = [];

                // Calculate deltas
                for (const ref of phorseData) {
                    const delta = ref.totalPhorseSpent - ref.alreadyProcessed;

                    debugDeltaOutput.push({
                        refereeId: ref.refereeId,
                        totalPhorseSpent: ref.totalPhorseSpent,
                        alreadyProcessed: ref.alreadyProcessed,
                        delta,
                    });

                    if (delta > 0) {
                        // Calculate XP based on delta
                        const xpEarned =
                            Math.floor(delta / xpConfig.xpPerPhorseSpent.amount) *
                            xpConfig.xpPerPhorseSpent.xp;

                        if (xpEarned > 0) totalNewXP += xpEarned;

                        // Calculate earnings
                        const earnings = (delta * percentReward) / 100;
                        if (earnings > 0) totalEarnings += earnings;

                        // Log what we just processed
                        logsToInsert.push({
                            referrerId: user.id,
                            refereeId: ref.refereeId,
                            phorseSpent: ref.totalPhorseSpent, // always store current total
                        });
                    }
                }

                // Print detailed DELTA info for this user
                this.logger.debug(
                    `User ${user.id}: DELTA CHECK:\n${debugDeltaOutput
                        .map(
                            (d) =>
                                `  Referee ${d.refereeId}: total=${d.totalPhorseSpent}, already=${d.alreadyProcessed}, delta=${d.delta}`
                        )
                        .join('\n')}`
                );

                if (totalNewXP <= 0 && totalEarnings <= 0) {
                    this.logger.debug(`User ${user.id}: no XP or earnings to update`);
                    continue;
                }

                // Perform transaction for updates + logging
                await this.prisma.$transaction(async (tx) => {
                    // Insert new logs
                    if (logsToInsert.length > 0) {
                        await tx.referralXPLog.createMany({ data: logsToInsert });
                    }

                    // Update user XP and referral level
                    const referralService = new ReferralService();
                    const newXP = user.xp + totalNewXP;
                    const newLevel = referralService.getLevelFromXP(newXP);

                    await tx.user.update({
                        where: { id: user.id },
                        data: {
                            xp: newXP,
                            referralLevel: newLevel?.level ?? user.referralLevel,
                            phorse: { increment: totalEarnings },
                            referralPhorseEarned: { increment: totalEarnings },
                        },
                    });
                });

                this.logger.debug(
                    `✅ User ${user.id}: +${totalNewXP} XP, +${totalEarnings} PHORSE`
                );
            }

            this.logger.log('✅ Referral XP CRON completed successfully');
        } catch (error) {
            this.logger.error('❌ Error in Referral XP CRON', error);
        }
    }
}
