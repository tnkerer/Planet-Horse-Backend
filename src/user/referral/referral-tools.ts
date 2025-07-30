import { Injectable } from '@nestjs/common';
import { xpConfig } from './xp-config';
import { levels } from './level';

@Injectable()
export class ReferralService {
  getLevelFromXP(xp: number) {
    return levels
      .slice()
      .reverse()
      .find(level => xp >= level.cumulativeXP);
  }

  addXPForReferral(currentXP: number): number {
    return currentXP + xpConfig.xpPerReferral;
  }

  addXPForSpending(currentXP: number, amountSpent: number): number {
    const xp = Math.floor(amountSpent / xpConfig.xpPerPhorseSpent.amount) * xpConfig.xpPerPhorseSpent.xp;
    return currentXP + xp;
  }

  calculateRewardPercent(xp: number): number {
    return this.getLevelFromXP(xp)?.percentReward ?? 0;
  }
}
