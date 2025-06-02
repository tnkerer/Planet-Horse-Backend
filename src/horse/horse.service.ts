import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { globals } from '../data/globals';

import { xpProgression } from '../data/xp_progression';
import { lvlUpFee } from '../data/lvl_up_fee';
import { rarityBase } from '../data/rarity_base';

export interface RewardsSuccess {
  xpReward: number;
  tokenReward: number;
  position: number;
}

@Injectable()
export class HorseService {
  constructor(private readonly prisma: PrismaService) { }

  /**
  * List all horses owned by the user with the given wallet.
  */
  async listHorses(ownerWallet: string) {
    // 1) Lookup the user’s internal ID from their wallet
    const user = await this.prisma.user.findUnique({
      where: { wallet: ownerWallet },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // 2) Fetch all horses for that owner
    return this.prisma.horse.findMany({
      where: { ownerId: user.id },
      // include equipments if you want:
      include: { equipments: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
  * Compute rewards for a single horse, ensuring only the owner can call it.
  */
  async calculateRewards(
    ownerWallet: string,
    tokenId: string,
  ): Promise<RewardsSuccess> {
    // 1) Lookup user ID from wallet
    const user = await this.prisma.user.findUnique({
      where: { wallet: ownerWallet },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    // 2) Fetch the horse, ensure it's owned by this user
    const horse = await this.prisma.horse.findUnique({
      where: { tokenId },
      select: {
        ownerId: true,
        currentPower: true,
        currentSprint: true,
        currentSpeed: true,
        level: true,
      },
    });
    if (!horse) throw new NotFoundException('Horse not found');
    if (horse.ownerId !== user.id) {
      throw new ForbiddenException('Not your horse');
    }

    // 3) Compute baseRewardModifier
    const { currentPower, currentSprint, currentSpeed, level } = horse;
    const denom = globals["Base Denominator"];
    const baseRewardModifier = (currentPower + currentSprint + currentSpeed) / denom;

    // 4) Roll + level bonus
    const roll = Math.random() * 100;
    const adjRoll = roll + 2.5 * level;

    // 5) Determine position via Winrates thresholds
    const winrates = globals['Winrates'];
    const thresholds = Object.keys(winrates)
      .map(k => parseFloat(k))
      .sort((a, b) => a - b);

    let chosen = thresholds[0];
    for (const t of thresholds) {
      if (adjRoll >= t) chosen = t;
      else break;
    }
    const position = winrates[chosen.toString()];

    // 6) Lookup base rewards and apply modifier
    const rewardsCfg = globals['Rewards'];
    const [xpBase, tokenBase] = rewardsCfg[position.toString()] || [0, 0];

    const xpReward = parseFloat((xpBase * baseRewardModifier).toFixed(2));
    const tokenReward = parseFloat((tokenBase * baseRewardModifier).toFixed(2));

    return { xpReward, tokenReward, position };
  }

  /**
  * Performs a single‐level upgrade on `tokenId`:
  * 1. Verify owner
  * 2. Verify upgradable flag
  * 3. Compute random growths for Power/Sprint/Speed based on rarity
  * 4. Verify XP >= requiredXp
  * 5. Verify user has enough phorse + medals
  * 6. Deduct fees, bump stats, update upgradable flag, all in one transaction
  */
  async levelUp(
    ownerWallet: string,
    tokenId: string,
  ): Promise<{
    level: number;
    currentPower: number;
    currentSprint: number;
    currentSpeed: number;
    currentEnergy: number;
    maxEnergy: number;
    exp: number;
    upgradable: boolean;
    userPhorse: number;
    userMedals: number;
  }> {
    return await this.prisma.$transaction(async (tx) => {
      // 1) Lookup user & their phorse/medals balance
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: { id: true, phorse: true, medals: true },
      });
      if (!user) throw new NotFoundException('User not found');

      // 2) Fetch the horse & basic fields
      const horse = await tx.horse.findUnique({
        where: { tokenId },
        select: {
          id: true,
          ownerId: true,
          upgradable: true,
          exp: true,
          level: true,
          currentPower: true,
          currentSprint: true,
          currentSpeed: true,
          currentEnergy: true,
          maxEnergy: true,
          rarity: true,
        },
      });
      if (!horse) throw new NotFoundException('Horse not found');
      if (horse.ownerId !== user.id) {
        throw new ForbiddenException('Not your horse');
      }
      if (!horse.upgradable) {
        throw new BadRequestException('Horse is not currently upgradable');
      }

      const {
        id: horseId,
        exp: currentXp,
        level: oldLevel,
        currentPower,
        currentSprint,
        currentSpeed,
        currentEnergy,
        maxEnergy,
        rarity,
      } = horse;

      // 3) Determine XP requirement for current level
      const requiredXp = xpProgression[oldLevel];
      if (requiredXp === undefined) {
        throw new BadRequestException(`No XP requirement for level ${oldLevel}`);
      }
      if (currentXp < requiredXp) {
        throw new BadRequestException(
          `Not enough XP: need ${requiredXp}, have ${currentXp}`,
        );
      }

      // 4) Determine growth ranges from rarityBase
      const rarityInfo = rarityBase[rarity as keyof typeof rarityBase];
      if (!rarityInfo) {
        throw new BadRequestException(`Invalid rarity: ${rarity}`);
      }
      const minG = rarityInfo['Growth Min'];
      const maxG = rarityInfo['Growth Max'];

      // Helper to roll a single growth
      const rollGrowth = (): number => {
        return Math.random() * (maxG - minG) + minG;
      };

      // Three independent growth rolls
      const incPower = rollGrowth() * 3;
      const incSprint = rollGrowth() * 3;
      const incSpeed = rollGrowth() * 3;

      // 5) Determine “level up” cost in phorse & medals for oldLevel
      const phorseCost = lvlUpFee.phorse[oldLevel];
      const medalCost = lvlUpFee.medals[oldLevel];
      if (phorseCost === undefined || medalCost === undefined) {
        throw new BadRequestException(`No fee defined for level ${oldLevel}`);
      }
      if (user.phorse < phorseCost) {
        throw new BadRequestException(
          `Not enough PHORSE: need ${phorseCost}, have ${user.phorse}`,
        );
      }
      if (user.medals < medalCost) {
        throw new BadRequestException(
          `Not enough medals: need ${medalCost}, have ${user.medals}`,
        );
      }

      // 6) Compute new stats
      const newLevel = oldLevel + 1;
      const updatedPower = currentPower + incPower;
      const updatedSprint = currentSprint + incSprint;
      const updatedSpeed = currentSpeed + incSpeed;
      const updatedMaxEnergy = maxEnergy + 3;
      const updatedCurrentEnergy = currentEnergy + 3;

      // 7) Subtract the XP for oldLevel
      const remainingXp = currentXp - requiredXp;

      // 8) Determine if still upgradable for next level
      const nextRequiredXp = xpProgression[newLevel];
      let newUpgradable = false;
      if (nextRequiredXp !== undefined && remainingXp >= nextRequiredXp) {
        newUpgradable = true;
      }

      // 9) Perform the combined updates in one operation
      //   → Update user balances and horse stats atomically
      const [updatedUser, updatedHorse] = await Promise.all([
        tx.user.update({
          where: { id: user.id },
          data: {
            phorse: user.phorse - phorseCost,
            medals: user.medals - medalCost,
          },
          select: { phorse: true, medals: true },
        }),
        tx.horse.updateMany({
          where: {
            id: horseId,
            upgradable: true,
            exp: { gte: requiredXp },
          },
          data: {
            level: newLevel,
            currentPower: Number(updatedPower.toFixed(2)),
            currentSprint: Number(updatedSprint.toFixed(2)),
            currentSpeed: Number(updatedSpeed.toFixed(2)),
            maxEnergy: updatedMaxEnergy,
            currentEnergy: updatedCurrentEnergy,
            exp: remainingXp,
            upgradable: newUpgradable,
          },
        }),
      ]);

      if (updatedHorse.count === 0) {
        // Perhaps someone else leveled this horse simultaneously
        throw new BadRequestException(
          'Level-up failed: horse was already updated or insufficient XP',
        );
      }

      // 10) Return the new horse stats + updated user wallet
      return {
        level: newLevel,
        currentPower: Number(updatedPower.toFixed(2)),
        currentSprint: Number(updatedSprint.toFixed(2)),
        currentSpeed: Number(updatedSpeed.toFixed(2)),
        currentEnergy: updatedCurrentEnergy,
        maxEnergy: updatedMaxEnergy,
        exp: remainingXp,
        upgradable: newUpgradable,
        userPhorse: updatedUser.phorse,
        userMedals: updatedUser.medals,
      };
    });
  }

  /**
  * startRace:
  * 1. Verify the authenticated user (by wallet) actually owns this horse.
  * 2. Horse.status must be 'IDLE'.
  * 3. Horse.currentEnergy >= globals["Energy Spent"] (12).
  * 4. Perform reward roll (same logic as calculateRewards).
  * 5. Increase exp, phorse balance, medal (if position ≤ 3), deduct 12 energy.
  * 6. If newEnergy < 12 → status = 'SLEEP'.
  * 7. Otherwise compute “hurt chance” = 1/Log_base1.3(totalStats). If roll indicates hurt → status = 'BRUISED'.
  * 8. Return { xpReward, tokenReward, medalReward, position, finalStatus }.
  */
  async startRace(ownerWallet: string, tokenId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1) Fetch user
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: { id: true, phorse: true, medals: true },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }

      // 2) Fetch horse
      const horse = await tx.horse.findUnique({
        where: { tokenId },
        select: {
          id: true,
          ownerId: true,
          status: true,
          currentEnergy: true,
          exp: true,
          level: true,
          currentPower: true,
          currentSprint: true,
          currentSpeed: true,
        },
      });
      if (!horse) {
        throw new NotFoundException('Horse not found');
      }
      if (horse.ownerId !== user.id) {
        throw new ForbiddenException('Not your horse');
      }

      // 3) Status must be IDLE
      if (horse.status !== 'IDLE') {
        throw new BadRequestException('Horse must be IDLE to start a race');
      }

      // 4) Energy check
      const energySpent = globals['Energy Spent'] as number; // 12
      if (horse.currentEnergy < energySpent) {
        throw new BadRequestException(
          `Not enough energy: need ${energySpent}, have ${horse.currentEnergy}`,
        );
      }

      // 5) Calculate rewards (dup of calculateRewards logic, to avoid nested transaction)
      const totalStats = horse.currentPower + horse.currentSprint + horse.currentSpeed;
      const baseMod = totalStats / (globals['Base Denominator'] as number);

      // Make a random roll in [0,100)
      const roll = Math.random() * 100;
      const adjRoll = roll + 2.5 * horse.level;

      // Find highest threshold ≤ adjRoll
      const winrates = globals['Winrates'] as Record<string, number>;
      const thresholds = Object.keys(winrates)
        .map((k) => parseFloat(k))
        .sort((a, b) => a - b);

      let chosenThreshold = thresholds[0];
      for (const t of thresholds) {
        if (adjRoll >= t) {
          chosenThreshold = t;
        } else {
          break;
        }
      }
      const position = winrates[chosenThreshold.toString()]; // 1..10

      // Look up base reward for that finish‐position
      const rewardsCfg = globals['Rewards'] as Record<string, readonly [number, number]>;
      const [xpBase, tokenBase] = rewardsCfg[position.toString()];

      // Compute xpReward & tokenReward
      // “Experience Multiplier” is in globals, currently 1
      const xpReward = Math.floor((xpBase * baseMod) * (globals['Experience Multiplier'] as number));
      const tokenReward = parseFloat((tokenBase * baseMod).toFixed(2));

      // 6) Medal reward = 1 if position ≤ 3, else 0
      const medalReward = position <= 3 ? 1 : 0;

      // 7) New energy after subtracting cost
      const newEnergy = horse.currentEnergy - energySpent;

      // 8) Determine “hurt chance”: 1 / (log_base_1.3(totalStats))
      //    log_base_1.3(x) = log(x)/log(1.3)
      const denom = Math.log(totalStats) / Math.log(1.6);
      const hurtChance = denom > 0 ? 1 / denom : 0;
      const random01 = Math.random();
      const isHurt = random01 < hurtChance;

      // 9) Decide new status
      let finalStatus: 'IDLE' | 'SLEEP' | 'BRUISED' = 'IDLE';
      if (newEnergy < energySpent) {
        finalStatus = 'SLEEP';
      }
      if (isHurt) {
        finalStatus = 'BRUISED';
      }

      // 10) Prepare updated values
      const updatedExp = horse.exp + xpReward;
      const updatedPhorse = user.phorse + tokenReward;
      const updatedMedals = user.medals + medalReward;

      // 11) Perform updates in one transaction
      const [updatedUser, updatedHorse] = await Promise.all([
        tx.user.update({
          where: { id: user.id },
          data: {
            phorse: updatedPhorse,
            medals: updatedMedals,
          },
          select: { phorse: true, medals: true },
        }),
        tx.horse.updateMany({
          where: {
            id: horse.id,
            status: 'IDLE',                // ensure no race state changed
            exp: { gte: horse.exp },    // ensure exp is unchanged by another race
            // currentEnergy ≥ energySpent also guaranteed above
          },
          data: {
            exp: updatedExp,
            currentEnergy: newEnergy,
            status: finalStatus,
            // (we do NOT update level / stats here—this is purely “run a race”)
          },
        }),
      ]);

      if (updatedHorse.count === 0) {
        // Another concurrent operation likely changed the horse first
        throw new BadRequestException('Race failed: horse state was modified');
      }

      // 12) Return the results
      return {
        xpReward,
        tokenReward,
        medalReward,
        position,
        finalStatus,
      };
    });
  }

  /**
  * restoreHorse:
  * 1. Verify user owns the horse.
  * 2. Horse.status must be BRUISED.
  * 3. Compute cost = level * 50 PHORSE.
  * 4. Check user's PHORSE balance ≥ cost.
  * 5. Subtract cost from user.phorse, set horse.status → either SLEEP or IDLE depending on currentEnergy.
  * 6. Return the horse’s new status and updated user.phorse.
  */
  async restoreHorse(ownerWallet: string, tokenId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1) Find user
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: { id: true, phorse: true },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }

      // 2) Find horse
      const horse = await tx.horse.findUnique({
        where: { tokenId },
        select: {
          id: true,
          ownerId: true,
          status: true,
          level: true,
          currentEnergy: true,
        },
      });
      if (!horse) {
        throw new NotFoundException('Horse not found');
      }
      if (horse.ownerId !== user.id) {
        throw new ForbiddenException('You do not own this horse');
      }

      // 3) Horse must be BRUISED
      if (horse.status !== 'BRUISED') {
        throw new BadRequestException('Horse is not currently BRUISED');
      }

      // 4) Compute cost
      // cost = level * 100 PHORSE
      const cost = horse.level * globals["Recovery Cost"];
      if (user.phorse < cost) {
        throw new BadRequestException(
          `Not enough PHORSE to restore. Cost = ${cost}, you have ${user.phorse}`,
        );
      }

      // 5) Deduct cost and set new status
      const energySpent = globals['Energy Spent'] as number; // 12
      const newStatus =
        horse.currentEnergy >= energySpent ? 'IDLE' : 'SLEEP';

      // 6) Perform updates in transaction
      const [updatedUser, updatedHorse] = await Promise.all([
        tx.user.update({
          where: { id: user.id },
          data: { phorse: user.phorse - cost },
          select: { phorse: true },
        }),
        tx.horse.update({
          where: { id: horse.id },
          data: { status: newStatus },
          select: { status: true },
        }),
      ]);

      // 7) Return results
      return {
        newStatus: updatedHorse.status as 'IDLE' | 'SLEEP',
        userPhorse: updatedUser.phorse,
      };
    });
  }
}
