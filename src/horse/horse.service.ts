import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { globals } from '../data/globals';
import { items as allItems, itemModifiers, itemDrops, chestDrops, trophyDrops } from '../data/items';
import { xpProgression, levelLimits } from '../data/xp_progression';
import { lvlUpFee, lvlUpRarityMultiplier } from '../data/lvl_up_fee';
import { rarityBase } from '../data/rarity_base';
import { Status } from '@prisma/client';
import { EquipItemDto } from './dto/equip-item.dto';
import { UnequipItemDto } from './dto/unequip-item.dto';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import Moralis from 'moralis';
import { QuestService } from '../quest/quest.service';
import { PublicHorseDto } from './dto/public-horse.dto';

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS
const NFT_CONTRACT_ADDRESS_OFH = process.env.NFT_CONTRACT_ADDRESS_OFH
const CHAIN_ID = 2020;

export interface RewardsSuccess {
  xpReward: number;
  tokenReward: number;
  position: number;
}

// helpers
const softmax = (scores: number[]): number[] => {
  const m = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
};

const allowedMaxPosition = (level: number): number => {
  if (level < 5) return 10;
  if (level < 10) return 9;
  if (level < 15) return 8;
  if (level < 20) return 7;
  return 6;
};

// fair distribution using level, totalStats, baseDenominator, positionBoost
export function buildPositionDistribution({
  level,
  positionBoost = 1.0,
}: {
  level: number;
  positionBoost?: number;
}): number[] {
  // podium mass depends only on level (sigmoid), then scaled by item boost
  const Pmin = 0.15;
  const Pmax = 0.55;
  const center = 15;
  const scale = 6;
  const z = (level - center) / scale;
  let Ppodium = Pmin + (Pmax - Pmin) * (1 / (1 + Math.exp(-z)));

  Ppodium *= Math.max(0.0, positionBoost);        // allow any boost >= 0
  Ppodium = Math.max(0, Math.min(Ppodium, 0.80)); // safety ceiling

  // split 1–3
  const betaTop = 0.32;
  const podiumSplit = softmax([0, -betaTop, -2 * betaTop]);
  const P3 = Ppodium * podiumSplit[0];
  const P2 = Ppodium * podiumSplit[1];
  const P1 = Ppodium * podiumSplit[2];

  // split mids among allowed positions only
  const maxPos = allowedMaxPosition(level);       // <10:10, <15:9, <20:8, <25:7, else:6
  const midCount = Math.max(0, maxPos - 3);       // positions 4..maxPos
  const Prest = Math.max(0, 1 - Ppodium);

  let mids: number[] = [];
  if (midCount > 0) {
    const betaMid = 0.18 + 0.04 * ((level - 1) / 29);
    const midScores = Array.from({ length: midCount }, (_, i) => -i * betaMid);
    const midSplit = softmax(midScores);
    mids = midSplit.map(w => w * Prest);
  }

  // assemble P1..P10, zeroing disallowed
  const probs = Array(10).fill(0);
  probs[0] = P1; probs[1] = P2; probs[2] = P3;
  for (let i = 0; i < mids.length; i++) probs[3 + i] = mids[i];

  // normalize
  const s = probs.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < probs.length; i++) probs[i] = probs[i] / s;

  return probs;
}


// === sample position 1..10 from distribution
function samplePosition(dist: number[], rng: () => number = Math.random): number {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < dist.length; i++) {
    acc += dist[i];
    if (r <= acc) return i + 1;
  }
  return 6; // fallback
}

const PHORSE_POSITION_RANGES: Record<number, readonly [number, number]> = {
  1: [180, 100],
  2: [170, 90],
  3: [160, 80],
  4: [100, 70],
  5: [90, 60],
  6: [80, 50],
  7: [70, 40],
  8: [60, 30],
  9: [50, 0],
  10: [40, 0],
};

type Rarity = 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary' | 'Mythic';

function rollRewards(
  position: number,
  rewardsCfg: Record<string, readonly [number, number]>,
  opts?: {
    level?: number;
    levelCap?: number;
    rarity?: Rarity;
    wronAvailable?: number;
  }) {
  // XP unchanged (from table)
  const xpBase = rewardsCfg[position.toString()][0];

  // Clamp pos into [1..10]
  const pos = Math.min(10, Math.max(1, position));
  const t = (pos - 1) / 9; // 0 at P1, 1 at P10
  const lerp = (hi: number, lo: number, u: number) => hi + (lo - hi) * u;

  const wronProbBase = lerp(0.03, 0.002, t);   // P1≈3% → P10≈0.2%
  const wronMin = 0.1;
  const wronMax = 8;
  const wronJackpotProb = lerp(0.002, 0.0003, t); // P1≈0.2% → P10≈0.03%

  const hasWronLiquidity = (opts?.wronAvailable ?? 0) > 0;
  const shouldTryWRON = hasWronLiquidity && (Math.random() < wronProbBase);

  // ── PHORSE base range: now comes from the position table ────────────────────
  const [baseMax, baseMin] = PHORSE_POSITION_RANGES[pos] ?? [60, 30];
  let phorseMin = baseMin;
  let phorseMax = baseMax;

  // Baseline very-hard jackpot odds still scale with position
  let phorseJackpotProb = lerp(0.004, 0.0005, t); // 0.4% → 0.05%

  // ── Level widens PHORSE range (min & max) ───────────────────────────────────
  const level = Math.max(1, opts?.level ?? 1);
  const levelCap = Math.max(level, opts?.levelCap ?? 100);
  const n = Math.max(0, Math.min(1, level / levelCap));
  const nEase = Math.pow(n, 0.65); // gentle concave curve

  // Tunable: up to +60% on min and +120% on max at cap.
  const minLevelMul = 1 + 0.60 * nEase;
  const maxLevelMul = 1 + 1.20 * nEase;

  phorseMin *= minLevelMul;
  phorseMax *= maxLevelMul;
  if (phorseMax < phorseMin) phorseMax = phorseMin;

  // ── Rarity boosts PHORSE jackpot *only* ─────────────────────────────────────
  const rarityToJPMul: Record<Rarity, number> = {
    Common: 1.00,
    Uncommon: 1.10,
    Rare: 1.25,
    Epic: 1.50,
    Legendary: 1.80,
    Mythic: 2.20,
  };
  const rMul = rarityToJPMul[(opts?.rarity as Rarity) ?? 'Common'] ?? 1.0;
  phorseJackpotProb = Math.min(0.01, phorseJackpotProb * rMul); // hard cap @ 1%

  // ── Roller ──────────────────────────────────────────────────────────────────
  const rollWithJackpot = (min: number, max: number, jackpotProb: number) => {
    const jackpot = Math.random() < jackpotProb;
    if (jackpot) return { reward: (1.5 * max), jackpot };
    const reward = parseFloat((min + Math.random() * (max - min)).toFixed(2));
    return { reward, jackpot };
  };

  // ── Decide currency with WRON-availability fallback ─────────────────────────
  if (shouldTryWRON) {
    const { reward, jackpot } = rollWithJackpot(wronMin, wronMax, wronJackpotProb);
    const wronBase = reward;
    return { xpBase, phorseBase: 0, wronBase, jackpot, currency: 'WRON' as const };
  }

  // Fallback (or intended) PHORSE path
  const { reward, jackpot } = rollWithJackpot(phorseMin, phorseMax, phorseJackpotProb);
  const phorseBase = reward;
  return { xpBase, phorseBase, wronBase: 0, jackpot, currency: 'PHORSE' as const };
}



@Injectable()
export class HorseService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Inject(forwardRef(() => QuestService)) private readonly questService: QuestService,
  ) { }

  private static inFlight = new Map<string, Promise<string[]>>();
  private readonly NFT_TTL_SECONDS = 300; // 5 minutes

  private async initMoralis() {
    if (!Moralis.Core.isStarted) {
      await Moralis.start({ apiKey: MORALIS_API_KEY });
    }
  }

  private makeMoralisKey(wallet: string, contracts: string[]) {
    const w = wallet.toLowerCase();
    const c = [...contracts].map(a => a.toLowerCase()).sort().join(',');
    return `moralis:nfts:${CHAIN_ID}:${w}:${c}`;
  }

  /** Fetch tokenIds from cache or Moralis (cached for 5 minutes). */
  private async getWalletTokenIdsCached(
    walletAddress: string,
    contracts: string[],
  ): Promise<string[]> {
    const key = this.makeMoralisKey(walletAddress, contracts);

    // 1) Fast path: cache
    const cached = await this.cache.get<string[]>(key);
    if (cached) return cached;

    // 2) De-dupe concurrent calls (single flight)
    const running = (this.constructor as typeof HorseService).inFlight.get(key);
    if (running) return running;

    const p = (async () => {
      try {
        const resp = await Moralis.EvmApi.nft.getWalletNFTs({
          chain: CHAIN_ID,
          format: 'decimal',
          normalizeMetadata: false,
          tokenAddresses: contracts,
          mediaItems: false,
          address: walletAddress,
        });

        const list = (resp as any)?.raw?.result ?? [];
        const tokenIds = list.map((nft: any) => (BigInt(nft.token_id)).toString());

        // 3) Cache for TTL (note: ttl units are seconds for redis store; works for memory too)
        await this.cache.set(key, tokenIds, this.NFT_TTL_SECONDS);
        return tokenIds;
      } catch (e) {
        // Optional: stale-on-error — try returning stale value even if TTL lapsed
        const stale = await this.cache.get<string[]>(key);
        if (stale) return stale;
        throw e;
      } finally {
        (this.constructor as typeof HorseService).inFlight.delete(key);
      }
    })();

    (this.constructor as typeof HorseService).inFlight.set(key, p);
    return p;
  }

  async listBlockchainHorses(walletAddress: string) {
    await this.initMoralis();

    return await this.prisma.$transaction(async (tx) => {
      // 1) User
      const user = await tx.user.findUnique({
        where: { wallet: walletAddress.toLowerCase() },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('User not found');
      const userId = user.id;

      // 2) NFTs on-chain (horses) — via cache
      if (!NFT_CONTRACT_ADDRESS || !NFT_CONTRACT_ADDRESS_OFH) {
        throw new Error('NFT contract addresses are not configured');
      }
      const tokenIds = await this.getWalletTokenIdsCached(walletAddress, [NFT_CONTRACT_ADDRESS, NFT_CONTRACT_ADDRESS_OFH]);
      if (!tokenIds.length) return [];

      // 3) Horses in DB for those tokenIds
      const horses = await tx.horse.findMany({
        where: { tokenId: { in: tokenIds } },
        select: { id: true, tokenId: true, ownerId: true },
      });

      const mismatchedHorseIds = horses
        .filter(h => h.ownerId !== userId)
        .map(h => h.id);

      // 4) Fix ownership + ownedSince in ONE statement; only when owner differs
      if (mismatchedHorseIds.length > 0) {
        // Update ownerId and ownedSince=NOW() only if owner actually changes
        await tx.$executeRaw`
        UPDATE "Horse"
        SET "ownerId" = ${userId},
            "ownedSince" = NOW()
        WHERE "id" = ANY(${mismatchedHorseIds})
          AND "ownerId" <> ${userId}
      `;

        // Unequip items that were on those horses
        await tx.$executeRaw`
        UPDATE "Item"
        SET "horseId" = NULL
        WHERE "horseId" = ANY(${mismatchedHorseIds})
      `;
      }

      // 5) Return horses (with up-to-date ownership and ownedSince)
      const horseDetails = await tx.horse.findMany({
        where: { tokenId: { in: tokenIds } },
        include: {
          equipments: true,
          owner: { select: { careerfactor: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      return horseDetails.map(({ owner, ...horse }) => ({
        ...horse,
        isDeposit: true,
        horseCareerFactor: horse.careerfactor,
        ownerCareerFactor: owner?.careerfactor ?? 1,
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
    opts: { useTicket?: boolean } = {},
  ) {
    const useTicket = !!opts.useTicket;

    // ---------- READS & COMPUTATIONS OUTSIDE TX (unchanged from your snippet) ----------
    const user = await this.prisma.user.findUnique({
      where: { wallet: ownerWallet },
      select: {
        id: true,
        phorse: true,
        medals: true,
        totalPhorseSpent: true,
        burnScore: true,
        presalePhorse: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const horse = await this.prisma.horse.findUnique({
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
        equipments: true,
        usedLevelUpTicket: true,
        growthPotential: true,
      },
    });
    if (!horse) throw new NotFoundException('Horse not found');
    if (horse.ownerId !== user.id) throw new ForbiddenException('Not your horse');
    if (!useTicket && !horse.upgradable) {
      throw new BadRequestException('Horse is not currently upgradable');
    }
    if (useTicket && horse.usedLevelUpTicket) {
      throw new BadRequestException('This horse has already used a Level Up Ticket.');
    }

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
      { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, energySaved: 0 },
    );

    const baseEnergy = globals['Energy Spent'] as number;

    const requiredXp = xpProgression[horse.level];
    if (requiredXp === undefined) {
      throw new BadRequestException(`No XP requirement for level ${horse.level}`);
    }
    if (horse.exp < requiredXp) {
      throw new BadRequestException(
        `Not enough XP: need ${requiredXp}, have ${horse.exp}`,
      );
    }

    const rarityInfo = rarityBase[horse.rarity as keyof typeof rarityBase];
    if (!rarityInfo) throw new BadRequestException(`Invalid rarity: ${horse.rarity}`);
    let minG;
    let maxG;
    if (horse.growthPotential) {
      minG = rarityInfo['Growth Max'];
      maxG = horse.growthPotential;
    } else {
      minG = rarityInfo['Growth Min'];
      maxG = rarityInfo['Growth Max'];
    }
    const rollGrowth = () => Math.random() * (maxG - minG) + minG;

    const incPower = rollGrowth() * 1;
    const incSprint = rollGrowth() * 1;
    const incSpeed = rollGrowth() * 1;

    const newLevel = horse.level + 1;
    const maxLevelForRarity = levelLimits[horse.rarity];
    if (maxLevelForRarity === undefined) {
      throw new BadRequestException(`Unknown level cap for rarity: ${horse.rarity}`);
    }
    if (newLevel > maxLevelForRarity) {
      throw new BadRequestException(`Max level for ${horse.rarity} horses is ${maxLevelForRarity}`);
    }

    const rarityMult = lvlUpRarityMultiplier[horse.rarity as keyof typeof lvlUpRarityMultiplier];
    if (!rarityMult) throw new BadRequestException(`No rarity multiplier for rarity ${horse.rarity}`);

    const rawPhorse = lvlUpFee.phorse[horse.level];
    const rawMedals = lvlUpFee.medals[horse.level];
    if (rawPhorse === undefined || rawMedals === undefined) {
      throw new BadRequestException(`No fee defined for level ${horse.level}`);
    }

    const phorseCost = useTicket ? 0 : Math.ceil(rawPhorse * rarityMult.phorse);
    const medalCost = useTicket ? 0 : Math.ceil(rawMedals * rarityMult.medals);

    if (!useTicket && user.phorse < phorseCost) {
      throw new BadRequestException(
        `Not enough PHORSE: need ${phorseCost}, have ${user.phorse}`,
      );
    }
    if (!useTicket && user.medals < medalCost) {
      throw new BadRequestException(
        `Not enough medals: need ${medalCost}, have ${user.medals}`,
      );
    }

    const updatedPower = horse.currentPower + incPower;
    const updatedSprint = horse.currentSprint + incSprint;
    const updatedSpeed = horse.currentSpeed + incSpeed;
    const updatedMaxEnergy = horse.maxEnergy + 4;
    const updatedCurrentEnergy = horse.currentEnergy + 4;

    const remainingXp = horse.exp - requiredXp;

    let newUpgradable = false;
    if (newLevel < maxLevelForRarity) {
      const nextXpReq = xpProgression[newLevel];
      if (nextXpReq !== undefined && remainingXp >= nextXpReq) {
        newUpgradable = true;
      }
    }

    const newPresale = Math.max(user.presalePhorse - phorseCost, 0);

    // ---------- ATOMIC TX: use ticket (same delete pattern as startRace) and/or take fees + update horse ----------
    const result = await this.prisma.$transaction(async (tx) => {
      // If using ticket, fetch & consume ONE item row like in startRace (find → update/delete)
      if (useTicket) {
        const ticket = await tx.item.findFirst({
          where: {
            ownerId: user.id,
            name: 'Level Up Ticket',
          },
          select: {
            id: true,
            breakable: true,
            uses: true,
          },
        });

        if (!ticket) {
          throw new BadRequestException('No Level Up Ticket available.');
        }

        // Mirror startRace’s decrement/delete logic for breakables
        if (ticket.breakable) {
          const newUses = (ticket.uses ?? 0) - 1;
          if (newUses > 0) {
            await tx.item.update({
              where: { id: ticket.id },
              data: { uses: newUses },
            });
          } else {
            await tx.item.delete({ where: { id: ticket.id } });
          }
        } else {
          // Non-breakable consumable → delete on use
          await tx.item.delete({ where: { id: ticket.id } });
        }
      }

      // User update (fees only when not using ticket)
      const userUpdatePromise = useTicket
        ? tx.user.findUnique({
          where: { id: user.id },
          select: { phorse: true, medals: true },
        })
        : tx.user.update({
          where: { id: user.id },
          data: {
            phorse: { decrement: phorseCost },
            medals: { decrement: medalCost },
            totalPhorseSpent: { increment: phorseCost },
            burnScore: { increment: phorseCost },
            presalePhorse: newPresale,
          },
          select: { phorse: true, medals: true },
        });

      // Guarded horse update; if using ticket also ensure it wasn’t used before
      const horseWhere: any = {
        id: horse.id,
        exp: { gte: requiredXp },
        level: horse.level,
      };
      // ignore "upgradable" when using ticket
      if (!useTicket) {
        horseWhere.upgradable = true;
      } else {
        horseWhere.usedLevelUpTicket = false; // still enforce 1x lifetime ticket use
      }

      const [updatedUser, updHorse] = await Promise.all([
        userUpdatePromise,
        tx.horse.updateMany({
          where: horseWhere,
          data: {
            level: newLevel,
            currentPower: Number(Math.ceil(updatedPower)),
            currentSprint: Number(Math.ceil(updatedSprint)),
            currentSpeed: Number(Math.ceil(updatedSpeed)),
            maxEnergy: updatedMaxEnergy,
            currentEnergy: updatedCurrentEnergy,
            exp: remainingXp,
            upgradable: newUpgradable,
            status:
              horse.status === 'SLEEP' &&
                updatedCurrentEnergy > (baseEnergy - 1 - totalModifier.energySaved)
                ? 'IDLE'
                : horse.status,
            ...(useTicket ? { usedLevelUpTicket: true } : {}),
          },
        }),
      ]);

      if (updHorse.count === 0) {
        // Horse state changed / insufficient XP / ticket already used (when useTicket=true)
        throw new BadRequestException(
          'Level-up failed: horse state changed or insufficient XP/ticket.',
        );
      }

      return {
        userId: user.id,
        level: newLevel,
        currentPower: Number(updatedPower.toFixed(2)),
        currentSprint: Number(updatedSprint.toFixed(2)),
        currentSpeed: Number(updatedSpeed.toFixed(2)),
        currentEnergy: updatedCurrentEnergy,
        maxEnergy: updatedMaxEnergy,
        exp: remainingXp,
        upgradable: newUpgradable,
        userPhorse: updatedUser?.phorse,
        userMedals: updatedUser?.medals,
      };
    });

    // Quest progression: track level ups and PHORSE spent
    try {
      const { QuestType } = await import('../quest/quest.types');
      await this.questService.incrementQuestProgress(result.userId, QuestType.LEVEL_UP_HORSES, 1);
      if (phorseCost > 0) {
        await this.questService.incrementQuestProgress(result.userId, QuestType.SPEND_PHORSE, phorseCost);
      }
    } catch (err) {
      console.error('Failed to update quest progress for level up:', err);
    }

    const { userId, ...resultWithoutUserId } = result;
    return resultWithoutUserId;
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
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: {
          id: true,
          phorse: true,
          wron: true,
          medals: true,
          totalPhorseEarned: true,
          lastRace: true,
          shards: true,
          careerfactor: true,
        },
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

      const shardCostFloat = 100 * Number(user.careerfactor ?? 1) * Number(horse.careerfactor ?? 1);
      const shardCost = Math.ceil(shardCostFloat); // avoid fractional shards
      if ((user.shards ?? 0) < shardCost) {
        throw new BadRequestException(`Not enough SHARDS: need ${shardCost}, have ${user.shards ?? 0}`);
      }

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
          phorseMultiplier: acc.phorseMultiplier * mod.phorseMultiplier,
          energySaved: acc.energySaved + mod.energySaved,
        }),
        { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, phorseMultiplier: 1, energySaved: 0 }
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

      // build distribution
      const dist = buildPositionDistribution({
        level: horse.level,
        positionBoost: totalModifier.positionBoost, // keep this effect subtle (as capped above)
      });

      // draw a position
      const position = samplePosition(dist);

      const hasJinDaRat = horse.equipments?.some(it => it.name === 'JinDaRat');

      const rewardsCfg = globals['Rewards'] as Record<string, readonly [number, number]>;
      // rewards follow from position as you already do

      const bank = await tx.rewardBank.findUnique({
        where: { id: 'WRON' },
        select: { available: true },
      });
      const wronAvailable = Number(bank?.available ?? 0);

      const { xpBase, phorseBase, wronBase, jackpot } = rollRewards(
        position,
        rewardsCfg,
        {
          level: horse.level,
          levelCap: levelLimits[horse.rarity] ?? 100,
          rarity: horse.rarity as any, // 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary' | 'Mythic'
          wronAvailable
        });

      const baseXpReward = Math.floor(xpBase * baseXpMod * (globals['Experience Multiplier'] as number));
      const xpReward = Math.floor(baseXpReward * totalModifier.xpMultiplier);

      // PHORSE path (keeps your existing multipliers)
      const rawPhorse = parseFloat((Math.max(phorseBase * baseMod, phorseBase) * Number(totalModifier.phorseMultiplier)).toFixed(2));
      let tokenReward = (hasJinDaRat && position > 5) ? 0 : rawPhorse; // ← your existing "phorse" reward

      // Optional: capture WRON separately (small & capped; no multipliers applied here)
      const wronTemptative = parseFloat(Math.max((wronBase * (baseMod / 8)), wronBase).toFixed(2)); // keep as-is for now

      let wronReward = 0;
      if (wronTemptative > 0) {
        const { allocateWron } = await import('../utils/wron');  // or a top import
        const { granted } = await allocateWron(tx, wronTemptative);
        wronReward = granted;

        if (granted === 0 && tokenReward === 0) {
          const fallbackPhorse = Math.max(1, Math.min(rawPhorse, phorseBase));
          tokenReward = parseFloat(fallbackPhorse.toFixed(2));
        }
      }

      // console.log({ tokenReward, wronReward, jackpot })

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
      const updatedWron = user.wron + wronReward;
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
          data: { phorse: updatedPhorse, wron: updatedWron, medals: updatedMedals, totalPhorseEarned: updatedTotalPhorseEarned, shards: { decrement: shardCost }, ...(user.lastRace ? {} : { lastRace: new Date() }) },
          select: { phorse: true, medals: true },
        }),
        tx.horse.updateMany({
          where: {
            id: horse.id,
            status: 'IDLE',
            currentEnergy: { gte: energySpent },  // extra guard
          },
          data: {
            exp: { increment: xpReward },         // ← atomic delta
            currentEnergy: { decrement: energySpent },
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
          wronEarned: wronReward,
          xpEarned: xpReward,
          position,                  // same `position` you already computed
          shardSpent: shardCost,
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
        userId: user.id,
        xpReward,
        tokenReward,
        medalReward,
        wronReward,
        jackpot,
        position,
        finalStatus,
        droppedItems,
        droppedChests,
      };
    });

    // Quest progression: track race completion and wins
    try {
      const { QuestType } = await import('../quest/quest.types');
      await this.questService.incrementQuestProgress(result.userId, QuestType.RUN_RACES, 1);
      if (result.position === 1) {
        await this.questService.incrementQuestProgress(result.userId, QuestType.WIN_RACES, 1);
      }

      // Track PHORSE earned from race
      if (result.tokenReward > 0) {
        await this.questService.incrementQuestProgress(result.userId, QuestType.EARN_PHORSE, result.tokenReward);
      }
    } catch (err) {
      // Don't fail the race if quest update fails
      console.error('Failed to update quest progress for race:', err);
    }

    // Remove userId from response
    const { userId, ...resultWithoutUserId } = result;
    return resultWithoutUserId;
  }

  /**
   * startMultipleRace:
   *  - Runs race logic for multiple tokenIds in one transaction.
   *  - Batches writes for performance.
   *  - Now also tracks quest progress (RUN_RACES, WIN_RACES, EARN_PHORSE).
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
    const txResult = await this.prisma.$transaction(async tx => {
      // 1) Load user & check balance
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: {
          id: true,
          phorse: true,
          wron: true,
          medals: true,
          totalPhorseEarned: true,
          totalPhorseSpent: true,
          burnScore: true,
          lastRace: true,
          shards: true,
          careerfactor: true,
        },
      });
      if (!user) throw new NotFoundException('User not found');

      // NEW: check if user has a Stable
      const hasStable = await tx.stable.findFirst({
        where: { userId: user.id },
        select: { id: true },
      });

      // If the user has any Stable, PHORSE cost per race is 0
      const costPerRace = hasStable ? 0 : 50;
      const totalCost = costPerRace * tokenIds.length;

      if (totalCost > 0 && user.phorse < totalCost) {
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

      const perHorseShardCost: Record<string, number> = {};
      let totalShardCost = 0;
      for (const h of horses) {
        const c = Math.ceil(100 * Number(user.careerfactor ?? 1) * Number(h.careerfactor ?? 1));
        perHorseShardCost[h.tokenId] = c;
        totalShardCost += c;
      }

      /* const dec = await tx.user.updateMany({
        where: { id: user.id, shards: { gte: totalShardCost } },
        data: { shards: { decrement: totalShardCost } },
      });
      if (dec.count !== 1) {
        throw new BadRequestException(`Not enough SHARDS: need ${totalShardCost}`);
      } */

      // Prepare accumulators
      type RawResult = {
        tokenId: string;
        xpReward: number;
        tokenReward: number;
        wronReward: number;
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
            energySaved: acc.energySaved + m.energySaved,
            phorseMultiplier: acc.phorseMultiplier * m.phorseMultiplier
          }), { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, phorseMultiplier: 1, energySaved: 0 });

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

        // build distribution
        const dist = buildPositionDistribution({
          level: horse.level,
          positionBoost: mods.positionBoost, // keep this effect subtle (as capped above)
        });

        // draw a position
        const position = samplePosition(dist);

        const hasJinDaRat = horse.equipments?.some(it => it.name === 'JinDaRat');

        const bank = await tx.rewardBank.findUnique({
          where: { id: 'WRON' },
          select: { available: true },
        });
        const wronAvailable = Number(bank?.available ?? 0);

        const { xpBase, phorseBase, wronBase, jackpot } = rollRewards(
          position,
          rewardsCfg,
          {
            level: horse.level,
            levelCap: levelLimits[horse.rarity] ?? 100,
            rarity: horse.rarity as any, // 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary' | 'Mythic'
            wronAvailable
          }
        );
        const baseXp = Math.floor(xpBase * baseXpMod * xpMultGlobal);
        const xpReward = Math.floor(baseXp * mods.xpMultiplier);

        // PHORSE path (same multipliers)
        const rawPhorse = parseFloat((Math.max(phorseBase * baseMod, phorseBase) * Number(mods.phorseMultiplier)).toFixed(2));
        let tokenReward = (hasJinDaRat && position > 5) ? 0 : rawPhorse;

        // Optional: keep WRON separate for now
        const wronTemptative = parseFloat(Math.max((wronBase * (baseMod / 8)), wronBase).toFixed(2));

        let wronReward = 0;
        if (wronTemptative > 0) {
          const { allocateWron } = await import('../utils/wron');  // or a top import
          const { granted } = await allocateWron(tx, wronTemptative);
          wronReward = granted;

          if (granted === 0 && tokenReward === 0) {
            const fallbackPhorse = Math.max(1, Math.min(rawPhorse, phorseBase));
            tokenReward = parseFloat(fallbackPhorse.toFixed(2));
          }
        }

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
          wronReward,
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
      // Precompute per-horse energySpent so guards are correct
      const energySpentByToken: Record<string, number> = {};
      for (const h of horses) {
        const mods = h.equipments
          .map(i => itemModifiers[i.name])
          .filter(Boolean)
          .reduce((acc, m) => ({
            positionBoost: acc.positionBoost * (m.positionBoost ?? 1),
            hurtRate: acc.hurtRate * (m.hurtRate ?? 1),
            xpMultiplier: acc.xpMultiplier * (m.xpMultiplier ?? 1),
            energySaved: acc.energySaved + (m.energySaved ?? 0),
          }), { positionBoost: 1, hurtRate: 1, xpMultiplier: 1, energySaved: 0 });

        energySpentByToken[h.tokenId] = Math.max(1, baseEnergy - mods.energySaved);
      }

      const phorseDelta = rawResults.reduce((s, r) => s + r.tokenReward, 0) - totalCost;
      const wronDelta = rawResults.reduce((s, r) => s + r.wronReward, 0);
      const medalsDelta = rawResults.reduce((s, r) => s + r.medalReward, 0);
      const spentDelta = totalCost;
      const earnedDelta = rawResults.reduce((s, r) => s + r.tokenReward, 0);
      const burnDelta = totalCost;

      const userUpd = await tx.user.updateMany({
        where: { id: user.id, shards: { gte: totalShardCost } },
        data: {
          shards: { decrement: totalShardCost },
          phorse: { increment: phorseDelta },
          wron: { increment: wronDelta },
          medals: { increment: medalsDelta },
          totalPhorseSpent: { increment: spentDelta },
          totalPhorseEarned: { increment: earnedDelta },
          burnScore: { increment: burnDelta },
          ...(user.lastRace ? {} : { lastRace: new Date() }),
        },
      });
      if (userUpd.count !== 1) {
        throw new BadRequestException(`Not enough SHARDS: need ${totalShardCost}`);
      }

      await Promise.all([
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
            wronEarned: r.wronReward,
            xpEarned: r.xpReward,
            position: r.position,
            shardSpent: perHorseShardCost[r.tokenId],
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

      // 5) Build per-horse results
      const results = rawResults.map(r => ({
        tokenId: r.tokenId,
        xpReward: r.xpReward,
        tokenReward: r.tokenReward,
        wronReward: r.wronReward,
        medalReward: r.medalReward,
        position: r.position,
        finalStatus: r.finalStatus,
        droppedItems: droppedItemsMap.get(r.tokenId) || [],
        droppedChests: droppedChestsMap.get(r.tokenId) || []
      }));

      // NEW: aggregate quest-related info
      const runCount = results.length;
      const winCount = results.filter(r => r.position === 1).length;
      const totalPhorseEarned = results.reduce((sum, r) => sum + r.tokenReward, 0);

      return {
        userId: user.id,
        results,
        runCount,
        winCount,
        totalPhorseEarned,
      };
    });

    // --- NEW: Quest progression outside the transaction ---
    try {
      const { QuestType } = await import('../quest/quest.types');

      if (txResult.runCount > 0) {
        await this.questService.incrementQuestProgress(
          txResult.userId,
          QuestType.RUN_RACES,
          txResult.runCount,
        );
      }

      if (txResult.winCount > 0) {
        await this.questService.incrementQuestProgress(
          txResult.userId,
          QuestType.WIN_RACES,
          txResult.winCount,
        );
      }

      if (txResult.totalPhorseEarned > 0) {
        await this.questService.incrementQuestProgress(
          txResult.userId,
          QuestType.EARN_PHORSE,
          txResult.totalPhorseEarned,
        );
      }
    } catch (err) {
      console.error('Failed to update quest progress for multiple race:', err);
    }

    // Public API stays the same as before
    return txResult.results;
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
        select: { id: true, phorse: true, totalPhorseSpent: true, burnScore: true, presalePhorse: true },
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
          data: { phorse: user.phorse - cost, totalPhorseSpent: user.totalPhorseSpent + cost, burnScore: user.burnScore + cost, presalePhorse: newPresale },
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
        userId: user.id,
        costSpent: cost,
      };
    }).then(async (result) => {
      // Quest progression: track energy restoration and PHORSE spending
      try {
        const { QuestType } = await import('../quest/quest.types');
        await this.questService.incrementQuestProgress(result.userId, QuestType.RESTORE_ENERGY, 1);
        await this.questService.incrementQuestProgress(result.userId, QuestType.SPEND_PHORSE, result.costSpent);
      } catch (err) {
        console.error('Failed to update quest progress for restore:', err);
      }
      return { newStatus: result.newStatus, userPhorse: result.userPhorse };
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

      // 🔸 Special case: Baby Ronke Trophy empties energy immediately
      if (dto.name === 'Baby Ronke Trophy') {
        const statusAfter = (horse.status === 'IDLE' || horse.status === 'SLEEP')
          ? 'SLEEP'
          : horse.status; // keep other statuses (e.g., BREEDING) unchanged

        await tx.horse.update({
          where: { id: horse.id },
          data: { currentEnergy: 0, status: statusAfter },
        });

        return { success: true as const, userId };
      }

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
      if (horse.status === 'IDLE' || horse.status === 'SLEEP') {
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

      return { success: true as const, userId };
    }).then(async (result) => {
      // Quest progression: track item equipping
      try {
        const { QuestType } = await import('../quest/quest.types');
        await this.questService.incrementQuestProgress(result.userId, QuestType.EQUIP_ITEMS, 1);
      } catch (err) {
        console.error('Failed to update quest progress for equip item:', err);
      }
      return { success: true as const };
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
        const HOURS_MS = 24 * 60 * 60 * 1000;
        const now = Date.now();
        const lastUpdate = equipment.updatedAt?.getTime() ?? 0;
        if (now - lastUpdate < HOURS_MS) {
          const minsLeft = Math.ceil((HOURS_MS - (now - lastUpdate)) / 60000);
          throw new BadRequestException(
            `You can only unequip this item 24 hours after its last change. ` +
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
      if (horse.status === 'IDLE' || horse.status === 'SLEEP') {
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
        select: { id: true, phorse: true, totalPhorseSpent: true, burnScore: true, presalePhorse: true },
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
            burnScore: user.burnScore + COST,
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

  /**
   * Ascend a horse (one-time “legacy” promotion):
   *
   * Guards:
   * - Caller must exist and own the horse
   * - Horse level >= 15
   * - Horse.legacy must be FALSE (ascend only once)
   *
   * Effects:
   * 1) basePower/baseSprint/baseSpeed += ceil( rand[0.5..1.0] * currentLevel )
   * 2) currentPower/currentSprint/currentSpeed = new base values
   * 3) level = 1
   * 4) exp = 0
   * 5) legacy = TRUE
   * 6) growthPotential = (rarityInfo['Growth Max']) + rand[0..2)
   * 7) upgradable = FALSE
   * 8) careerfactor = 0
   * 9) CLEAR RaceHistory for this horse
   * 10) UNEQUIP ALL items from this horse (horseId = NULL)
   */
  async ascendHorse(
    ownerWallet: string,
    tokenId: string,
  ): Promise<{
    tokenId: string;
    level: number;
    exp: number;
    legacy: boolean;
    basePower: number;
    baseSprint: number;
    baseSpeed: number;
    currentPower: number;
    currentSprint: number;
    currentSpeed: number;
    growthPotential: number;
    clearedHistoryCount: number;
    unequippedItemsCount: number;
  }> {
    return this.prisma.$transaction(async (tx) => {
      // 1) Caller user
      const user = await tx.user.findUnique({
        where: { wallet: ownerWallet },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('User not found');

      // 2) Load horse (everything needed)
      const horse = await tx.horse.findUnique({
        where: { tokenId },
        select: {
          id: true,
          ownerId: true,
          level: true,
          exp: true,
          legacy: true,
          rarity: true,
          basePower: true,
          baseSprint: true,
          baseSpeed: true,
          usedLevelUpTicket: true
        },
      });
      if (!horse) throw new NotFoundException('Horse not found');
      if (horse.ownerId !== user.id) throw new ForbiddenException('Not your horse');

      // Guards
      if (horse.level < 15) {
        throw new BadRequestException('Horse must be at least level 15 to ascend');
      }
      if (horse.legacy) {
        throw new BadRequestException('This horse has already ascended (legacy = true)');
      }

      // 3) Rarity info for growthPotential
      const rarityInfo = rarityBase[horse.rarity as keyof typeof rarityBase];
      if (!rarityInfo) throw new BadRequestException(`Invalid rarity: ${horse.rarity}`);
      const maxG = rarityInfo['Growth Max'];

      // 4) Compute random base stat boosts
      const L = horse.level;
      const rand05to10 = () => 0.5 + Math.random() * 0.5; // [0.5, 1.0)
      const incPower = Math.ceil(rand05to10() * L);
      const incSprint = Math.ceil(rand05to10() * L);
      const incSpeed = Math.ceil(rand05to10() * L);

      const newBasePower = Math.ceil((horse.basePower ?? 0) + incPower);
      const newBaseSprint = Math.ceil((horse.baseSprint ?? 0) + incSprint);
      const newBaseSpeed = Math.ceil((horse.baseSpeed ?? 0) + incSpeed);

      // current = base after ascend
      const newCurrentPower = newBasePower;
      const newCurrentSprint = newBaseSprint;
      const newCurrentSpeed = newBaseSpeed;

      // growthPotential = maxG + rand[0..2)
      const growthPotential = Number((maxG + Math.random() * 2).toFixed(4));

      // 5) Guarded horse update (prevents double-ascend)
      const upd = await tx.horse.updateMany({
        where: {
          id: horse.id,
          ownerId: user.id,
          legacy: false,
          level: { gte: 15 },
        },
        data: {
          basePower: newBasePower,
          baseSprint: newBaseSprint,
          baseSpeed: newBaseSpeed,
          currentPower: newCurrentPower,
          currentSprint: newCurrentSprint,
          currentSpeed: newCurrentSpeed,
          level: 1,
          exp: 0,
          legacy: true,
          growthPotential,
          upgradable: false,
          careerfactor: 0, // reset career factor
          usedLevelUpTicket: false,
        },
      });

      if (upd.count !== 1) {
        throw new BadRequestException('Ascension failed: horse state changed; try again.');
      }

      // 6) Unequip all items from this horse (bypass any cooldowns on purpose)
      const unequipRes = await tx.item.updateMany({
        where: { horseId: horse.id },
        data: { horseId: null },
      });

      // 7) Clear the horse’s race history
      const delRes = await tx.raceHistory.deleteMany({
        where: { horseId: horse.id },
      });

      return {
        tokenId,
        level: 1,
        exp: 0,
        legacy: true,
        basePower: newBasePower,
        baseSprint: newBaseSprint,
        baseSpeed: newBaseSpeed,
        currentPower: newCurrentPower,
        currentSprint: newCurrentSprint,
        currentSpeed: newCurrentSpeed,
        growthPotential,
        clearedHistoryCount: delRes.count ?? 0,
        unequippedItemsCount: unequipRes.count ?? 0,
      };
    });
  }

  async getPublicHorseById(id: string): Promise<PublicHorseDto | null> {
    const horse = await this.prisma.horse.findUnique({
      where: { id },
      select: {
        id: true,
        tokenId: true,
        name: true,
        nickname: true,
        rarity: true,
        sex: true,
        status: true,
        level: true,
        exp: true,
        upgradable: true,
        basePower: true,
        currentPower: true,
        baseSprint: true,
        currentSprint: true,
        baseSpeed: true,
        currentSpeed: true,
        currentEnergy: true,
        maxEnergy: true,
        gen: true,
        currentBreeds: true,
        maxBreeds: true,
        legacy: true,
        growthPotential: true,
        traitSlotsUnlocked: true,
        careerfactor: true,
        mmr: true,
        equipments: {
          select: { name: true }, // only what we need for read-only display
        },
      },
    });

    if (!horse) return null;
    return horse;
  }
}
