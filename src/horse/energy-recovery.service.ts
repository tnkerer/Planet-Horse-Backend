// src/horses/energy‐recovery.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { globals } from '../data/globals';
import * as later from 'later';

@Injectable()
export class EnergyRecoveryService {
  private readonly logger = new Logger(EnergyRecoveryService.name);

  constructor(private readonly prisma: PrismaService) { }

  public getNextEnergyRecoveryTime(): { nextTimestamp: number; humanReadable: string } {
    // Tell `later` to use local server time
    later.date.localTime();

    // Parse CRON string, support seconds (6-part format)
    const schedule = later.parse.cron('0 0 */6 * * *', true); // true = includes seconds

    // Get the next scheduled time
    const nextDate = later.schedule(schedule).next(1) as Date;

    return {
      nextTimestamp: nextDate.getTime(),
      humanReadable: this.formatTimeDistance(nextDate.getTime() - Date.now())
    };
  }

  private formatTimeDistance(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60) % 60;
    const hours = Math.floor(seconds / 3600);

    let result = '';
    if (hours > 0) result += `${hours} hour${hours > 1 ? 's' : ''}`;
    if (hours > 0 && minutes > 0) result += ' and ';
    if (minutes > 0) result += `${minutes} minute${minutes > 1 ? 's' : ''}`;
    if (result === '') result = 'less than a minute';

    return `in ${result}`;
  }
  // We no longer need to page through batches; a single UPDATE suffices.
  @Cron('5 0 */6 * * *')
  public async handleEnergyRecovery(): Promise<void> {
    this.logger.debug('⏰ Starting 6-hour energy-recovery cron (SQL version)…');

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
    "lastEnergy" = NOW()
  WHERE
    "status" IN ( 'IDLE', 'SLEEP' )
    AND "currentEnergy" < "maxEnergy";
`;

      this.logger.debug('✅ 6-hour energy-recovery SQL completed successfully.');
    } catch (err: any) {
      this.logger.error(
        `❌ EnergyRecovery SQL failed: ${err.message}`,
        err.stack
      );
    }
  }
}
