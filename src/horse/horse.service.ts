import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { globals } from '../data/globals';
import { items as allItems, itemModifiers } from '../data/items';
import { xpProgression } from '../data/xp_progression';
import { lvlUpFee } from '../data/lvl_up_fee';
import { rarityBase } from '../data/rarity_base';
import { Status } from '@prisma/client';
import { EquipItemDto } from './dto/equip-item.dto';
import { UnequipItemDto } from './dto/unequip-item.dto';

export interface RewardsSuccess {
  xpReward: number;
  tokenReward: number;
  position: number;
}

@Injectable()
export class HorseService {
  constructor(private readonly prisma: PrismaService) { }

  private readonly FAUCET_OWNER_ID = 'e425b759-fe1f-4641-ad3c-50bd8ae5663f';
  private readonly CLAIM_COST = 1000;

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
          status: true
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
        status
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
            status: ((updatedCurrentEnergy > 11) && status == 'SLEEP') ? 'IDLE' : status,
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
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: { id: true, phorse: true, medals: true },
      });
      if (!user) throw new NotFoundException('User not found');

      const horse = await tx.horse.findUnique({
        where: { tokenId },
        include: {
          equipments: true, // to fetch equipped items
        },
      });
      if (!horse) throw new NotFoundException('Horse not found');
      if (horse.ownerId !== user.id) throw new ForbiddenException('Not your horse');
      if (horse.status !== 'IDLE') throw new BadRequestException('Horse must be IDLE to start a race');

      const baseEnergy = globals['Energy Spent'] as number;

      // Aggregate modifiers from equipped items
      const equippedModifiers = horse.equipments
        .map((item) => itemModifiers[item.name])
        .filter(Boolean);

      const totalModifier = equippedModifiers.reduce(
        (acc, mod) => ({
          positionBoost: acc.positionBoost * mod.positionBoost,
          hurtRate: acc.hurtRate * mod.hurtRate,
          xpMultiplier: acc.xpMultiplier * mod.xpMultiplier,
          energySaved: acc.energySaved + mod.energySaved,
        }),
        { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, energySaved: 0 }
      );

      const energySpent = Math.max(1, baseEnergy - totalModifier.energySaved);
      if (horse.currentEnergy < energySpent) {
        throw new BadRequestException(`Not enough energy: need ${energySpent}, have ${horse.currentEnergy}`);
      }

      const totalStats = horse.currentPower + horse.currentSprint + horse.currentSpeed;
      const baseMod = totalStats / (globals['Base Denominator'] as number);

      const roll = Math.min(100, Math.random() * 100 * totalModifier.positionBoost);
      const adjRoll = roll + 2.5 * horse.level;

      const winrates = globals['Winrates'] as Record<string, number>;
      const thresholds = Object.keys(winrates).map(parseFloat).sort((a, b) => a - b);

      let chosenThreshold = thresholds[0];
      for (const t of thresholds) {
        if (adjRoll >= t) chosenThreshold = t;
        else break;
      }
      const position = winrates[chosenThreshold.toString()];
      const rewardsCfg = globals['Rewards'] as Record<string, readonly [number, number]>;
      const [xpBase, tokenBase] = rewardsCfg[position.toString()];

      const baseXpReward = Math.floor(xpBase * baseMod * (globals['Experience Multiplier'] as number));
      const xpReward = Math.floor(baseXpReward * totalModifier.xpMultiplier);
      const tokenReward = parseFloat((tokenBase * baseMod).toFixed(2));
      const medalReward = position <= 3 ? 1 : 0;

      const newEnergy = horse.currentEnergy - energySpent;
      const denom = Math.log(totalStats) / Math.log(1.6);
      const hurtChance = Math.min(1, denom > 0 ? 1 / denom : 0);
      const isHurt = Math.random() * totalModifier.hurtRate < hurtChance;

      let finalStatus: 'IDLE' | 'SLEEP' | 'BRUISED' = 'IDLE';
      if (newEnergy < baseEnergy) finalStatus = 'SLEEP';
      if (isHurt) finalStatus = 'BRUISED';

      const updatedExp = horse.exp + xpReward;
      const updatedPhorse = user.phorse + tokenReward;
      const updatedMedals = user.medals + medalReward;
      const updatedUpgradable = updatedExp > xpProgression[horse.level];

      // Decrement uses and delete items that reach 0
      const itemUpdates = horse.equipments.map((item) => {
        if (!itemModifiers[item.name]) return null;
        const newUses = (item.uses ?? 0) - 1;
        return newUses > 0
          ? tx.item.update({
            where: { id: item.id },
            data: { uses: newUses },
          })
          : tx.item.delete({
            where: { id: item.id },
          });
      }).filter(Boolean);

      const [updatedUser, updatedHorse] = await Promise.all([
        tx.user.update({
          where: { id: user.id },
          data: { phorse: updatedPhorse, medals: updatedMedals },
          select: { phorse: true, medals: true },
        }),
        tx.horse.updateMany({
          where: {
            id: horse.id,
            status: 'IDLE',
            exp: { gte: horse.exp },
          },
          data: {
            exp: updatedExp,
            currentEnergy: newEnergy,
            status: finalStatus,
            upgradable: updatedUpgradable,
          },
        }),
        ...itemUpdates,
      ]);

      if (updatedHorse.count === 0) {
        throw new BadRequestException('Race failed: horse state was modified');
      }

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


  /**
  * Transfers one “faucet” horse (lowest tokenId) to the caller,
  * but only if they have ≥1000 phorse.  
  * Throttled elsewhere in the controller.
  */
  async claimHorse(callerWallet: string): Promise<{ claimedTokenId: string }> {
    // 1) Run a transaction, so that balance‐deduction + horse‐reassign are atomic.
    return await this.prisma.$transaction(async (tx) => {
      // ────────────────────────────────────────────────────────────────
      // 1) Make sure caller exists & get their user.id
      const callerUser = await tx.user.findUnique({
        where: { wallet: callerWallet }
      });
      if (!callerUser) {
        throw new NotFoundException('Caller not found in users table');
      }
      const callerUserId = callerUser.id; // ↪ this is a UUID, not the wallet string

      // 2) Check if they have ≥ 1000 phorse
      if (callerUser.phorse < 1000) {
        throw new BadRequestException('Insufficient PHORSE balance to claim a faucet horse');
      }

      // 3) Deduct 1000 phorse from the caller
      await tx.user.update({
        where: { id: callerUserId },
        data: { phorse: { decrement: 1000 } }
      });

      // 4) Find the single faucet horse with smallest tokenId
      //    We use a raw SQL query with lock to avoid race conditions.
      //    Note: Prisma currently does not expose SELECT … FOR UPDATE easily,
      //    so we do a raw query here. Make sure your schema name matches.
      const rawResult: Array<{ tokenId: string }> = await tx.$queryRawUnsafe(`
        SELECT "tokenId"
        FROM "Horse"
        WHERE "ownerId" = $1
        ORDER BY ("tokenId")::int ASC
        LIMIT 1
        FOR UPDATE
      `, this.FAUCET_OWNER_ID);

      if (rawResult.length === 0) {
        throw new NotFoundException('No faucet horses available to claim');
      }

      const toClaimTokenId = rawResult[0].tokenId;

      // 5) Atomically reassign that one row, but only if it still belongs to FAUCET_OWNER_ID
      const updatedCount = await tx.horse.updateMany({
        where: {
          tokenId: toClaimTokenId,
          ownerId: this.FAUCET_OWNER_ID
        },
        data: {
          ownerId: callerUserId // ← MUST be the UUID, not wallet string
        },
      });

      // If updateMany affected 0 rows, someone else grabbed it concurrently
      if (updatedCount.count !== 1) {
        // Throw to roll back the entire transaction (including the 1000 deduction).
        throw new NotFoundException('Failed to claim faucet horse (already claimed by someone else)');
      }

      // 6) Success: return the newly claimed tokenId
      return { claimedTokenId: toClaimTokenId };
    });
  }

  /**
  * Consume exactly one instance of `itemName` from the caller’s inventory,
  * then apply its `property` to whichever INT fields of the horse need updating.
  *
  * - If property.currentEnergy is present, we increment (and cap at maxEnergy).
  * - For every other property key (e.g. currentPower, currentSprint, etc.),
  *   we simply add the given integer. No additional capping logic is applied.
  */
  async consumeItem(
    callerWallet: string,
    tokenId: string,
    itemName: string
  ): Promise<{
    horseTokenId: string;
    updatedFields: Record<string, number>;
    remainingQuantityOfThatItem: number;
  }> {
    return await this.prisma.$transaction(async (tx) => {
      // ─────────────────────────────────────────────────────────────────────
      // 1) Look up the user record by wallet
      const callerUser = await tx.user.findUnique({
        where: { wallet: callerWallet },
        select: { id: true },
      });
      if (!callerUser) {
        throw new NotFoundException(
          'Authenticated user not found in database'
        );
      }
      const callerUserId = callerUser.id;

      // ─────────────────────────────────────────────────────────────────────
      // 2) Ensure the item exists and is consumable
      const itemDef = (allItems as Record<string, any>)[itemName];
      if (!itemDef) {
        throw new BadRequestException(`Item "${itemName}" does not exist`);
      }
      if (itemDef.consumable !== true) {
        throw new BadRequestException(
          `Item "${itemName}" is not consumable`
        );
      }

      // The `property` object might contain e.g. { currentEnergy: 3 } or { currentPower: 2, currentSpeed: 1 }, etc.
      const property: Record<string, number> = itemDef.property ?? {};
      if (Object.keys(property).length === 0) {
        throw new BadRequestException(
          `Consumable "${itemName}" has no valid "property" to apply`
        );
      }

      // ─────────────────────────────────────────────────────────────────────
      // 3) Find the horse by tokenId, validate ownership
      const horse = await tx.horse.findUnique({
        where: { tokenId: tokenId },
        select: {
          id: true,
          tokenId: true,
          ownerId: true,
          currentEnergy: true,
          maxEnergy: true,
          currentPower: true,
          currentSprint: true,
          currentSpeed: true,
          status: true,
          // (if you add other integer fields later, include them in select)
        },
      });
      if (!horse) {
        throw new NotFoundException(`Horse with tokenId=${tokenId} not found`);
      }
      if (horse.ownerId !== callerUserId) {
        throw new BadRequestException(`You do not own horse #${tokenId}`);
      }

      // ─────────────────────────────────────────────────────────────────────
      // 4) Find exactly one Item row (of that name) owned by this user
      const oneItem = await tx.item.findFirst({
        where: {
          ownerId: callerUserId,
          name: itemName,
        },
        select: { id: true },
      });
      if (!oneItem) {
        throw new NotFoundException(
          `You do not own any "${itemName}" consumables`
        );
      }

      // ─────────────────────────────────────────────────────────────────────
      // 5) Prepare the “updateData” object by looping over each key in property.
      //
      //    If the key is "currentEnergy", we cap at maxEnergy;
      //    otherwise, we simply do: newValue = oldValue + increment.
      const updateData: Record<string, any> = {};
      const updatedFields: Record<string, number> = {};

      for (const [fieldName, incValue] of Object.entries(property)) {
        // Validate that the horse indeed has that field and it is numeric.
        if (!(fieldName in horse)) {
          throw new BadRequestException(
            `Horse model has no field "${fieldName}" to update`
          );
        }
        const oldValue = (horse as any)[fieldName] as number;
        if (typeof oldValue !== 'number') {
          throw new BadRequestException(
            `Horse field "${fieldName}" is not numeric and cannot be incremented`
          );
        }

        if (fieldName === 'currentEnergy') {
          // cap at maxEnergy
          let newEnergy = oldValue + incValue;
          if (newEnergy > horse.maxEnergy) {
            newEnergy = horse.maxEnergy;
          }
          if (newEnergy >= globals["Energy Spent"] && horse.status === 'SLEEP') {
            updateData.status = Status.IDLE
          }
          updateData.currentEnergy = newEnergy;
          updatedFields.currentEnergy = newEnergy;
        } else {
          // for any other INT field (currentPower, currentSprint, etc.)
          const newValue = oldValue + incValue;
          updateData[fieldName] = newValue;
          updatedFields[fieldName] = newValue;
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // 6) Perform the horse update
      const updatedHorse = await tx.horse.update({
        where: { tokenId: tokenId },
        data: updateData,
        select: {
          tokenId: true,
          // Return each updated field so the controller can send it back
          currentEnergy: true,
          maxEnergy: true,
          currentPower: true,
          currentSprint: true,
          currentSpeed: true,
          // (include any other INT fields you might have)
        },
      });

      // ─────────────────────────────────────────────────────────────────────
      // 7) Delete exactly one item row (the “used” consumable)
      await tx.item.delete({
        where: { id: oneItem.id },
      });

      // ─────────────────────────────────────────────────────────────────────
      // 8) Count how many of that consumable remain for the user:
      const leftoverCount = await tx.item.count({
        where: {
          ownerId: callerUserId,
          name: itemName,
        },
      });

      // ─────────────────────────────────────────────────────────────────────
      // 9) Return a summary object
      return {
        horseTokenId: tokenId,
        updatedFields: updatedFields,
        remainingQuantityOfThatItem: leftoverCount,
      };
    });
  }

  /**
  * Find a user by wallet address (returns only { id }).
  * Throw NotFoundException if no such user.
  */
  private async findUserIdByWallet(wallet: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { wallet },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user.id;
  }

  /**
   * 1) Checks ownership + existence of the horse by tokenId.
   * 2) Enforces “max equipped slots” based on level:
   *     level < 2: 0 slots
   *     2 ≤ level < 7: 1 slot
   *     7 ≤ level < 15: 2 slots
   *     15 ≤ level: 3 slots
   * 3) Finds the first Item owned by this user:
   *     - item.name = dto.name
   *     - item.uses = dto.usesLeft
   *     - item.equipedBy = null  (i.e. currently not equipped)
   * 4) If found, sets item.horseId = horse.id (in a single transaction).
   */
  async equipItem(
    ownerWallet: string,
    tokenId: string,
    dto: EquipItemDto,
  ): Promise<{ success: true }> {
    // (1) Look up userId from wallet:
    const userId = await this.findUserIdByWallet(ownerWallet);

    // (2) Look up the horse by tokenId, ensure ownerId === userId:
    const horse = await this.prisma.horse.findUnique({
      where: { tokenId },
      select: {
        id: true,
        ownerId: true,
        level: true,
        equipments: {
          select: { id: true },
        },
      },
    });
    if (!horse) {
      throw new NotFoundException(`Horse ${tokenId} not found`);
    }
    if (horse.ownerId !== userId) {
      throw new ForbiddenException(`You do not own horse ${tokenId}`);
    }

    // (3) Determine how many items the horse is allowed to have equipped:
    const currentlyEquippedCount = horse.equipments.length;
    let maxSlots = 0;
    if (horse.level >= 15) maxSlots = 3;
    else if (horse.level >= 7) maxSlots = 2;
    else if (horse.level >= 2) maxSlots = 1;
    else maxSlots = 0;

    if (currentlyEquippedCount >= maxSlots) {
      throw new BadRequestException(
        `Horse level ${horse.level} allows only ${maxSlots} item(s) equipped`,
      );
    }

    // (4) Find the first matching Item row:
    const matchingItem = await this.prisma.item.findFirst({
      where: {
        ownerId: userId,
        name: dto.name,
        uses: dto.usesLeft,
        equipedBy: null, // not already equipped to any horse
      },
      orderBy: { createdAt: 'asc' }, // “take the oldest one first”
    });
    if (!matchingItem) {
      throw new NotFoundException(
        `No available item "${dto.name}" with ${dto.usesLeft} uses found in your bag`,
      );
    }

    // (5) In a short transaction, update that item → equipedBy = horse.id:
    await this.prisma.$transaction(async (tx) => {
      // double‐check that the item is still un‐equipped & owned by the user:
      const fresh = await tx.item.findUnique({
        where: { id: matchingItem.id },
        select: { equipedBy: true, ownerId: true },
      });
      if (!fresh) {
        throw new NotFoundException(`Item no longer exists`);
      }
      if (fresh.ownerId !== userId) {
        throw new ForbiddenException(`You do not own that item anymore`);
      }
      if (fresh.equipedBy !== null) {
        throw new BadRequestException(`That item is already equipped`);
      }
      // finally, attach to horse:
      await tx.item.update({
        where: { id: matchingItem.id },
        data: { horseId: horse.id },
      });
    });

    return { success: true };
  }

  /**
   * 1) Verify user → horse ownership (same as above).
   * 2) In body, client sends { name }. We must confirm that this horse
   *    actually has at least one equipped Item with that name.
   * 3) Find EXACTLY one such item (e.g. the oldest). Then do `update(...)`
   *    to set its `equipedBy = null`.
   */
  async unequipItem(
    ownerWallet: string,
    tokenId: string,
    dto: UnequipItemDto,
  ): Promise<{ success: true }> {
    // (1) Find userId from wallet:
    const userId = await this.findUserIdByWallet(ownerWallet);

    // (2) Look up the horse and confirm ownership:
    const horse = await this.prisma.horse.findUnique({
      where: { tokenId },
      select: {
        id: true,
        ownerId: true,
        equipments: {
          where: { name: dto.name, horseId: { not: null } },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    if (!horse) {
      throw new NotFoundException(`Horse ${tokenId} not found`);
    }
    if (horse.ownerId !== userId) {
      throw new ForbiddenException(`You do not own horse ${tokenId}`);
    }

    // (3) Did the horse have any item with that name currently equipped?
    if (horse.equipments.length === 0) {
      throw new BadRequestException(
        `Horse has no equipped item named "${dto.name}"`,
      );
    }
    const itemToUnequipId = horse.equipments[0].id;

    // (4) Detach in one simple update:
    await this.prisma.item.update({
      where: { id: itemToUnequipId },
      data: { horseId: null },
    });

    return { success: true };
  }
}
