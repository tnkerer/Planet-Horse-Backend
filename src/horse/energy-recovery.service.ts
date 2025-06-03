// src/horses/energy‐recovery.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { globals } from '../data/globals';

@Injectable()
export class EnergyRecoveryService {
    private readonly logger = new Logger(EnergyRecoveryService.name);

    constructor(private readonly prisma: PrismaService) { }
    // We no longer need to page through batches; a single UPDATE suffices.
    @Cron('0 0 */4 * * *')
    public async handleEnergyRecovery(): Promise<void> {
        this.logger.debug('⏰ Starting 4‐hour energy‐recovery cron (SQL version)…');

        // Pull the two magic numbers out of your globals file:
        const baseRecovery: number = globals['Energy Recovery Rate'];
        const energySpent: number = globals['Energy Spent'];

        // The SQL below does exactly:
        //   extraFromLevel   = CEIL((level - 1) * 0.333)
        //   totalRecovery    = baseRecovery + extraFromLevel
        //   newEnergy        = LEAST(currentEnergy + totalRecovery, maxEnergy)
        //   newStatus        = (newEnergy >= energySpent ? 'IDLE' : 'SLEEP')
        //
        // Only horses with status IN ('IDLE','SLEEP') and currentEnergy < maxEnergy are affected.

        try {
            const baseRecovery = globals['Energy Recovery Rate'];
            const energySpent = globals['Energy Spent'];

            await this.prisma.$executeRaw`
  UPDATE "Horse"
  SET
    "currentEnergy" =
      LEAST(
        "currentEnergy"
        + ( ${baseRecovery} + CEIL(( "level" - 1 ) * 0.333 ) ),
        "maxEnergy"
      ),
    "status" =
      CASE
        WHEN ( "currentEnergy" + ( ${baseRecovery} + CEIL(( "level" - 1 ) * 0.333 ) ) ) >= ${energySpent}
        THEN 'IDLE'::"Status"
        ELSE 'SLEEP'::"Status"
      END
  WHERE
    "status" IN ( 'IDLE', 'SLEEP' )
    AND "currentEnergy" < "maxEnergy";
`;

            this.logger.debug('✅ 4-hour energy-recovery SQL completed successfully.');
        } catch (err: any) {
            this.logger.error(
                `❌ EnergyRecovery SQL failed: ${err.message}`,
                err.stack
            );
        }
    }
}
