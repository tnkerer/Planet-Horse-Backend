import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { globals } from '../data/globals';
import { items as allItems, itemModifiers } from '../data/items';
import { xpProgression, levelLimits } from '../data/xp_progression';
import { lvlUpFee } from '../data/lvl_up_fee';
import { rarityBase } from '../data/rarity_base';
import { Status } from '@prisma/client';
import { EquipItemDto } from './dto/equip-item.dto';
import { UnequipItemDto } from './dto/unequip-item.dto';
import Moralis from 'moralis';

const MORALIS_API_KEY = process.env.MORALIS_API_KEY; // Use .env file for safety
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS || '0x66eeb20a1957c4b3743ecad19d0c2dbcf56b683f'; // Your contract address
const CHAIN_ID = 2020;

export interface RewardsSuccess {
  xpReward: number;
  tokenReward: number;
  position: number;
}

@Injectable()
export class HorseService {
  constructor(private readonly prisma: PrismaService) { }

  private async initMoralis() {
    if (!Moralis.Core.isStarted) {
      await Moralis.start({ apiKey: MORALIS_API_KEY });
    }
  }

  async listBlockchainHorses(walletAddress: string) {
    await this.initMoralis();

    return await this.prisma.$transaction(async (tx) => {
      // 1. Lookup user in DB (fail if user doesn't exist)
      const user = await tx.user.findUnique({
        where: { wallet: walletAddress.toLowerCase() },
        select: { id: true },
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const userId = user.id;

      // 2. Fetch token IDs from blockchain (NFTs)
      const response = await Moralis.EvmApi.nft.getWalletNFTs({
        chain: CHAIN_ID,
        format: 'decimal',
        normalizeMetadata: false,
        tokenAddresses: [NFT_CONTRACT_ADDRESS],
        mediaItems: false,
        address: walletAddress,
      });

      const nftList = response.raw.result;

      if (!nftList || nftList.length === 0) {
        return [];
      }

      const tokenIds = nftList.map((nft: any) => (BigInt(nft.token_id)).toString());

      // 3. Fetch current horses matching tokenIds
      const horses = await tx.horse.findMany({
        where: {
          tokenId: { in: tokenIds },
        },
        select: {
          id: true,
          tokenId: true,
          ownerId: true,
        },
      });

      const mismatchedHorseIds = horses
        .filter(h => h.ownerId !== userId)
        .map(h => h.id);

      // 4. If any mismatched horses, fix ownership in one SQL update
      // plus unequip all items that horse had equipped
      if (mismatchedHorseIds.length > 0) {
        await tx.$executeRawUnsafe(
          `
        UPDATE "Horse"
        SET "ownerId" = $1
        WHERE "id" = ANY($2)
        `,
          userId,
          mismatchedHorseIds
        );

        await tx.$executeRawUnsafe(
          `
        UPDATE "Item"
        SET "horseId" = NULL
        WHERE "horseId" = ANY($1)
        `,
          mismatchedHorseIds
        );
      }

      // 5. Fetch full horse data for response (with correct ownership)
      const horseDetails = await tx.horse.findMany({
        where: {
          tokenId: { in: tokenIds },
        },
        include: { equipments: true },
        orderBy: { createdAt: 'desc' },
      });

      return horseDetails.map(horse => ({
        ...horse,
        isDeposit: true,
      }));
    });
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
        select: { id: true, phorse: true, medals: true, totalPhorseSpent: true, presalePhorse: true },
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
      const incPower = rollGrowth() * 2;
      const incSprint = rollGrowth() * 2;
      const incSpeed = rollGrowth() * 2;

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
      const maxLevelForRarity = levelLimits[rarity];
      if (maxLevelForRarity === undefined) {
        throw new BadRequestException(`Unknown level cap for rarity: ${rarity}`);
      }
      if (newLevel > maxLevelForRarity) {
        throw new BadRequestException(`Max level for ${rarity} horses is ${maxLevelForRarity}`);
      }
      const updatedPower = currentPower + incPower;
      const updatedSprint = currentSprint + incSprint;
      const updatedSpeed = currentSpeed + incSpeed;
      const updatedMaxEnergy = maxEnergy + 4;
      const updatedCurrentEnergy = currentEnergy + 4;

      // 7) Subtract the XP for oldLevel
      const remainingXp = currentXp - requiredXp;

      // 8) Determine if still upgradable for next level,
      //    but only if we haven’t already hit the rarity cap:
      let newUpgradable = false;
      if (maxLevelForRarity === undefined) {
        throw new BadRequestException(`Unknown level cap for rarity: ${rarity}`);
      }

      // Only consider “upgradable” if we’re still below the cap:
      if (newLevel < maxLevelForRarity) {
        const nextRequiredXp = xpProgression[newLevel];
        if (nextRequiredXp !== undefined && remainingXp >= nextRequiredXp) {
          newUpgradable = true;
        }
      }

      const newPresale = Math.max(user.presalePhorse - phorseCost, 0);

      // 9) Perform the combined updates in one operation
      //   → Update user balances and horse stats atomically
      const [updatedUser, updatedHorse] = await Promise.all([
        tx.user.update({
          where: { id: user.id },
          data: {
            phorse: user.phorse - phorseCost,
            totalPhorseSpent: user.totalPhorseSpent + phorseCost,
            presalePhorse: newPresale,
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
            currentPower: Number(Math.ceil(updatedPower)),
            currentSprint: Number(Math.ceil(updatedSprint)),
            currentSpeed: Number(Math.ceil(updatedSpeed)),
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
        select: { id: true, phorse: true, medals: true, totalPhorseEarned: true, lastRace: true },
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
      const adjRoll = roll + 1.5 * horse.level;

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

      const maxLevelForRarity = levelLimits[horse.rarity];
      if (maxLevelForRarity === undefined) {
        throw new BadRequestException(`Unknown level cap for rarity: ${horse.rarity}`);
      }

      const updatedExp = horse.exp + xpReward;
      const updatedPhorse = user.phorse + tokenReward;
      const updatedMedals = user.medals + medalReward;
      const updatedTotalPhorseEarned = user.totalPhorseEarned + tokenReward;

      // Determine “upgradable” only if we haven’t already hit the cap:
      let updatedUpgradable = false;
      if (horse.level < maxLevelForRarity) {
        // xpProgression[horse.level] is the XP needed to go from current level → next
        const nextXpReq = xpProgression[horse.level];
        if (nextXpReq !== undefined && updatedExp >= nextXpReq) {
          updatedUpgradable = true;
        }
      }

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
          data: { phorse: updatedPhorse, medals: updatedMedals, totalPhorseEarned: updatedTotalPhorseEarned, ...(user.lastRace ? {} : { lastRace: new Date() }) },
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

      await tx.raceHistory.create({
        data: {
          horseId: horse.id,
          phorseEarned: tokenReward,
          xpEarned: xpReward,
          position,                  // same `position` you already computed
        },
      });

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
   * startMultipleRace:
   *  - Runs race logic for multiple tokenIds in one transaction.
   */
  async startMultipleRace(
    ownerWallet: string,
    tokenIds: string[],
  ): Promise<Array<{
    tokenId: string;
    xpReward: number;
    tokenReward: number;
    medalReward: number;
    position: number;
    finalStatus: 'IDLE' | 'SLEEP' | 'BRUISED';
  }>> {
    return this.prisma.$transaction(async (tx) => {
      // 1) Load user once
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: {
          id: true,
          phorse: true,
          medals: true,
          totalPhorseEarned: true,
          lastRace: true,
        },
      });
      if (!user) throw new NotFoundException('User not found');

      if (user.phorse < tokenIds.length * 50) throw new BadRequestException('Not enough PHORSE to pay for race all');

      // 2) Load all horses + equipments
      const horses = await tx.horse.findMany({
        where: { tokenId: { in: tokenIds } },
        include: { equipments: true },
      });
      if (horses.length !== tokenIds.length) {
        throw new NotFoundException('One or more horses not found');
      }

      // 3) Per-horse computation
      type Result = {
        tokenId: string;
        xpReward: number;
        tokenReward: number;
        medalReward: number;
        position: number;
        finalStatus: 'IDLE' | 'SLEEP' | 'BRUISED';
        newEnergy: number;
        updatedExp: number;
        upgradable: boolean;
      };
      const results: Result[] = [];

      for (const horse of horses) {
        if (horse.ownerId !== user.id) {
          throw new ForbiddenException(`Not your horse ${horse.tokenId}`);
        }
        if (horse.status !== 'IDLE') {
          throw new BadRequestException(`Horse ${horse.tokenId} must be IDLE`);
        }

        // a) energy cost & modifiers
        const baseEnergy = globals['Energy Spent'] as number;
        const mods = horse.equipments
          .map(i => itemModifiers[i.name])
          .filter(Boolean)
          .reduce((acc, m) => ({
            positionBoost: acc.positionBoost * m.positionBoost,
            hurtRate:      acc.hurtRate      * m.hurtRate,
            xpMultiplier:  acc.xpMultiplier  * m.xpMultiplier,
            energySaved:   acc.energySaved   + m.energySaved,
          }), { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, energySaved: 0 });

        const energySpent = Math.max(1, baseEnergy - mods.energySaved);
        if (horse.currentEnergy < energySpent) {
          throw new BadRequestException(
            `Not enough energy on ${horse.tokenId}: need ${energySpent}, have ${horse.currentEnergy}`
          );
        }

        // b) determine position & rewards
        const totalStats  = horse.currentPower + horse.currentSprint + horse.currentSpeed;
        const baseMod     = totalStats / (globals['Base Denominator'] as number);
        const roll        = Math.min(100, Math.random() * 100 * mods.positionBoost);
        const adjRoll     = roll + 1.5 * horse.level;
        const winrates    = globals['Winrates'] as Record<string, number>;
        const thresholds  = Object.keys(winrates).map(parseFloat).sort((a, b) => a - b);

        let chosen = thresholds[0];
        for (const t of thresholds) {
          if (adjRoll >= t) chosen = t;
          else break;
        }
        const position     = winrates[chosen.toString()];
        const [xpBase, tokenBase] = (globals['Rewards'] as Record<string, readonly [number, number]>)[position.toString()];

        const baseXp      = Math.floor(xpBase * baseMod * (globals['Experience Multiplier'] as number));
        const xpReward    = Math.floor(baseXp * mods.xpMultiplier);
        const tokenReward = parseFloat((tokenBase * baseMod).toFixed(2));
        const medalReward = position <= 3 ? 1 : 0;

        // c) post-race status (fixed hurt logic)
        const newEnergy  = horse.currentEnergy - energySpent;
        const denom      = Math.log(totalStats) / Math.log(1.6);
        const hurtChance = Math.min(1, denom > 0 ? 1/denom : 0); // Math.min(1, denom > 0 ? 1 / denom : 0);
        const isHurt     = Math.random() * mods.hurtRate < hurtChance;

        let finalStatus: 'IDLE' | 'SLEEP' | 'BRUISED' = 'IDLE';
        if (isHurt)                   finalStatus = 'BRUISED';
        else if (newEnergy < baseEnergy) finalStatus = 'SLEEP';

        // d) xp & upgradable flag
        const updatedExp = horse.exp + xpReward;
        const cap        = levelLimits[horse.rarity];
        let upgradable   = false;
        if (cap !== undefined && horse.level < cap) {
          const nextXpReq = xpProgression[horse.level];
          if (nextXpReq !== undefined && updatedExp >= nextXpReq) {
            upgradable = true;
          }
        }

        results.push({
          tokenId:     horse.tokenId,
          xpReward,
          tokenReward,
          medalReward,
          position,
          finalStatus,
          newEnergy,
          updatedExp,
          upgradable,
        });
      }

      // 4) Aggregate user totals
      const totalToken = results.reduce((sum, r) => sum + r.tokenReward, 0);
      const totalMedal = results.reduce((sum, r) => sum + r.medalReward, 0);

      // 5) Prepare all item-uses
      const itemOps = horses.flatMap(h =>
        h.equipments
         .filter(i => itemModifiers[i.name])
         .map(i => {
           const newUses = (i.uses ?? 0) - 1;
           return newUses > 0
             ? tx.item.update({ where: { id: i.id }, data: { uses: newUses } })
             : tx.item.delete({ where: { id: i.id } });
         })
      );

      // 6) Commit all writes in parallel
      await Promise.all([
        tx.user.update({
          where: { id: user.id },
          data: {
            phorse:            user.phorse + totalToken - (tokenIds.length * 50),
            medals:            user.medals + totalMedal,
            totalPhorseEarned: user.totalPhorseEarned + totalToken,
            ...(user.lastRace ? {} : { lastRace: new Date() }),
          },
        }),
        Promise.all(results.map(r =>
          tx.horse.update({
            where: { tokenId: r.tokenId },
            data: {
              exp:           r.updatedExp,
              currentEnergy: r.newEnergy,
              status:        r.finalStatus,
              upgradable:    r.upgradable,
            },
          })
        )),
        Promise.all(itemOps),
        tx.raceHistory.createMany({
          data: results.map(r => ({
            horseId:      horses.find(h => h.tokenId === r.tokenId)!.id,
            phorseEarned: r.tokenReward,
            xpEarned:     r.xpReward,
            position:     r.position,
          })),
        }),
      ]);

      // 7) Return in input order
      return tokenIds.map(id => {
        const r = results.find(x => x.tokenId === id)!;
        return {
          tokenId:     r.tokenId,
          xpReward:    r.xpReward,
          tokenReward: r.tokenReward,
          medalReward: r.medalReward,
          position:    r.position,
          finalStatus: r.finalStatus,
        };
      });
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
        select: { id: true, phorse: true, totalPhorseSpent: true, presalePhorse: true },
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
      // cost = (level - 1) * 100 PHORSE
      const cost = (horse.level - 1) * globals["Recovery Cost"];
      if (user.phorse < cost) {
        throw new BadRequestException(
          `Not enough PHORSE to restore. Cost = ${cost}, you have ${user.phorse}`,
        );
      }

      // 5) Deduct cost and set new status
      const energySpent = globals['Energy Spent'] as number; // 12
      const newStatus =
        horse.currentEnergy >= energySpent ? 'IDLE' : 'SLEEP';

      const newPresale = Math.max(user.presalePhorse - cost, 0);

      // 6) Perform updates in transaction
      const [updatedUser, updatedHorse] = await Promise.all([
        tx.user.update({
          where: { id: user.id },
          data: { phorse: user.phorse - cost, totalPhorseSpent: user.totalPhorseSpent + cost, presalePhorse: newPresale },
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
        `Horse has no item named "${dto.name}" currently equipped!`,
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

  async getRaceHistoryByHorseId(horseId: string, userId: string) {
    const horse = await this.prisma.horse.findFirst({
      where: {
        tokenId: horseId,
        ownerId: userId,
      },
      include: {
        raceHistory: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!horse) {
      throw new NotFoundException('Horse not found or unauthorized');
    }

    return horse.raceHistory;
  }

}
