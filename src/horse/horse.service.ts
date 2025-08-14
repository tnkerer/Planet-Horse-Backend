import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { globals } from '../data/globals';
import { items as allItems, itemModifiers, itemDrops, chestDrops, trophyDrops } from '../data/items';
import { xpProgression, levelLimits } from '../data/xp_progression';
import { lvlUpFee, lvlUpRarityMultiplier } from '../data/lvl_up_fee';
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
          status: true,
          equipments: true
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
        status,
        equipments
      } = horse;

      const equippedModifiers = equipments
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

      const baseEnergy = globals['Energy Spent'] as number;

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
      const rarityMult = lvlUpRarityMultiplier[rarity as keyof typeof lvlUpRarityMultiplier];
      if (!rarityMult) throw new BadRequestException(`No rarity multiplier for rarity ${rarity}`);

      const phorseCost = Math.ceil(lvlUpFee.phorse[oldLevel] * rarityMult.phorse);
      const medalCost = Math.ceil(lvlUpFee.medals[oldLevel] * rarityMult.medals);
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
            status: ((updatedCurrentEnergy > (baseEnergy - 1 - totalModifier.energySaved)) && status == 'SLEEP') ? 'IDLE' : status,
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

      const extraSpd = equippedModifiers.reduce((sum, mod) => sum + (mod.extraSpd || 0), 0);
      const extraSpt = equippedModifiers.reduce((sum, mod) => sum + (mod.extraSpt || 0), 0);
      const extraPwr = equippedModifiers.reduce((sum, mod) => sum + (mod.extraPwr || 0), 0);

      const totalStats = horse.currentPower + extraPwr + horse.currentSprint + extraSpt + horse.currentSpeed + extraSpd;
      const baseMod = totalStats / (globals['Base Denominator'] as number);
      const baseXpMod = totalStats / 12;

      const roll = Math.min(100, Math.random() * 100 * totalModifier.positionBoost);
      const adjRoll = roll + 1 * horse.level;

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

      const baseXpReward = Math.floor(xpBase * baseXpMod * (globals['Experience Multiplier'] as number));
      const xpReward = Math.floor(baseXpReward * totalModifier.xpMultiplier);
      const tokenReward = parseFloat((tokenBase * baseMod).toFixed(2));
      const medalReward = position === 1 ? 3 :
        position === 2 ? 2 :
          position === 3 ? 1 : 0;

      const newEnergy = horse.currentEnergy - energySpent;
      const denom = Math.log(totalStats) / Math.log(1.6);
      const hurtChance = Math.min(1, denom > 0 ? 1 / denom : 0);
      const isHurt = Math.random() * totalModifier.hurtRate < hurtChance;

      let finalStatus: 'IDLE' | 'SLEEP' | 'BRUISED' = 'IDLE';
      if (newEnergy < (baseEnergy - totalModifier.energySaved)) finalStatus = 'SLEEP';
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
        if (!item.breakable) return null;
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

      // ITEM DROP LOGIC
      const dropsBoost = horse.equipments
        .map(i => itemModifiers[i.name]?.dropsBoost ?? 1)
        .reduce((acc, m) => acc * m, 1);

      // ─── build cumulative drop tables ────────────────────────────────────────────
      const itemTable: Record<string, number> = {};


      // 1) Level-based item drops
      for (const [thr, drops] of Object.entries(itemDrops) as [string, Record<string, number>][]) {
        if (horse.level >= Number(thr)) {
          for (const [name, pct] of Object.entries(drops) as [string, number][]) {
            itemTable[name] = (itemTable[name] ?? 0) + pct;
          }
        }
      }

      // 2) Trophy-based item drops (NEW)
      const equippedTrophies = horse.equipments
        .map(it => it.name)
        .filter(name => (allItems as any)[name]?.trophy && (trophyDrops as any)[name]);

      for (const trophyName of equippedTrophies) {
        const extra = (trophyDrops as Record<string, Record<string, number>>)[trophyName];
        for (const [name, pct] of Object.entries(extra) as [string, number][]) {
          itemTable[name] = (itemTable[name] ?? 0) + pct; // additive with level table
        }
      }

      // 3) Level-based chest drops (unchanged)
      const chestTable: Record<number, number> = {};
      for (const [thr, drops] of Object.entries(chestDrops) as [string, Record<string, number>][]) {
        if (horse.level >= Number(thr)) {
          for (const [typeStr, pct] of Object.entries(drops)) {
            const t = Number(typeStr);
            chestTable[t] = (chestTable[t] ?? 0) + pct;
          }
        }
      }

      // ─── perform boosted rolls & persist ──────────────────────────────────────────
      const droppedItems: string[] = [];
      for (const [name, pct] of Object.entries(itemTable)) {
        if (Math.random() * 100 < pct * dropsBoost) {
          droppedItems.push(name);
          const def = allItems[name];
          await tx.item.create({
            data: {
              ownerId: user.id,
              name,
              value: 1,
              breakable: def.breakable,
              uses: def.breakable ? def.uses : null,
            },
          });
        }
      }

      const droppedChests: number[] = [];
      for (const [chType, pct] of Object.entries(chestTable).map(([k, v]) => [Number(k), v] as [number, number])) {
        if (Math.random() * 100 < pct * dropsBoost) {
          droppedChests.push(chType);
          await tx.chest.upsert({
            where: { ownerId_chestType: { ownerId: user.id, chestType: chType } },
            create: { ownerId: user.id, chestType: chType, quantity: 1 },
            update: { quantity: { increment: 1 } },
          });
        }
      }

      // ─── return everything ──────────────────────────────────────────────────────
      return {
        xpReward,
        tokenReward,
        medalReward,
        position,
        finalStatus,
        droppedItems,
        droppedChests,
      };
    });
  }

  /**
   * startMultipleRace:
   *  - Runs race logic for multiple tokenIds in one transaction.
   *  - Batches writes for performance.
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
    droppedItems: string[];
    droppedChests: number[];
  }>> {
    return this.prisma.$transaction(async tx => {
      // 1) Load user & check balance
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: {
          id: true,
          phorse: true,
          medals: true,
          totalPhorseEarned: true,
          totalPhorseSpent: true,
          lastRace: true,
        },
      });
      if (!user) throw new NotFoundException('User not found');
      const costPerRace = 50;
      const totalCost = costPerRace * tokenIds.length;
      if (user.phorse < totalCost) {
        throw new BadRequestException('Not enough PHORSE to pay for all races');
      }

      // 2) Load horses & equipments
      const horses = await tx.horse.findMany({
        where: { tokenId: { in: tokenIds } },
        include: { equipments: true },
      });
      if (horses.length !== tokenIds.length) {
        throw new NotFoundException('One or more horses not found');
      }

      // Prepare accumulators
      type RawResult = {
        tokenId: string;
        xpReward: number;
        tokenReward: number;
        medalReward: number;
        position: number;
        finalStatus: 'IDLE' | 'SLEEP' | 'BRUISED';
        updatedExp: number;
        newEnergy: number;
        upgradable: boolean;
      };
      const rawResults: RawResult[] = [];
      const itemInserts: Array<{
        ownerId: string;
        name: string;
        value: number;
        breakable: boolean;
        uses: number | null;
      }> = [];
      const chestCounts = new Map<number, number>();
      const droppedItemsMap = new Map<string, string[]>();
      const droppedChestsMap = new Map<string, number[]>();

      // Common globals
      const baseEnergy = globals['Energy Spent'] as number;
      const winrates = globals['Winrates'] as Record<string, number>;
      const winThresholds = Object.keys(winrates).map(parseFloat).sort((a, b) => a - b);
      const rewardsCfg = globals['Rewards'];
      const xpMultGlobal = globals['Experience Multiplier'] as number;

      // 3) Per-horse logic
      for (const horse of horses) {
        if (horse.ownerId !== user.id) {
          throw new ForbiddenException(`Not your horse ${horse.tokenId}`);
        }
        if (horse.status !== 'IDLE') {
          throw new BadRequestException(`Horse ${horse.tokenId} must be IDLE`);
        }

        // a) compute modifiers & energy
        const mods = horse.equipments
          .map(i => itemModifiers[i.name])
          .filter(Boolean)
          .reduce((acc, m) => (<any>{
            positionBoost: acc.positionBoost * m.positionBoost,
            hurtRate: acc.hurtRate * m.hurtRate,
            xpMultiplier: acc.xpMultiplier * m.xpMultiplier,
            energySaved: acc.energySaved + m.energySaved
          }), { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, energySaved: 0 });

        const energySpent = Math.max(1, baseEnergy - mods.energySaved);
        if (horse.currentEnergy < energySpent) {
          throw new BadRequestException(`Not enough energy on ${horse.tokenId}`);
        }

        // b) determine position & rewards
        const extraSpd = horse.equipments.reduce((s, i) => s + (itemModifiers[i.name]?.extraSpd || 0), 0);
        const extraSpt = horse.equipments.reduce((s, i) => s + (itemModifiers[i.name]?.extraSpt || 0), 0);
        const extraPwr = horse.equipments.reduce((s, i) => s + (itemModifiers[i.name]?.extraPwr || 0), 0);
        const totalStats = horse.currentPower + extraPwr
          + horse.currentSprint + extraSpt
          + horse.currentSpeed + extraSpd;
        const baseMod = totalStats / (globals['Base Denominator'] as number);
        const baseXpMod = totalStats / 12;

        let roll = Math.random() * 100 * mods.positionBoost;
        const adjRoll = roll + 1 * horse.level;
        let chosen = winThresholds[0];
        for (const t of winThresholds) {
          if (adjRoll >= t) chosen = t; else break;
        }
        const position = winrates[chosen.toString()];
        const [xpBase, tokBase] = rewardsCfg[position.toString()];
        const baseXp = Math.floor(xpBase * baseXpMod * xpMultGlobal);
        const xpReward = Math.floor(baseXp * mods.xpMultiplier);
        const tokenReward = parseFloat((tokBase * baseMod).toFixed(2));
        const medalReward = position === 1 ? 3 :
          position === 2 ? 2 :
            position === 3 ? 1 : 0;

        // c) post-race status
        const newEnergy = horse.currentEnergy - energySpent;
        const denom = Math.log(totalStats) / Math.log(1.6);
        const hurtChance = Math.min(1, denom > 0 ? 1 / denom : 0);
        const isHurt = Math.random() * mods.hurtRate < hurtChance;
        let finalStatus: 'IDLE' | 'SLEEP' | 'BRUISED' = 'IDLE';
        if (isHurt) finalStatus = 'BRUISED';
        else if (newEnergy < energySpent) finalStatus = 'SLEEP';

        // d) xp & upgradable
        const updatedExp = horse.exp + xpReward;
        let upgradable = false;
        const cap = levelLimits[horse.rarity];
        if (cap !== undefined && horse.level < cap) {
          const nextReq = xpProgression[horse.level];
          if (nextReq !== undefined && updatedExp >= nextReq) upgradable = true;
        }

        rawResults.push({
          tokenId: horse.tokenId,
          xpReward,
          tokenReward,
          medalReward,
          position,
          finalStatus,
          updatedExp,
          newEnergy,
          upgradable,
        });

        // ─── drop logic ─────────────────────────────────────────
        const horseItemDrops: string[] = [];
        const horseChestDrops: number[] = [];

        // compute combined dropsBoost
        const dropsBoost = horse.equipments
          .map(i => itemModifiers[i.name]?.dropsBoost ?? 1)
          .reduce((a, b) => a * b, 1);

        // build cumulative tables
        const itemTable: Record<string, number> = {};

        // 1) Level-based item drops
        for (const [thr, drops] of Object.entries(itemDrops) as [string, Record<string, number>][]) {
          if (horse.level >= Number(thr)) {
            for (const [n, pct] of Object.entries(drops) as [string, number][]) {
              itemTable[n] = (itemTable[n] ?? 0) + pct;
            }
          }
        }

        // 2) Trophy-based item drops (NEW)
        const equippedTrophies = horse.equipments
          .map(it => it.name)
          .filter(name => (allItems as any)[name]?.trophy && (trophyDrops as any)[name]);

        for (const trophyName of equippedTrophies) {
          const extra = (trophyDrops as Record<string, Record<string, number>>)[trophyName];
          for (const [n, pct] of Object.entries(extra) as [string, number][]) {
            itemTable[n] = (itemTable[n] ?? 0) + pct;
          }
        }

        // 3) Level-based chest drops
        const chestTable: Record<number, number> = {};
        for (const [thr, drops] of Object.entries(chestDrops) as [string, Record<string, number>][]) {
          if (horse.level >= Number(thr)) {
            for (const [ts, pct] of Object.entries(drops)) {
              const t = Number(ts);
              chestTable[t] = (chestTable[t] ?? 0) + pct;
            }
          }
        }

        // roll & queue
        for (const [name, pct] of Object.entries(itemTable)) {
          if (Math.random() * 100 < pct * dropsBoost) {
            horseItemDrops.push(name);
            const def = allItems[name];
            itemInserts.push({
              ownerId: user.id,
              name,
              value: 1,
              breakable: def.breakable,
              uses: def.breakable ? def.uses : null,
            });
          }
        }
        for (const [t, pct] of Object.entries(chestTable).map(([k, v]) => [Number(k), v] as [number, number])) {
          if (Math.random() * 100 < pct * dropsBoost) {
            horseChestDrops.push(t);
            chestCounts.set(t, (chestCounts.get(t) ?? 0) + 1);
          }
        }

        droppedItemsMap.set(horse.tokenId, horseItemDrops);
        droppedChestsMap.set(horse.tokenId, horseChestDrops);
      }

      const itemUsageOps = horses.flatMap(h =>
        h.equipments
          .filter(i => i.breakable)            // ← use the item's own breakable flag
          .map(i => {
            const newUses = (i.uses ?? 0) - 1;
            return newUses > 0
              ? tx.item.update({ where: { id: i.id }, data: { uses: newUses } })
              : tx.item.delete({ where: { id: i.id } });
          })
      );

      // 4) Batch all writes
      await Promise.all([
        // user
        tx.user.update({
          where: { id: user.id },
          data: {
            phorse: user.phorse + rawResults.reduce((s, r) => s + r.tokenReward, 0) - totalCost,
            totalPhorseSpent: user.totalPhorseSpent + totalCost,
            medals: user.medals + rawResults.reduce((s, r) => s + r.medalReward, 0),
            totalPhorseEarned: user.totalPhorseEarned + rawResults.reduce((s, r) => s + r.tokenReward, 0),
            ...(user.lastRace ? {} : { lastRace: new Date() })
          }
        }),
        // horses
        Promise.all(itemUsageOps),
        Promise.all(rawResults.map(r =>
          tx.horse.update({
            where: { tokenId: r.tokenId },
            data: {
              exp: r.updatedExp,
              currentEnergy: r.newEnergy,
              status: r.finalStatus,
              upgradable: r.upgradable,
            }
          })
        )),
        // history
        tx.raceHistory.createMany({
          data: rawResults.map(r => ({
            horseId: horses.find(h => h.tokenId === r.tokenId)!.id,
            phorseEarned: r.tokenReward,
            xpEarned: r.xpReward,
            position: r.position,
          })),
        }),
        // item drops
        itemInserts.length
          ? tx.item.createMany({ data: itemInserts })
          : Promise.resolve(),
        // chest drops
        Promise.all(Array.from(chestCounts.entries()).map(([chType, count]) =>
          tx.chest.upsert({
            where: { ownerId_chestType: { ownerId: user.id, chestType: chType } },
            create: { ownerId: user.id, chestType: chType, quantity: count },
            update: { quantity: { increment: count } }
          })
        )),
      ]);

      // 5) Return per-horse enriched results
      return rawResults.map(r => ({
        tokenId: r.tokenId,
        xpReward: r.xpReward,
        tokenReward: r.tokenReward,
        medalReward: r.medalReward,
        position: r.position,
        finalStatus: r.finalStatus,
        droppedItems: droppedItemsMap.get(r.tokenId) || [],
        droppedChests: droppedChestsMap.get(r.tokenId) || []
      }));
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
          rarity: true,
          equipments: true
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
      // const cost = (horse.level - 1) * globals["Recovery Cost"];
      const baseModifier = globals["Rarity Modifier"][horse.rarity] * (260 / (globals["Base Denominator"]));
      const cost = baseModifier * horse.level;

      if (user.phorse < cost) {
        throw new BadRequestException(
          `Not enough PHORSE to restore. Cost = ${cost}, you have ${user.phorse}`,
        );
      }

      // 5) Deduct cost and set new status
      const baseEnergy = globals['Energy Spent'] as number; // 12

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

      const energySpent = baseEnergy - totalModifier.energySaved;

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
    foodUsed: number; // NEW
  }> {
    return await this.prisma.$transaction(async (tx) => {
      // 1) Fetch user
      const callerUser = await tx.user.findUnique({
        where: { wallet: callerWallet },
        select: { id: true },
      });
      if (!callerUser) {
        throw new NotFoundException('Authenticated user not found in database');
      }

      const callerUserId = callerUser.id;

      // 2) Ensure item exists & is consumable
      const itemDef = (allItems as Record<string, any>)[itemName];
      if (!itemDef) throw new BadRequestException(`Item "${itemName}" does not exist`);
      if (itemDef.consumable !== true)
        throw new BadRequestException(`Item "${itemName}" is not consumable`);

      const property: Record<string, number> = itemDef.property ?? {};
      if (Object.keys(property).length === 0) {
        throw new BadRequestException(`Consumable "${itemName}" has no valid "property"`);
      }

      // 3) Find the horse
      const horse = await tx.horse.findUnique({
        where: { tokenId },
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
          equipments: true,
          foodUsed: true, // SELECT foodUsed
        },
      });
      if (!horse) throw new NotFoundException(`Horse ${tokenId} not found`);
      if (horse.ownerId !== callerUserId)
        throw new BadRequestException(`You do not own horse #${tokenId}`);

      // 4) Limit food items (currentEnergy)
      if (property.currentEnergy !== undefined && horse.foodUsed >= 3) {
        throw new BadRequestException(
          `You have reached the limit of 3 food items until next recovery.`
        );
      }

      // 5) Find one instance of the item
      const oneItem = await tx.item.findFirst({
        where: { ownerId: callerUserId, name: itemName },
        select: { id: true },
      });
      if (!oneItem)
        throw new NotFoundException(`You do not own any "${itemName}" consumables`);

      // 6) Apply updates to horse stats
      const updateData: Record<string, any> = {};
      const updatedFields: Record<string, number> = {};

      for (const [fieldName, incValue] of Object.entries(property)) {
        if (!(fieldName in horse)) {
          throw new BadRequestException(`Horse has no field "${fieldName}"`);
        }

        const oldValue = (horse as any)[fieldName] as number;
        if (typeof oldValue !== 'number') {
          throw new BadRequestException(`Horse field "${fieldName}" is not numeric`);
        }

        const baseEnergy = globals['Energy Spent'] as number;
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

        const energySpent = baseEnergy - totalModifier.energySaved;

        if (fieldName === 'currentEnergy') {
          let newEnergy = oldValue + incValue;
          if (newEnergy > horse.maxEnergy) newEnergy = horse.maxEnergy;
          if (newEnergy >= energySpent && horse.status === 'SLEEP') {
            updateData.status = Status.IDLE;
          }
          updateData.currentEnergy = newEnergy;
          updatedFields.currentEnergy = newEnergy;

          // Increment foodUsed only when currentEnergy item is used
          updateData.foodUsed = horse.foodUsed + 1;
        } else {
          const newValue = oldValue + incValue;
          updateData[fieldName] = newValue;
          updatedFields[fieldName] = newValue;
        }
      }

      // 7) Update horse
      const updatedHorse = await tx.horse.update({
        where: { tokenId },
        data: updateData,
        select: {
          tokenId: true,
          currentEnergy: true,
          maxEnergy: true,
          currentPower: true,
          currentSprint: true,
          currentSpeed: true,
          foodUsed: true, // RETURN foodUsed
        },
      });

      // 8) Delete used item
      await tx.item.delete({ where: { id: oneItem.id } });

      // 9) Count leftover
      const leftoverCount = await tx.item.count({
        where: { ownerId: callerUserId, name: itemName },
      });

      return {
        horseTokenId: tokenId,
        updatedFields,
        remainingQuantityOfThatItem: leftoverCount,
        foodUsed: updatedHorse.foodUsed, // NEW
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
    return this.prisma.$transaction(async (tx) => {
      // (1) Find user by wallet
      const userId = await this.findUserIdByWallet(ownerWallet);
      if (!userId) {
        throw new ForbiddenException('Invalid user wallet.');
      }

      // (2) Lock the horse and check ownership
      const horse = await tx.horse.findUnique({
        where: { tokenId },
        select: {
          id: true,
          ownerId: true,
          level: true,
          currentEnergy: true,
          status: true,
          equipments: {
            select: { id: true, name: true },
          },
        },
      });

      if (!horse) {
        throw new NotFoundException(`Horse ${tokenId} not found.`);
      }
      if (horse.ownerId !== userId) {
        throw new ForbiddenException(`You do not own horse ${tokenId}.`);
      }

      // (3) Validate slot rules (trophies vs non-trophies)
      const isTrophy = allItems[dto.name]?.trophy === true;
      const equippedItems = horse.equipments;

      const trophiesEquipped = equippedItems.filter(
        (e) => allItems[e.name]?.trophy,
      ).length;
      const nonTrophiesEquipped = equippedItems.length - trophiesEquipped;

      if (isTrophy) {
        if (trophiesEquipped >= 1) {
          throw new BadRequestException(
            `Only one trophy can be equipped at a time.`,
          );
        }
      } else {
        let maxSlots = 0;
        if (horse.level >= 15) maxSlots = 3;
        else if (horse.level >= 7) maxSlots = 2;
        else if (horse.level >= 2) maxSlots = 1;

        if (nonTrophiesEquipped >= maxSlots) {
          throw new BadRequestException(
            `Horse level ${horse.level} allows only ${maxSlots} non trophy item(s).`,
          );
        }
      }

      // (4) Find a matching un-equipped item
      const matchingItem = await tx.item.findFirst({
        where: {
          ownerId: userId,
          name: dto.name,
          uses: dto.usesLeft,
          equipedBy: null,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!matchingItem) {
        throw new NotFoundException(
          `No available item "${dto.name}" with ${dto.usesLeft} uses found.`,
        );
      }

      // (5) Attach item to horse and update energy/status atomically
      await tx.item.update({
        where: { id: matchingItem.id },
        data: { horseId: horse.id },
      });

      // Fetch updated equipment (including this newly equipped item)
      const updatedEquipments = [...equippedItems, { name: dto.name }];

      const baseEnergy = globals['Energy Spent'] as number;

      const totalModifier = updatedEquipments
        .map((e) => itemModifiers[e.name])
        .filter(Boolean)
        .reduce(
          (acc, mod) => ({
            positionBoost: acc.positionBoost * mod.positionBoost,
            hurtRate: acc.hurtRate * mod.hurtRate,
            xpMultiplier: acc.xpMultiplier * mod.xpMultiplier,
            energySaved: acc.energySaved + mod.energySaved,
          }),
          { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, energySaved: 0 },
        );

      const energySpent = Math.max(1, baseEnergy - totalModifier.energySaved);

      let newStatus;
      if (horse.status === 'IDLE') {
        newStatus = horse.currentEnergy >= energySpent ? 'IDLE' : 'SLEEP';
      } else {
        newStatus = horse.status
      }

      // Update horse status if it changed
      if (horse.status !== newStatus) {
        await tx.horse.update({
          where: { id: horse.id },
          data: { status: newStatus },
        });
      }

      return { success: true };
    });
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
    return this.prisma.$transaction(async (tx) => {
      // (1) Validate user from wallet
      const userId = await this.findUserIdByWallet(ownerWallet);
      if (!userId) {
        throw new ForbiddenException('Invalid user wallet.');
      }

      // (2) Lock the horse record to avoid race conditions (atomicity)
      const horse = await tx.horse.findUnique({
        where: { tokenId },
        select: {
          id: true,
          ownerId: true,
          currentEnergy: true,
          status: true,
          equipments: {
            where: { name: dto.name, horseId: { not: null } },
            select: { id: true, updatedAt: true, name: true, breakable: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      });

      if (!horse) {
        throw new NotFoundException(`Horse ${tokenId} not found.`);
      }
      if (horse.ownerId !== userId) {
        throw new ForbiddenException(`You do not own horse ${tokenId}.`);
      }

      // (3) Validate equipment exists
      const equipment = horse.equipments[0];
      if (!equipment) {
        throw new BadRequestException(
          `Horse has no item named "${dto.name}" currently equipped.`,
        );
      }

      // (4) Check unequip cooldown for non-breakable items (trophies)
      if (!equipment.breakable) {
        const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
        const now = Date.now();
        const lastUpdate = equipment.updatedAt?.getTime() ?? 0;
        if (now - lastUpdate < SIX_HOURS_MS) {
          const minsLeft = Math.ceil((SIX_HOURS_MS - (now - lastUpdate)) / 60000);
          throw new BadRequestException(
            `You can only unequip this item 6 hours after its last change. ` +
            `Please wait another ${minsLeft} minute(s).`,
          );
        }
      }

      // (5) Detach the item (set horseId = null)
      await tx.item.update({
        where: { id: equipment.id },
        data: { horseId: null },
      });

      // (6) Recalculate horse status based on remaining equipment modifiers
      // Fetch remaining equipments after unequip for accurate calculation
      const remainingEquipments = await tx.item.findMany({
        where: { horseId: horse.id },
        select: { name: true },
      });

      const baseEnergy = globals['Energy Spent'] as number;
      const totalModifier = remainingEquipments
        .map((e) => itemModifiers[e.name])
        .filter(Boolean)
        .reduce(
          (acc, mod) => ({
            positionBoost: acc.positionBoost * mod.positionBoost,
            hurtRate: acc.hurtRate * mod.hurtRate,
            xpMultiplier: acc.xpMultiplier * mod.xpMultiplier,
            energySaved: acc.energySaved + mod.energySaved,
          }),
          { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, energySaved: 0 },
        );

      const energySpent = Math.max(1, baseEnergy - totalModifier.energySaved);

      let newStatus;
      if (horse.status === 'IDLE') {
        newStatus = horse.currentEnergy >= energySpent ? 'IDLE' : 'SLEEP';
      } else {
        newStatus = horse.status
      }

      // Only update status if it changes
      if (horse.status !== newStatus) {
        await tx.horse.update({
          where: { id: horse.id },
          data: { status: newStatus },
        });
      }

      return { success: true };
    });
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
          take: 50, // Limit to the last 50 entries
        },
      },
    });

    if (!horse) {
      throw new NotFoundException('Horse not found or unauthorized');
    }

    return horse.raceHistory;
  }


  async changeNickname(
    ownerWallet: string,
    tokenId: string,
    nickname: string,
  ): Promise<{ newNickname: string | null; userPhorse: number }> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Basic validation on nickname
      nickname = nickname.trim();
      if (nickname.length < 1 || nickname.length > 30) {
        throw new BadRequestException('Nickname must be 1–30 characters long.');
      }

      // 2. Find user by wallet
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: { id: true, phorse: true, totalPhorseSpent: true, presalePhorse: true },
      });
      if (!user) throw new NotFoundException('User not found');

      const userId = user.id;

      // 3. Fetch horse and validate ownership
      const horse = await tx.horse.findUnique({
        where: { tokenId },
        select: {
          id: true,
          ownerId: true,
          nickname: true,
        },
      });

      if (!horse) throw new NotFoundException('Horse not found');
      if (horse.ownerId !== userId) throw new ForbiddenException('You do not own this horse');

      // Check if another horse already has this nickname (case insensitive)
      const existing = await tx.horse.findFirst({
        where: {
          nickname: {
            equals: nickname,
            mode: 'insensitive', // case-insensitive match
          },
          NOT: { id: horse.id },
        },
      });

      if (existing) {
        throw new BadRequestException(`Nickname "${nickname}" is already taken`);
      }

      // 4. Check if the nickname is already the same
      if (horse.nickname === nickname) {
        throw new BadRequestException('Nickname is already set to this value');
      }

      // 5. Check phorse balance
      const COST = 500;
      if (user.phorse < COST) {
        throw new BadRequestException(`Not enough PHORSE: need ${COST}, have ${user.phorse}`);
      }

      // 6. Apply update atomically
      const [updatedUser, updatedHorse] = await Promise.all([
        tx.user.update({
          where: { id: userId },
          data: {
            phorse: user.phorse - COST,
            totalPhorseSpent: user.totalPhorseSpent + COST,
            presalePhorse: Math.max(user.presalePhorse - COST, 0),
          },
          select: { phorse: true },
        }),
        tx.horse.update({
          where: { id: horse.id },
          data: { nickname },
          select: { nickname: true },
        }),
      ]);

      return {
        newNickname: updatedHorse.nickname,
        userPhorse: updatedUser.phorse,
      };
    });
  }


}
