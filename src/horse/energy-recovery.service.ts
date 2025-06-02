// src/horses/energy‐recovery.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import type { Horse as HorseModel } from '@prisma/client';
import { globals } from '../data/globals';

@Injectable()
export class EnergyRecoveryService {
    private readonly logger = new Logger(EnergyRecoveryService.name);

    // Adjust batch size to taste (100 is a common starting point).
    private static readonly BATCH_SIZE = 100;

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Runs every 4 hours on the hour (00:00, 04:00, 08:00, etc.).
     * Finds all IDLE/SLEEP horses whose currentEnergy < maxEnergy, in batches,
     * then updates each horse’s energy + status. BRUISED horses are skipped.
     */
    @Cron('0 0 */4 * * *')
    public async handleEnergyRecovery(): Promise<void> {
        this.logger.debug('⏰ Starting 4-hour energy‐recovery cron…');

        let lastProcessedId: string | null = null;
        let batchCount = 0;

        do {
            batchCount++;
            if (batchCount > 10000) {
                // Safety valve: if we somehow loop more than 10,000 batches,
                // something has gone very wrong—break out.
                this.logger.error(
                    `🔥 EnergyRecovery: exceeded max batch count; aborting early. lastProcessedId=${lastProcessedId}`,
                );
                break;
            }

            let batch: HorseModel[];
            try {
                // 1) Fetch up to BATCH_SIZE horses that are IDLE/SLEEP and low on energy
                batch = await this.prisma.horse.findMany({
                    where: {
                        AND: [
                            { status: { in: ['IDLE', 'SLEEP'] } },
                            { currentEnergy: { lt: globals['maxEnergy'] }, },
                            ...(lastProcessedId
                                ? [{ id: { gt: lastProcessedId } }]
                                : []),
                        ],
                    },
                    orderBy: { id: 'asc' },
                    take: EnergyRecoveryService.BATCH_SIZE,
                });
            } catch (fetchErr) {
                this.logger.error(
                    `❌ Error fetching batch #${batchCount} (lastId=${lastProcessedId}): ${fetchErr.message}`,
                    fetchErr.stack,
                );
                // If we can’t even fetch, abort this entire cron run.
                break;
            }

            if (batch.length === 0) {
                // No more horses to process.
                this.logger.debug('✅ No eligible horses found; ending energy‐recovery loop.');
                break;
            }

            this.logger.debug(
                `– Processing batch #${batchCount}: ${batch.length} horses (starting from id > ${lastProcessedId})…`,
            );

            // 2) For each horse, compute newEnergy & newStatus, then update.
            //    Use Promise.allSettled so that one bad update doesn’t cancel the rest.
            const updatePromises = batch.map((h) =>
                (async () => {
                    try {
                        const level = h.level;
                        const baseRecovery = globals['Energy Recovery Rate'];
                        const extraFromLevel = Math.ceil((level - 1) * 0.333);
                        const totalRecovery = baseRecovery + extraFromLevel;

                        const calonNewEnergy = h.currentEnergy + totalRecovery;
                        const newEnergy = Math.min(calonNewEnergy, h.maxEnergy);
                        const newStatus =
                            newEnergy >= globals['Energy Spent'] ? 'IDLE' : 'SLEEP';

                        await this.prisma.horse.update({
                            where: { id: h.id },
                            data: {
                                currentEnergy: newEnergy,
                                status: newStatus,
                            },
                        });
                    } catch (singleErr) {
                        this.logger.error(
                            `⚠ Failed to update horse ${h.id} in batch #${batchCount}: ${singleErr.message}`,
                        );
                        // swallow the error so it won’t break Promise.allSettled
                    }
                })(),
            );

            // 3) Await all updates (some may reject, but allSettled ensures we wait them out).
            await Promise.allSettled(updatePromises);

            // 4) Advance our pagination cursor to the last horse’s ID,
            //    even if some updates in the batch failed. That horse (and all before it)
            //    will not be re‐fetched in the next loop iteration.
            lastProcessedId = batch[batch.length - 1].id;
        } while (batchCount && batchCount < 10000);

        this.logger.debug('✅ 4-hour energy‐recovery cron completed.');
    }
}
