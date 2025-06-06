import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chests } from 'src/data/items';
import { TransactionStatus, TransactionType } from '@prisma/client';
import { chestsPercentage, items } from '../data/items';

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
    * Open `chestQuantity` chests of type `chestType` for the user identified by wallet.
    * Returns an array of the drop names.
    */
    async openChest(
        ownerWallet: string,
        chestType: number,
        chestQuantity: number,
    ): Promise<string[]> {
        if (chestQuantity < 1) {
            throw new BadRequestException('chestQuantity must be at least 1');
        }

        // run everything in one transaction
        return this.prisma.$transaction(async (tx) => {
            // 1) find the user & their internal ID
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) {
                throw new NotFoundException('User not found');
            }

            // 2) atomically decrement chest quantity if they have enough
            const dec = await tx.chest.updateMany({
                where: {
                    ownerId: user.id,
                    chestType,
                    quantity: { gte: chestQuantity },
                },
                data: { quantity: { decrement: chestQuantity } },
            });
            if (dec.count === 0) {
                throw new BadRequestException('Not enough chests to open');
            }

            // 3) roll and collect drops
            const drops: string[] = [];
            const lookup = chestsPercentage[chestType];
            if (!lookup) {
                throw new NotFoundException(`Chest type ${chestType} unknown`);
            }
            // pre-sort thresholds
            const thresholds = Object.keys(lookup)
                .map(k => Number(k))
                .sort((a, b) => a - b);

            for (let i = 0; i < chestQuantity; i++) {
                const roll = Math.random() * 100;
                const th = thresholds.find(t => roll <= t)!;
                const name = lookup[th];
                drops.push(name);

                if (name.toLowerCase().endsWith('phorse')) {
                    // CREDIT PHORSE
                    const amount = parseInt(name, 10);
                    if (Number.isNaN(amount)) {
                        throw new Error(`Bad phorse drop "${name}"`);
                    }
                    await tx.user.update({
                        where: { id: user.id },
                        data: { phorse: { increment: amount } },
                    });
                } else {
                    // CREATE/UPDATE ITEM
                    const def = (items as Record<string, any>)[name];
                    if (!def) {
                        throw new Error(`Dropped item "${name}" not in items map`);
                    }
                    await tx.item.create({
                        data: {
                            owner: { connect: { id: user.id } },
                            name,
                            value: 1,
                            breakable: def.breakable,
                            uses: def.breakable ? def.uses : null,
                            // no horseId/equipedBy for chest drops
                        },
                    });
                }
                // log the ITEM transaction for opening the chest
                await tx.transaction.create({
                    data: {
                        owner: { connect: { id: user.id } },
                        type: TransactionType.ITEM,
                        status: TransactionStatus.COMPLETED,
                        value: 0,
                        note: `Opened ${name} x1`,
                    },
                });
            }

            return drops;
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

    /**
    * List and group all items for the given user wallet.
    * Groups by name (and breakable, in case you care) and returns
    * { name, quantity } for each.
    */
    async listItems(ownerWallet: string) {
        // 1) Lookup user ID
        const user = await this.prisma.user.findUnique({
            where: { wallet: ownerWallet },
            select: { id: true },
        });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // 2) Group items by name AND uses (usesLeft)
        const groups = await this.prisma.item.groupBy({
            by: ['name', 'uses'],
            where: {
                ownerId: user.id,
                horseId: null
            },
            _count: { _all: true },
        });

        // 3) Map into the shape: { name, usesLeft, quantity }
        return groups.map(g => ({
            name: g.name,
            usesLeft: g.uses,           // <─ Prisma’s `uses` column is the “remaining uses” for that group
            quantity: g._count._all,    // how many items share (name, usesLeft)
        }));
    }
}
