import { BadRequestException, Injectable, NotFoundException, Inject } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import Moralis from 'moralis';

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
        @Inject(CACHE_MANAGER) private readonly cache: Cache
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

}
