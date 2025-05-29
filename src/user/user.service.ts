import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chests } from 'src/data/items';
import { TransactionStatus, TransactionType } from '@prisma/client';

@Injectable()
export class UserService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Finds a user by wallet address or creates one with phorse = 0.
     */
    async findOrCreateByAddress(address: string) {
        return this.prisma.user.upsert({
            where: { wallet: address },
            create: {
                wallet: address,
                phorse: 0,
                // name is nullable by default,
                // horses, items, transactions start empty
            },
            update: {
                // nothing to change if already exists
            },
        });
    }

    async getBalance(wallet: string) {
        const u = await this.prisma.user.findUnique({
            where: { wallet },
            select: { phorse: true },
        });
        return u?.phorse;
    }

    async getMedals(wallet: string) {
        const u = await this.prisma.user.findUnique({
            where: { wallet },
            select: { medals: true },
        });
        return u?.medals;
    }

    /**
  * Buy a given chest type/quantity for a user identified by wallet.
  * Ensures the chestType exists, is not paused, user has enough PHORSE,
  * and then atomically deducts PHORSE + upserts a Chest record.
  */
    async buyChest(
        ownerWallet: string,
        chestType: number,
        chestQuantity: number,
    ) {
        // 1) Validate chestType exists & not paused
        const def = chests[chestType];
        if (!def) {
            throw new NotFoundException(`Chest type ${chestType} does not exist`);
        }
        if (def.paused) {
            throw new BadRequestException('This chest is currently unavailable');
        }
        if (!Number.isInteger(chestQuantity) || chestQuantity < 1) {
            throw new BadRequestException('Invalid chest quantity');
        }

        const totalCost = def.price * chestQuantity;

        // 2) Run everything in one Prisma transaction
        return this.prisma.$transaction(async (tx) => {
            // A) Deduct PHORSE only if enough balance
            const upd = await tx.user.updateMany({
                where: {
                    wallet: ownerWallet,
                    phorse: { gte: totalCost },
                },
                data: {
                    phorse: { decrement: totalCost },
                },
            });
            if (upd.count === 0) {
                throw new BadRequestException('Insufficient PHORSE balance');
            }

            // B) Look up user id
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) {
                throw new NotFoundException('User not found');
            }

            // C) Upsert Chest
            const chest = await tx.chest.upsert({
                where: {
                    ownerId_chestType: { ownerId: user.id, chestType },
                },
                create: {
                    owner: { connect: { id: user.id } },
                    chestType,
                    quantity: chestQuantity,
                },
                update: {
                    quantity: { increment: chestQuantity },
                },
            });

            // D) Record the purchase transaction
            await tx.transaction.create({
                data: {
                    owner: { connect: { id: user.id } },
                    type: TransactionType.ITEM,
                    status: TransactionStatus.COMPLETED,
                    note: `Bought ${chestQuantity} chest(s)`,
                    value: totalCost,
                    // txId: optional on-chain id if you have one
                },
            });

            return chest;
        });
    }

    /**
     * List all chests for a given user.
     */
    async listChests(ownerWallet: string) {
        const user = await this.prisma.user.findUnique({
            where: { wallet: ownerWallet },
            select: { id: true },
        });
        if (!user) {
            throw new NotFoundException('User not found');
        }
        return this.prisma.chest.findMany({
            where: { ownerId: user.id },
        });
    }

    /** Fetch all transactions for a given user wallet */
    async listTransactions(ownerWallet: string) {
        // 1) get the user’s internal ID
        const user = await this.prisma.user.findUnique({
            where: { wallet: ownerWallet },
            select: { id: true },
        });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // 2) fetch their transactions
        return this.prisma.transaction.findMany({
            where: { ownerId: user.id },
            orderBy: { createdAt: 'desc' },
            select: {
                type: true,
                status: true,
                value: true,
                txId: true,
                note: true,
                createdAt: true,
            },
        });
    }

}
