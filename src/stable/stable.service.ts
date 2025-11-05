import { BadRequestException, Injectable, NotFoundException, Inject, ForbiddenException, forwardRef } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { STABLE_LEVELS, STABLE_UPGRADE_HOURS, type StableLevel } from 'src/data/stables';
import type { Cache } from 'cache-manager';
import Moralis from 'moralis';
import { QuestService } from 'src/quest/quest.service';

type SalePhase = 'GTD' | 'FCFS';

// Sale windows (UTC)
const GTD_START_EPOCH = 1758546000;  // 2025-09-22 13:00:00 UTC
const FCFS_START_EPOCH = 1758549600; // 2025-09-22 14:00:00 UTC

const STABLE_CONTRACT_ADDRESS = '0x0d9e46be52fde86a0f1070725179b7a0d59229f7';
const CHAIN_ID = 2020;

@Injectable()
export class StableService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(CACHE_MANAGER) private readonly cache: Cache,
        @Inject(forwardRef(() => QuestService)) private readonly questService: QuestService,
    ) { }

    private static inFlight = new Map<string, Promise<string[]>>();
    private readonly NFT_TTL_SECONDS = 300;

    // --- Moralis bootstrap (same pattern as horses.service) ---
    private moralisReady = false;
    private async initMoralis() {
        if (!this.moralisReady) {
            await Moralis.start({ apiKey: process.env.MORALIS_API_KEY as string });
            this.moralisReady = true;
        }
    }

    private makeMoralisKey(wallet: string, contracts: string[]) {
        const w = wallet.toLowerCase();
        const c = [...contracts].map(a => a.toLowerCase()).sort().join(',');
        return `moralis:nfts:${CHAIN_ID}:${w}:${c}`;
    }

    private async getWalletTokenIdsCached(
        walletAddress: string,
        contracts: string[],
    ): Promise<string[]> {
        const key = this.makeMoralisKey(walletAddress, contracts);

        // 1) Fast path: cache
        const cached = await this.cache.get<string[]>(key);
        if (cached) return cached;

        // 2) De-dupe concurrent calls (single flight)
        const running = (this.constructor as typeof StableService).inFlight.get(key);
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
                (this.constructor as typeof StableService).inFlight.delete(key);
            }
        })();

        (this.constructor as typeof StableService).inFlight.set(key, p);
        return p;
    }

    /**
     * Scan the wallet's Stable NFTs on-chain and sync DB ownership.
     * Returns ONLY the stable with the LOWEST tokenId (as a single-element array),
     * decorated with `{ isDeposit: true }` to match your horses return shape.
     */
    async listBlockchainStable(walletAddress: string) {
        // await this.initMoralis();

        return await this.prisma.$transaction(async (tx) => {
            // 1) User
            const user = await tx.user.findUnique({
                where: { wallet: walletAddress.toLowerCase() },
                select: { id: true },
            });
            if (!user) throw new NotFoundException('User not found');
            const userId = user.id;

            // 2) NFTs on-chain (only Stable contract)
            const tokenIds = await this.getWalletTokenIdsCached(walletAddress, [STABLE_CONTRACT_ADDRESS]);
            if (!tokenIds.length) return [];

            // 3) Stables in DB for those tokenIds
            const stables = await tx.stable.findMany({
                where: { tokenId: { in: tokenIds } },
                select: { id: true, tokenId: true, userId: true },
            });

            const mismatchedStableIds = stables
                .filter(s => s.userId !== userId)
                .map(s => s.id);

            // 4) Fix ownership in ONE statement (only when owner differs)
            if (mismatchedStableIds.length > 0) {
                await tx.$executeRaw`
          UPDATE "Stable"
          SET "userId" = ${userId},
              "updatedAt" = NOW()
          WHERE "id" = ANY(${mismatchedStableIds})
            AND "userId" <> ${userId}
        `;
            }

            // 5) Fetch details and pick the LOWEST tokenId
            const details = await tx.stable.findMany({
                where: { tokenId: { in: tokenIds } },
                // include whatever you want here; keeping it light:
                include: { horses: { select: { id: true } } },
            });

            if (details.length === 0) return [];

            const withNumeric = details.map(s => ({
                s,
                n: Number(s.tokenId), // tokenId stored as text; safe for '1'..'400'
            })).filter(x => Number.isFinite(x.n));

            if (withNumeric.length === 0) return [];

            const lowest = withNumeric.reduce((a, b) => (b.n < a.n ? b : a)).s;

            return [
                {
                    ...lowest,
                    isDeposit: true,
                },
            ];
        });
    }

    /**
    * Buys a Stable for the user identified by wallet, during a given sale phase.
    * Atomic: debits WRON, mints Stable, enqueues StableMintRequest, flips flags, clears discount.
    *
    * Returns a small receipt with price charged and the issued tokenId.
    */
    async buyStable(wallet: string, salePhase: SalePhase) {
        if (!wallet) throw new BadRequestException('wallet is required');
        if (salePhase !== 'GTD' && salePhase !== 'FCFS') {
            throw new BadRequestException('salePhase must be GTD or FCFS');
        }

        const user = await this.prisma.user.findUnique({
            where: { wallet: wallet.toLowerCase() },
            select: {
                id: true,
                wron: true,
                stable: { select: { id: true } },
                stableSale: {
                    select: {
                        id: true,
                        gtd: true,
                        fcfs: true,
                        discount: true,
                        gtdUsed: true,
                        fcfsUsed: true,
                        discountList: true,
                    },
                },
            },
        });
        if (!user) throw new NotFoundException('User not found');

        const sale = user.stableSale;
        if (!sale) throw new BadRequestException('No StableSale entry found for this user.');

        // NEW GUARDS + time gates
        const now = Math.floor(Date.now() / 1000);
        if (salePhase === 'GTD') {
            if (!sale.gtd) throw new BadRequestException('User is not eligible for GTD.');
            if (sale.gtdUsed) throw new BadRequestException('GTD discount already used; cannot buy again in GTD phase.');
            if (now <= GTD_START_EPOCH) throw new BadRequestException('GTD is not open yet.');
        } else {
            if (!sale.fcfs) throw new BadRequestException('User is not eligible for FCFS.');
            if (sale.fcfsUsed) throw new BadRequestException('FCFS discount already used; cannot buy again in FCFS phase.');
            if (now <= FCFS_START_EPOCH) throw new BadRequestException('FCFS is not open yet.');
        }

        const basePrice = salePhase === 'GTD' ? 220 : 250;
        const discountApplicable = !sale.gtdUsed && !sale.fcfsUsed;
        const price = discountApplicable
            ? Number((basePrice * (1 - (sale.discount ?? 0) / 100)).toFixed(6))
            : basePrice;

        if (price <= 0) throw new BadRequestException('Calculated price is invalid.');

        const result = await this.prisma.$transaction(async (tx) => {
            const fresh = await tx.user.findUnique({
                where: { id: user.id },
                select: { wron: true },
            });
            if (!fresh) throw new NotFoundException('User not found (txn).');
            if (fresh.wron < price) throw new BadRequestException('Insufficient WRON balance.');

            const rows: Array<{ max_id: number }> = await tx.$queryRaw`
      SELECT GREATEST(
        COALESCE((SELECT MAX(CAST("tokenId" AS INT)) FROM "Stable"), 0),
        COALESCE((SELECT MAX("tokenId")             FROM "StableMintRequest"), 0)
      ) AS max_id
    `;
            const currentMax = Number(rows?.[0]?.max_id ?? 0);
            const nextTokenId = currentMax + 1;

            if (nextTokenId > 400) {
                throw new BadRequestException('Stable supply reached its maximum capacity!');
            }

            await tx.user.update({
                where: { id: user.id },
                data: { wron: { decrement: price } },
            });

            const createdStable = await tx.stableMintRequest.create({
                data: {
                    requesterId: user.id,
                    tokenId: nextTokenId,
                    status: TransactionStatus.PENDING,
                },
            });

            await tx.stableSale.update({
                where: { id: sale.id },
                data: {
                    gtdUsed: salePhase === 'GTD' ? true : sale.gtdUsed,
                    fcfsUsed: salePhase === 'FCFS' ? true : sale.fcfsUsed,
                    discount: 0,
                    discountList: [],
                },
            });

            return {
                stableId: createdStable.id,
                tokenId: nextTokenId,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 8000,
            timeout: 15000,
        });

        return {
            userId: user.id,
            tokenId: result.tokenId,
            priceCharged: price,
            message: 'Stable purchase enqueued successfully. Mint will be finalized by the cron.',
        };
    }

    /**
    * Returns the highest tokenId seen across Stable (string tokenId) and StableMintRequest (int tokenId),
    * and the next tokenId you should allocate.
    */
    async getMaxStableTokenId() {
        const rows = await this.prisma.$queryRaw<Array<{ max_id: number }>>`
      SELECT GREATEST(
        COALESCE((SELECT MAX(CAST("tokenId" AS INT)) FROM "Stable"), 0),
        COALESCE((SELECT MAX("tokenId")             FROM "StableMintRequest"), 0)
      ) AS max_id
    `;
        const maxTokenId = Number(rows?.[0]?.max_id ?? 0);
        return {
            maxTokenId,          // e.g., 137
            nextTokenId: maxTokenId + 1, // e.g., 138
        };
    }

    private upgradeHoursFor(level: number): number {
        return STABLE_UPGRADE_HOURS[level as 1 | 2 | 3] ?? 0;
    }

    private computeEta(startedAt: Date, levelFrom: number): { eta: Date; secondsLeft: number } {
        const hrs = this.upgradeHoursFor(levelFrom);
        const etaMs = startedAt.getTime() + hrs * 3600_000;
        const nowMs = Date.now();
        const secondsLeft = Math.max(0, Math.floor((etaMs - nowMs) / 1000));
        return { eta: new Date(etaMs), secondsLeft };
    }

    // ---------- UPGRADE: start ----------
    async startUpgrade(wallet: string, tokenId: string) {
        if (!wallet) throw new BadRequestException('wallet is required');
        if (!tokenId) throw new BadRequestException('tokenId is required');

        // Get user
        const user = await this.prisma.user.findUnique({
            where: { wallet: wallet.toLowerCase() },
            select: { id: true },
        });
        if (!user) throw new NotFoundException('User not found');
        const userId = user.id;

        // All checks & mutations atomically
        const result = await this.prisma.$transaction(async (tx) => {
            // Load the stable (ownership + state)
            const stable = await tx.stable.findFirst({
                where: { tokenId, userId },
                select: { id: true, level: true, upgrading: true },
            });
            if (!stable) throw new NotFoundException('Stable not found'); // hide details to non-owners
            if (stable.level >= 4) throw new BadRequestException('Stable is already at max level');
            if (stable.upgrading) throw new BadRequestException('Stable is already upgrading');

            const nextLevel = (stable.level + 1) as 2 | 3 | 4;
            const cost = STABLE_LEVELS[nextLevel].upgradeCostPhorse;

            // 1) Mark upgrading (guard against races)
            const marked = await tx.$queryRaw<Array<{ upgradeStarted: Date }>>`
      UPDATE "Stable"
      SET "upgrading" = TRUE,
          "upgradeStarted" = NOW(),
          "updatedAt" = NOW()
      WHERE "id" = ${stable.id}
        AND "userId" = ${userId}
        AND "upgrading" = FALSE
        AND "level" = ${stable.level}
        AND "level" < 4
      RETURNING "upgradeStarted"
    `;
            if (marked.length === 0) {
                throw new BadRequestException('Unable to start upgrade (race or invalid state)');
            }
            const startedAt = marked[0].upgradeStarted;

            // 2) Deduct PHORSE atomically (guard balance)
            const deducted = await tx.$executeRaw`
      UPDATE "User"
      SET "phorse" = "phorse" - ${cost}
      WHERE "id" = ${userId}
        AND "phorse" >= ${cost}
    `;
            if ((deducted as number) === 0) {
                // Throwing rolls back the "upgrading" flag as well
                throw new BadRequestException('Insufficient PHORSE to start upgrade');
            }

            // 3) Track total PHORSE spent (same txn)
            const newTotalSpent = await tx.$executeRaw`
      UPDATE "User"
      SET "totalPhorseSpent" = "totalPhorseSpent" + ${cost}
      WHERE "id" = ${userId}
    `;
            if ((newTotalSpent as number) === 0) {
                throw new BadRequestException('Something went wrong while updating totals');
            }

            const { eta, secondsLeft } = this.computeEta(startedAt, stable.level);

            // Return everything needed for the post-txn quest update
            return {
                tokenId,
                levelFrom: stable.level,
                levelTo: nextLevel,
                cost,
                startedAt,
                eta,
                secondsLeft,
                upgrading: true,
                userId, // include for convenience
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 8000,
            timeout: 15000,
        });

        // ---- Quest progression: track PHORSE spent on upgrade (non-blocking) ----
        try {
            const { QuestType } = await import('../quest/quest.types');
            await this.questService.incrementQuestProgress(
                result.userId,
                QuestType.SPEND_PHORSE,
                result.cost
            );
        } catch (err) {
            console.error('Failed to update quest progress for startUpgrade:', err);
            // Do not throw; upgrade already started successfully.
        }

        return {
            tokenId: result.tokenId,
            levelFrom: result.levelFrom,
            levelTo: result.levelTo,
            cost: result.cost,
            startedAt: result.startedAt,
            eta: result.eta,
            secondsLeft: result.secondsLeft,
            upgrading: result.upgrading,
        };
    }

    // ---------- UPGRADE: status/eta ----------
    async getUpgradeEta(wallet: string, tokenId: string) {
        if (!wallet) throw new BadRequestException('wallet is required');
        if (!tokenId) throw new BadRequestException('tokenId is required');

        const user = await this.prisma.user.findUnique({
            where: { wallet: wallet.toLowerCase() },
            select: { id: true },
        });
        if (!user) throw new NotFoundException('User not found');
        const userId = user.id;

        const stable = await this.prisma.stable.findFirst({
            where: { tokenId, userId },
            select: { level: true, upgrading: true, upgradeStarted: true },
        });
        if (!stable) throw new NotFoundException('Stable not found');

        const levelFrom = stable.level;
        const levelTo = Math.min(4, levelFrom + 1);

        if (!stable.upgrading || !stable.upgradeStarted) {
            return {
                tokenId,
                levelFrom,
                levelTo,
                upgrading: false,
                startedAt: null,
                eta: null,
                secondsLeft: 0,
                done: levelFrom >= 4, // nothing to do if already max
            };
        }

        const { eta, secondsLeft } = this.computeEta(stable.upgradeStarted, levelFrom);
        return {
            tokenId,
            levelFrom,
            levelTo,
            upgrading: true,
            startedAt: stable.upgradeStarted,
            eta,
            secondsLeft,
            done: secondsLeft === 0,
        };
    }

    // ---------- UPGRADE: finish (apply level+1) ----------
    async finishUpgrade(wallet: string, tokenId: string) {
        if (!wallet) throw new BadRequestException('wallet is required');
        if (!tokenId) throw new BadRequestException('tokenId is required');

        const user = await this.prisma.user.findUnique({
            where: { wallet: wallet.toLowerCase() },
            select: { id: true },
        });
        if (!user) throw new NotFoundException('User not found');
        const userId = user.id;

        // Apply only if time has elapsed and state is correct — do it in one guarded SQL
        const updated = await this.prisma.$queryRaw<Array<{ level: number }>>`
      UPDATE "Stable"
      SET "level" = "level" + 1,
          "upgrading" = FALSE,
          "upgradeStarted" = NULL,
          "updatedAt" = NOW()
      WHERE "tokenId" = ${tokenId}
        AND "userId"  = ${userId}
        AND "upgrading" = TRUE
        AND "level" BETWEEN 1 AND 3
        AND "upgradeStarted" IS NOT NULL
        AND NOW() >= "upgradeStarted" + (
          CASE
            WHEN "level" = 1 THEN interval '6 hours'
            WHEN "level" = 2 THEN interval '18 hours'
            WHEN "level" = 3 THEN interval '54 hours'
            ELSE interval '0 hours'
          END
        )
      RETURNING "level"
    `;

        if (updated.length === 0) {
            // Give a precise error if possible
            const s = await this.prisma.stable.findFirst({
                where: { tokenId, userId },
                select: { level: true, upgrading: true, upgradeStarted: true },
            });
            if (!s) throw new NotFoundException('Stable not found');
            if (!s.upgrading || !s.upgradeStarted) {
                throw new BadRequestException('Stable is not upgrading');
            }

            // Time not elapsed yet
            const { secondsLeft } = this.computeEta(s.upgradeStarted, s.level);
            if (secondsLeft > 0) {
                throw new BadRequestException(`Upgrade not ready yet. ${secondsLeft}s remaining`);
            }

            // Fallback
            throw new BadRequestException('Unable to finish upgrade (invalid state)');
        }

        // The RETURNING level is the new level (already incremented)
        return {
            tokenId,
            newLevel: updated[0].level,
            message: 'Upgrade finalized',
        };
    }

    /**
   * Stable status for UI:
   * - level, upgrading, upgradeStarted
   * - upgradeEndsAt & upgradeRemainingSeconds (if upgrading)
   * - horsesHoused (count)
   * - capacity / simultaneousBreeds / extraEnergyPerTick (from static data)
   */
    async getStableStatus(_wallet: string, tokenId: string) {
        const row = await this.prisma.stable.findUnique({
            where: { tokenId },
            select: {
                id: true,
                tokenId: true,
                level: true,
                upgrading: true,
                upgradeStarted: true,
                _count: { select: { horses: true } },
                userId: true,
            },
        });
        if (!row) throw new NotFoundException('Stable not found');

        // Clamp & map level to static info
        const lvl = Math.max(1, Math.min(4, row.level)) as StableLevel;
        const info = STABLE_LEVELS[lvl];

        // Compute ETA if upgrading
        let upgradeEndsAt: string | null = null;
        let upgradeRemainingSeconds: number | null = null;

        if (row.upgrading && row.upgradeStarted && lvl < 4) {
            const hours = STABLE_UPGRADE_HOURS[lvl] ?? 0;
            const ends = new Date(row.upgradeStarted.getTime() + hours * 3600 * 1000);
            upgradeEndsAt = ends.toISOString();
            const rem = Math.max(0, Math.floor((ends.getTime() - Date.now()) / 1000));
            upgradeRemainingSeconds = rem;
        }

        return {
            tokenId: row.tokenId,
            level: lvl,
            upgrading: !!row.upgrading,
            upgradeStarted: row.upgradeStarted ? row.upgradeStarted.toISOString() : null,
            upgradeEndsAt,
            upgradeRemainingSeconds,

            horsesHoused: row._count.horses,

            // Useful static data for UI
            capacity: info.capacity,
            simultaneousBreeds: info.simultaneousBreeds,
            extraEnergyPerTick: info.extraEnergyPerTick,
        };
    }

    /**
       * Assign a user's horse to their stable (up to capacity).
       * - Only the *stable owner* and *horse owner* may do this.
       * - Fails if horse already assigned.
       * - Sets horse.stable (relation) and horse.lastStableAsignment = NOW()
       *   (spelling kept as requested).
       */
    async assignHorseToStable(
        wallet: string,
        stableTokenId: string,
        horseId: number,
    ) {
        if (!wallet) throw new BadRequestException('wallet is required');
        if (!stableTokenId) throw new BadRequestException('stable tokenId is required');
        if (!Number.isFinite(horseId)) throw new BadRequestException('horseId must be a number');

        return this.prisma.$transaction(async (tx) => {
            // 1) Identify user
            const user = await tx.user.findUnique({
                where: { wallet: wallet.toLowerCase() },
                select: { id: true },
            });
            if (!user) throw new NotFoundException('User not found');
            const userId = user.id;

            // 2) Stable (must belong to this user)
            const stable = await tx.stable.findUnique({
                where: { tokenId: stableTokenId },
                select: { id: true, userId: true, level: true },
            });
            if (!stable) throw new NotFoundException('Stable not found');
            if (stable.userId !== userId) {
                throw new ForbiddenException('You are not the owner of this stable');
            }

            // 3) Horse (must belong to this user and not already assigned)
            const horse = await tx.horse.findUnique({
                where: { tokenId: String(horseId) },
                select: { id: true, ownerId: true, stableid: true },
            });
            if (!horse) throw new NotFoundException('Horse not found');
            if (horse.ownerId !== userId) {
                throw new ForbiddenException('You are not the owner of this horse');
            }
            if (horse.stableid) {
                throw new BadRequestException('Horse is already assigned to a stable');
            }

            // 4) Capacity check (race-safe within the same txn)
            const level = Math.max(1, Math.min(4, stable.level)) as 1 | 2 | 3 | 4;
            const capacity = STABLE_LEVELS[level].capacity;

            const housed = await tx.horse.count({
                where: { stableid: stable.id },
            });
            if (housed >= capacity) {
                throw new BadRequestException('Stable is at full capacity');
            }

            // 5) Assign + set lastStableAsignment = NOW()
            await tx.horse.update({
                where: { id: horse.id },
                data: {
                    stable: { connect: { id: stable.id } },   // relation connect
                    lastStableAsignment: new Date(),          // spelling as requested
                },
            });

            return {
                ok: true,
                stableTokenId,
                horseId,
                housedAfter: housed + 1,
                capacity,
                message: 'Horse assigned to stable',
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 8000,
            timeout: 15000,
        });
    }

    /**
     * Remove a user's horse from their stable.
     * - Only stable owner + horse owner.
     * - Horse must currently be housed in THIS stable.
     * - lastStableAsignment must be >= 24h ago.
     */
    async removeHorseFromStable(
        wallet: string,
        stableTokenId: string,
        horseId: number,
    ) {
        if (!wallet) throw new BadRequestException('wallet is required');
        if (!stableTokenId) throw new BadRequestException('stable tokenId is required');
        if (!Number.isFinite(horseId)) throw new BadRequestException('horseId must be a number');

        return this.prisma.$transaction(async (tx) => {
            // 1) Identify user
            const user = await tx.user.findUnique({
                where: { wallet: wallet.toLowerCase() },
                select: { id: true },
            });
            if (!user) throw new NotFoundException('User not found');
            const userId = user.id;

            // 2) Stable (must belong to this user)
            const stable = await tx.stable.findUnique({
                where: { tokenId: stableTokenId },
                select: { id: true, userId: true, level: true },
            });
            if (!stable) throw new NotFoundException('Stable not found');
            if (stable.userId !== userId) {
                throw new ForbiddenException('You are not the owner of this stable');
            }

            // 3) Horse (must belong to this user and be housed in this stable)
            const horse = await tx.horse.findUnique({
                where: { tokenId: String(horseId) },
                select: { id: true, ownerId: true, stableid: true, lastStableAsignment: true },
            });
            if (!horse) throw new NotFoundException('Horse not found');
            if (horse.ownerId !== userId) {
                throw new ForbiddenException('You are not the owner of this horse');
            }
            if (horse.stableid !== stable.id) {
                throw new BadRequestException('Horse is not currently assigned to this stable');
            }

            // 4) 24h cooldown since lastStableAsignment
            const last = horse.lastStableAsignment;
            if (!last) {
                // if not set, treat as not removable to be safe
                throw new BadRequestException('Removal cooldown not satisfied yet');
            }
            const now = Date.now();
            const elapsedMs = now - new Date(last).getTime();
            const MIN_MS = 24 * 60 * 60 * 1000;
            if (elapsedMs < MIN_MS) {
                const remainingMs = MIN_MS - elapsedMs;
                const remainingHrs = Math.ceil(remainingMs / (60 * 60 * 1000));
                throw new BadRequestException(`Cannot remove yet. ${remainingHrs}h remaining.`);
            }

            // 5) Disconnect from stable
            await tx.horse.update({
                where: { id: horse.id },
                data: {
                    stableid: null,
                },
            });

            const housedAfter = await tx.horse.count({ where: { stableid: stable.id } });
            const level = Math.max(1, Math.min(4, stable.level)) as 1 | 2 | 3 | 4;

            return {
                ok: true,
                stableTokenId,
                horseId,
                housedAfter,
                capacity: STABLE_LEVELS[level].capacity,
                message: 'Horse removed from stable',
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 8000,
            timeout: 15000,
        });
    }

    /**
     * Get stable information by UUID (id field).
     * Returns detailed stable info including housed horses and static level data.
     */
    async getStableByUUID(uuid: string) {
        if (!uuid) throw new BadRequestException('uuid is required');

        const stable = await this.prisma.stable.findUnique({
            where: { id: uuid },
            select: {
                id: true,
                tokenId: true,
                level: true,
                upgrading: true,
                upgradeStarted: true,
                userId: true,
                createdAt: true,
                updatedAt: true,
                horses: {
                    select: {
                        id: true,
                        tokenId: true,
                        name: true,
                        lastStableAsignment: true,
                    },
                },
                user: {
                    select: {
                        id: true,
                        wallet: true,
                    },
                },
            },
        });

        if (!stable) throw new NotFoundException('Stable not found');

        // Clamp & map level to static info
        const lvl = Math.max(1, Math.min(4, stable.level)) as StableLevel;
        const info = STABLE_LEVELS[lvl];

        // Compute ETA if upgrading
        let upgradeEndsAt: string | null = null;
        let upgradeRemainingSeconds: number | null = null;

        if (stable.upgrading && stable.upgradeStarted && lvl < 4) {
            const hours = STABLE_UPGRADE_HOURS[lvl] ?? 0;
            const ends = new Date(stable.upgradeStarted.getTime() + hours * 3600 * 1000);
            upgradeEndsAt = ends.toISOString();
            const rem = Math.max(0, Math.floor((ends.getTime() - Date.now()) / 1000));
            upgradeRemainingSeconds = rem;
        }

        return {
            id: stable.id,
            tokenId: stable.tokenId,
            level: lvl,
            upgrading: stable.upgrading,
            upgradeStarted: stable.upgradeStarted ? stable.upgradeStarted.toISOString() : null,
            upgradeEndsAt,
            upgradeRemainingSeconds,

            owner: {
                id: stable.user.id,
                wallet: stable.user.wallet,
            },

            horses: stable.horses.map(h => ({
                id: h.id,
                tokenId: h.tokenId,
                name: h.name,
                lastStableAsignment: h.lastStableAsignment ? h.lastStableAsignment.toISOString() : null,
            })),

            horsesHoused: stable.horses.length,
            capacity: info.capacity,
            simultaneousBreeds: info.simultaneousBreeds,
            extraEnergyPerTick: info.extraEnergyPerTick,

            createdAt: stable.createdAt.toISOString(),
        };
    }

    async getTokenIdByUUID(stableUUID: string) {
        if (!stableUUID || typeof stableUUID !== 'string') {
            throw new BadRequestException('Stable UUID is required.');
        }

        const stable = await this.prisma.stable.findUnique({
            where: { id: stableUUID },
            select: { tokenId: true, userId: true },
        });

        if (!stable) throw new NotFoundException('Stable not found');

        return { tokenId: stable.tokenId };
    }

}
