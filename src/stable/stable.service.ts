import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type SalePhase = 'GTD' | 'FCFS';

// Sale windows (UTC)
const GTD_START_EPOCH = 1758546000;  // 2025-09-22 13:00:00 UTC
const FCFS_START_EPOCH = 1758549600; // 2025-09-22 14:00:00 UTC

@Injectable()
export class StableService {
    constructor(private readonly prisma: PrismaService) { }

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
