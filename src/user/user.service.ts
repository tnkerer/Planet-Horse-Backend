import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chests } from 'src/data/items';
import { TransactionStatus, TransactionType, Request } from '@prisma/client';
import { chestsPercentage, items } from '../data/items';
import { globals } from 'src/data/globals';
import { getWithdrawUserPct, withdrawTaxConfig } from './withdraw-tax';
import { HorseService } from 'src/horse/horse.service';
import { itemUpgradeCost, successRate, upgradePoints } from 'src/data/item_progression';
import { randomBytes } from 'crypto';
import { itemCraftReq } from '../data/item_crafting';

@Injectable()
export class UserService {
    constructor(private readonly prisma: PrismaService, private readonly horseService: HorseService) { }

    /**
     * Finds a user by wallet address or creates one with phorse = 0.
     */
    async findOrCreateByAddress(address: string, referredById?: string) {
        const existingUser = await this.prisma.user.findUnique({
            where: { wallet: address },
        });

        // If the user is referring itself, ignore the referral code
        if (existingUser && referredById && existingUser.id === referredById) {
            referredById = undefined;
        }

        if (!existingUser) {
            return this.prisma.user.create({
                data: {
                    wallet: address,
                    phorse: 0,
                    referredById: referredById || null,
                },
            });
        }

        // Existing user with no referredById → assign referredById
        if (referredById && !existingUser.referredById) {
            return this.prisma.user.update({
                where: { wallet: address },
                data: { referredById },
            });
        }

        return existingUser;
    }

    async getProfile(wallet: string) {
        const user = await this.prisma.user.findUnique({
            where: { wallet },
            select: {
                id: true,
                wallet: true,
                referredById: true,
                phorse: true,
                medals: true,
            },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        return user;
    }

    // ----------------------- BALANCE SECTION ------------------------

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

    // ------------------- ITEMS SECTION -----------------------

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

        // Fetch user and check referral
        const user = await this.prisma.user.findUnique({
            where: { wallet: ownerWallet },
            select: { id: true, referredById: true, phorse: true },
        });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const price = user.referredById ? def.discountedPrice : def.price;
        const totalCost = price * chestQuantity;

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
                    totalPhorseSpent: { increment: totalCost },
                    presalePhorse: { decrement: totalCost }
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
                        data: {
                            phorse: { increment: amount },
                            totalPhorseEarned: { increment: amount }
                        },
                    });
                } else if (name.toLowerCase().endsWith('medals')) {
                    // << NEW: Medals credit logic >>
                    // e.g. "250 medals" → 250
                    const amount = parseInt(name, 10);
                    if (Number.isNaN(amount)) {
                        throw new Error(`Bad medals drop "${name}"`);
                    }
                    await tx.user.update({
                        where: { id: user.id },
                        data: {
                            medals: { increment: amount }
                        },
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
     * Recycle up to `quantity` copies of the given item (name + uses).
     * Rolls scrap for each, credits any Scrap Metal/Leather in bulk,
     * logs all transactions in bulk, and returns your rewards per item.
     *
     * @param ownerWallet  the user's wallet
     * @param itemName     the exact name of the item to recycle
     * @param uses         the exact usesLeft value
     * @param quantity     how many copies to recycle
     * @returns            an array of length ≤ quantity of rewards
     *                    (each "Scrap Metal", "Scrap Leather", or null)
     */
    async recyle(
        ownerWallet: string,
        itemName: string,
        uses: number,
        quantity: number
    ): Promise<(string | null)[]> {
        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new BadRequestException('Quantity must be a positive integer');
        }

        return this.prisma.$transaction(async tx => {
            // 1) find user
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) throw new NotFoundException('User not found');

            // 2) validate item exists
            const def = (items as Record<string, any>)[itemName];
            if (!def) {
                throw new NotFoundException(`Item "${itemName}" does not exist`);
            }

            // 3) grab up to `quantity` matching item IDs
            const ownItems = await tx.item.findMany({
                where: {
                    ownerId: user.id,
                    name: itemName,
                    uses: uses,
                    horseId: null,
                },
                select: { id: true },
                orderBy: { createdAt: 'asc' },
                take: quantity,
            });
            if (ownItems.length < quantity) {
                throw new BadRequestException(
                    `You only have ${ownItems.length} "${itemName}"(uses=${uses})`
                );
            }

            // 4) delete them in one go
            const ids = ownItems.map(i => i.id);
            await tx.item.deleteMany({ where: { id: { in: ids } } });

            // 5) roll scrap for each deleted item
            const rewards: (string | null)[] = [];
            const scrapCreates: Array<{
                ownerId: string;
                name: string;
                value: number;
                breakable: boolean;
                uses: number | null;
            }> = [];
            const txLogs: Array<{
                ownerId: string;
                type: TransactionType;
                status: TransactionStatus;
                value: number;
                note: string;
            }> = [];

            for (let i = 0; i < quantity; i++) {
                const roll = Math.random() * 100;
                let reward: string | null = null;

                if (roll >= 10 && roll < 50) {
                    reward = 'Scrap Metal';
                } else if (roll >= 50 && roll < 90) {
                    reward = 'Scrap Leather';
                }
                rewards.push(reward);

                // prepare bulk-create data
                if (reward) {
                    const scrapDef = (items as Record<string, any>)[reward];
                    scrapCreates.push({
                        ownerId: user.id,
                        name: reward,
                        value: 1,
                        breakable: scrapDef.breakable,
                        uses: scrapDef.uses,
                    });
                }

                txLogs.push({
                    ownerId: user.id,
                    type: TransactionType.ITEM,
                    status: TransactionStatus.COMPLETED,
                    value: 0,
                    note: reward
                        ? `Recycled "${itemName}" (uses=${uses}), got ${reward}`
                        : `Recycled "${itemName}" (uses=${uses}), got nothing`,
                });
            }

            // 6) credit all scrap in one call
            if (scrapCreates.length) {
                await tx.item.createMany({
                    data: scrapCreates.map(c => ({
                        ownerId: c.ownerId,
                        name: c.name,
                        value: c.value,
                        breakable: c.breakable,
                        uses: c.uses,
                    })),
                });
            }

            // 7) log all transactions in one call
            await tx.transaction.createMany({ data: txLogs });

            return rewards;
        });
    }


    async upgradeItem(ownerWallet: string, itemName: string) {
        const bases = ['Champion Bridle', 'Champion Saddle Pad', 'Champion Stirrups'] as const;
        const base = bases.find(b => itemName === b || itemName.startsWith(b + ' +'));
        if (!base) {
            throw new BadRequestException(`"${itemName}" is not upgradable`);
        }

        const currentLevel = parseInt(itemName.match(/\+(\d+)$/)?.[1] ?? '0', 10);
        const nextLevel = currentLevel + 1;
        const nextName = `${base}${nextLevel ? ' +' + nextLevel : ''}`;

        if (!items[nextName]) {
            throw new BadRequestException(`No upgrade data for "${nextName}"`);
        }
        const cost = itemUpgradeCost[nextLevel];
        if (!cost) {
            throw new BadRequestException(`No upgrade cost defined for level ${nextLevel}`);
        }
        const rate = successRate[nextLevel];
        if (!rate) {
            throw new BadRequestException(`No success rate defined for level ${nextLevel}`);
        }

        const roll = Math.random() * 100;
        const succeeded = roll < rate.success;
        const willBreak = !succeeded && rate.break;

        return this.prisma.$transaction(async tx => {
            // 1) Atomically decrement PHORSE & MEDALS
            const dec = await tx.user.updateMany({
                where: {
                    wallet: ownerWallet,
                    phorse: { gte: cost.phorse },
                    medals: { gte: cost.medal },
                },
                data: {
                    phorse: { decrement: cost.phorse },
                    totalPhorseSpent: { increment: cost.phorse },
                    medals: { decrement: cost.medal },
                }
            });
            if (dec.count === 0) {
                throw new BadRequestException(
                    `Need ${cost.phorse} PHORSE & ${cost.medal} MEDALS to upgrade`
                );
            }

            // 2) Lookup user ID
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) throw new NotFoundException('User not found');

            // 3) Bulk-delete Scrap Metal
            if (cost.metal > 0) {
                const metalIds = (await tx.item.findMany({
                    where: { ownerId: user.id, name: 'Scrap Metal' },
                    orderBy: { createdAt: 'asc' },
                    take: cost.metal,
                    select: { id: true },
                })).map(x => x.id);

                if (metalIds.length < cost.metal) {
                    throw new BadRequestException(`Not enough Scrap Metal (need ${cost.metal})`);
                }
                await tx.item.deleteMany({ where: { id: { in: metalIds } } });
            }

            // 4) Bulk-delete Scrap Leather
            if (cost.leather > 0) {
                const leatherIds = (await tx.item.findMany({
                    where: { ownerId: user.id, name: 'Scrap Leather' },
                    orderBy: { createdAt: 'asc' },
                    take: cost.leather,
                    select: { id: true },
                })).map(x => x.id);

                if (leatherIds.length < cost.leather) {
                    throw new BadRequestException(`Not enough Scrap Leather (need ${cost.leather})`);
                }
                await tx.item.deleteMany({ where: { id: { in: leatherIds } } });
            }

            // 5) Find the item instance to operate on
            const target = await tx.item.findFirst({
                where: { ownerId: user.id, name: itemName, horseId: null },
                orderBy: { createdAt: 'asc' },
            });
            if (!target) {
                throw new BadRequestException(`You don’t own any "${itemName}"`);
            }

            let finalItemId: string | null = null;

            // 6) Apply upgrade or break
            if (succeeded) {
                const upgraded = await tx.item.update({
                    where: { id: target.id },
                    data: { name: nextName },
                });
                finalItemId = upgraded.id;

                // **Increment upgradeScore based on upgradePoints**
                const points = upgradePoints[nextLevel.toString()] ?? 0;
                if (points > 0) {
                    await tx.user.update({
                        where: { id: user.id },
                        data: { upgradeScore: { increment: points } }
                    });
                }

            } else if (willBreak) {
                // delete the broken item
                await tx.item.delete({ where: { id: target.id } });
                finalItemId = null;
            } else {
                // failure but not broken: leave target as-is
                finalItemId = target.id;
            }

            // 7) Log the attempt
            const note = succeeded
                ? `Upgrade succeeded: "${itemName}" → "${nextName}"`
                : willBreak
                    ? `Upgrade failed and broke "${itemName}"`
                    : `Upgrade failed (no break) for "${itemName}"`;

            await tx.transaction.create({
                data: {
                    owner: { connect: { id: user.id } },
                    type: TransactionType.ITEM,
                    status: TransactionStatus.COMPLETED,
                    value: 0,
                    note: `Attempted upgrade level ${currentLevel} → ${nextLevel}: ${note}`
                }
            });

            return {
                success: succeeded,
                broken: willBreak,
                itemId: finalItemId,
            };
        });
    }

    // ------------------- LISTS SECTION -----------------------

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

    // ------------------- WITHDRAW SECTION -----------------------

    /**
    * 1. Validate amount
    * 2. Atomically “reserve” PHORSE via a decrement-if-enough
    * 3. Create a PENDING Transaction
    * 4. Create the BridgeRequest pointing at that Transaction
    * 5. All in one Prisma TX ⇒ full rollback on any failure
    */
    async phorseWithdraw(ownerWallet: string, amount: number) {
        // 1) sanity‐check
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new BadRequestException('Invalid withdraw amount');
        }

        return this.prisma.$transaction(async (tx) => {
            // 2) reserve the PHORSE balance
            const dec = await tx.user.updateMany({
                where: {
                    wallet: ownerWallet,
                    phorse: { gte: amount },       // must have at least this much
                },
                data: {
                    phorse: { decrement: amount }, // atomic decrement
                },
            });
            if (dec.count === 0) {
                throw new BadRequestException('Insufficient PHORSE balance');
            }

            // 3) fetch the user’s internal id
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) {
                // (shouldn’t happen, but guard anyway)
                throw new NotFoundException('User not found');
            }

            // 4) create the PENDING withdrawal transaction
            const transaction = await tx.transaction.create({
                data: {
                    owner: { connect: { id: user.id } },
                    type: TransactionType.WITHDRAW,
                    status: TransactionStatus.PENDING,
                    value: amount,
                    note: `Requested withdraw of ${amount} PHORSE`,
                    txId: null,
                },
            });

            // 5) create the BridgeRequest linked 1:1 to that transaction
            await tx.bridgeRequest.create({
                data: {
                    owner: { connect: { id: user.id } },
                    request: Request.WITHDRAW,
                    value: amount,
                    transaction: { connect: { id: transaction.id } },
                },
            });

            // 6) return the pending TX for client‐side tracking
            return { transactionId: transaction.id, message: `Transaction ${transaction.id.slice(0, 8)} added to the bridge queue!` };
        });
    }

    async getWithdrawTax(wallet: string) {
        const user = await this.prisma.user.findUnique({
            where: { wallet },
            select: { id: true, lastRace: true, presalePhorse: true },
        });
        if (!user) throw new NotFoundException('User not found');

        // ① presale override
        if ((user.presalePhorse ?? 0) > 0) {
            const userPct = withdrawTaxConfig.initialUserPct;
            return { userPct, taxPct: 100 - userPct, hoursSinceLast: null };
        }

        // ② fetch last withdraw
        const last = await this.prisma.transaction.findFirst({
            where: {
                ownerId: user.id,
                type: TransactionType.WITHDRAW,
                status: TransactionStatus.COMPLETED,
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
        });

        // ③ compute hoursSince, falling back to lastRace
        let hoursSince: number;
        if (last) {
            hoursSince = (Date.now() - last.createdAt.getTime()) / 36e5;
        } else if (user.lastRace) {
            hoursSince = (Date.now() - user.lastRace.getTime()) / 36e5;
        } else {
            hoursSince = 0;
        }

        const userPct = getWithdrawUserPct(hoursSince, withdrawTaxConfig);
        return {
            userPct,
            taxPct: 100 - userPct,
            hoursSinceLast: last || user.lastRace ? hoursSince : null,
        };
    }

    async itemWithdraw(ownerWallet: string, itemName: string, quantity: number) {
        if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new BadRequestException('Invalid quantity');
        }

        // 1. Validate item name and fetch tokenId + default uses
        const itemData = items[itemName];
        if (!itemData) {
            throw new BadRequestException(`Unknown item: ${itemName}`);
        }
        const tokenId = itemData.chainId;
        const withdrawTax = globals['Withdraw Tax'];
        const totalTax = withdrawTax * quantity;

        return this.prisma.$transaction(async (tx) => {
            // 2. Ensure user has enough PHORSE for tax
            const taxResult = await tx.user.updateMany({
                where: {
                    wallet: ownerWallet,
                    phorse: { gte: totalTax },
                },
                data: {
                    phorse: { decrement: totalTax },
                    totalPhorseSpent: { increment: totalTax }
                },
            });
            if (taxResult.count === 0) {
                throw new BadRequestException('Insufficient PHORSE to pay withdraw tax');
            }

            // 3. Fetch internal user ID
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) {
                throw new NotFoundException('User not found');
            }

            // 4. Build the filter: always require unequipped + matching name,
            //    and if the item is breakable, require `uses === defaultUses`.
            const whereClause: any = {
                ownerId: user.id,
                name: itemName,
                equipedBy: null,
            };
            if (itemData.breakable) {
                whereClause.breakable = true;
                whereClause.uses = itemData.uses;
            }

            // 5. Fetch up to `quantity` matching items
            const ownedItems = await tx.item.findMany({
                where: whereClause,
                select: { id: true },
                take: quantity,
            });

            if (ownedItems.length < quantity) {
                throw new BadRequestException(
                    `Not enough ${itemName}${itemData.breakable ? ` with ${itemData.uses} uses left` : ''}`
                );
            }

            // 6. Burn the items (delete them)
            await tx.item.deleteMany({
                where: { id: { in: ownedItems.map(i => i.id) } },
            });

            // 7. Create the new ItemBridgeRequest entry
            const itemRequest = await tx.itemBridgeRequest.create({
                data: {
                    requesterId: user.id,
                    request: Request.WITHDRAW,
                    quantity,
                    tokenId,
                    txId: null,
                    status: TransactionStatus.PENDING,
                },
            });

            // 8. Return request ID for tracking
            return {
                requestId: itemRequest.id,
                message: `${quantity} ${itemName} item(s) added to bridge queue!`,
            };
        });
    }


    // ------------------- DISCORD SECTION -----------------------
    async linkDiscord(wallet: string, discordId: string, discordTag: string) {
        return this.prisma.user.update({
            where: { wallet: wallet },
            data: {
                discordId,
                discordTag,
            },
        });
    }

    async getUserDiscord(wallet: string) {
        const user = await this.prisma.user.findUnique({
            where: { wallet: wallet },
            select: {
                discordId: true,
                discordTag: true,
            },
        });

        if (!user) throw new NotFoundException('User not found');
        return user;
    }

    /**
    * Create or set a unique refCode for a user.
    * @param wallet user's wallet address
    * @param custom optional custom refCode
    */
    async createRefCode(wallet: string, custom?: string) {
        return this.prisma.$transaction(async (tx) => {
            // 1. Find user
            const user = await tx.user.findUnique({
                where: { wallet },
                select: { id: true, refCode: true },
            });

            if (!user) {
                throw new NotFoundException('User not found');
            }

            // 3. Custom refCode case
            if (custom) {
                // Sanitize and validate
                const sanitized = custom.trim();
                if (sanitized.length < 3) {
                    throw new BadRequestException('Referral code must be at least 3 characters');
                }
                if (!/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
                    throw new BadRequestException(
                        'Referral code may only contain letters, numbers, hyphens, and underscores'
                    );
                }

                // Check uniqueness
                const exists = await tx.user.findUnique({
                    where: { refCode: sanitized },
                    select: { id: true },
                });

                if (exists) {
                    throw new BadRequestException('Referral code is already taken');
                }

                // Update user
                await tx.user.update({
                    where: { id: user.id },
                    data: { refCode: sanitized },
                });

                return { refCode: sanitized };
            }

            // 4. Auto-generate refCode if none provided
            let generated: string;
            let isUnique = false;

            // Try up to 5 times to avoid collisions
            for (let i = 0; i < 5 && !isUnique; i++) {
                generated = randomBytes(3).toString('hex'); // 6-char hex
                const exists = await tx.user.findUnique({
                    where: { refCode: generated },
                    select: { id: true },
                });
                if (!exists) {
                    isUnique = true;
                }
            }

            if (!isUnique) {
                throw new BadRequestException(
                    'Could not generate a unique referral code, please try again'
                );
            }

            await tx.user.update({
                where: { id: user.id },
                data: { refCode: generated! },
            });

            return { refCode: generated! };
        });
    }

    async getRefCode(wallet: string) {
        // Find user by wallet and return their referral code
        const user = await this.prisma.user.findUnique({
            where: { wallet },
            select: { refCode: true }
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        // If user doesn't have a refCode yet, return null or message
        if (!user.refCode) {
            return { refCode: null };
        }

        return { refCode: user.refCode };
    }

    async getReferralStats(wallet: string) {
        const user = await this.prisma.user.findUnique({
            where: { wallet },
            select: {
                id: true,
                xp: true,
                referralLevel: true,
                referrals: {
                    select: {
                        wallet: true,
                        updatedAt: true,
                        discordTag: true,
                        refCode: true,
                    },
                },
                referralPhorseEarned: true,
                referredBy: {
                    select: {
                        refCode: true,
                    },
                },
            },
        });

        if (!user) throw new NotFoundException('User not found');

        const { levels } = await import('./referral/level');
        const currentLevel = levels.find((lvl) => lvl.level === user.referralLevel);
        const nextLevel = levels.find((lvl) => lvl.level === user.referralLevel + 1);

        const xpForNextLevel = nextLevel
            ? nextLevel.cumulativeXP
            : currentLevel?.cumulativeXP || user.xp;

        // Build the list of referred players
        const referredPlayers = user.referrals.map((ref) => {
            // Determine the display name
            let displayName = ref.discordTag || ref.refCode || null;
            if (!displayName) {
                // fallback to wallet address (last 24 characters)
                displayName = `${ref.wallet.slice(0, 24)}...`;
            }

            let active;
            // Determine active status
            if (ref.updatedAt) {
                const lastUpdated = ref.updatedAt.getTime();
                const daysOld = (Date.now() - lastUpdated) / (1000 * 60 * 60 * 24);
                active = daysOld <= 3; // active if updatedAt is within 3 days
            } else active = false;

            return {
                displayName,
                active,
            };
        });

        return {
            totalReferrals: user.referrals.length,
            activeReferrals: referredPlayers.filter((p) => p.active).length,
            totalEarned: user.referralPhorseEarned,
            level: user.referralLevel,
            xp: user.xp,
            xpForNextLevel,
            referredByRefCode: user.referredBy?.refCode || null,
            referredPlayers, // NEW ARRAY
        };
    }


    async setReferredBy(wallet: string, refCode: string) {
        // 1. Find the referrer by refCode
        const referrer = await this.prisma.user.findUnique({
            where: { refCode },
            select: { id: true },
        });

        if (!referrer) {
            throw new NotFoundException(`Referral code "${refCode}" does not exist`);
        }

        // 2. Check the current user
        const user = await this.prisma.user.findUnique({
            where: { wallet },
            select: { id: true, referredById: true },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        // 3. Ensure the user doesn't already have a referredBy set
        if (user.referredById) {
            throw new BadRequestException('You have already been referred by someone');
        }

        // 4. Prevent self-referral
        if (user.id === referrer.id) {
            throw new BadRequestException('You cannot refer yourself');
        }

        // 5. Update user with referredById
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                referredById: referrer.id,
            },
        });

        return {
            message: `Successfully set referredBy using referral code "${refCode}"`,
        };
    }

    /**
    * Open a single "Medal Bag" for the given wallet.
    * - Concurrency-safe single-row delete (CTE + SKIP LOCKED)
    * - Only consumes unequipped bags (horseId IS NULL)
    * - Idempotent if idempotencyKey is provided
    */
    async openBag(
        ownerWallet: string,
        idempotencyKey?: string
    ): Promise<{ added: number; newMedals: number; remainingBags: number }> {
        const ITEM_NAME = 'Medal Bag';
        const MEDALS_PER_BAG = 50;

        // Basic validation
        if (!ownerWallet || typeof ownerWallet !== 'string') {
            throw new BadRequestException('Invalid wallet');
        }
        if (idempotencyKey && typeof idempotencyKey !== 'string') {
            throw new BadRequestException('Invalid idempotencyKey');
        }

        return this.prisma.$transaction(async (tx) => {
            // 1) Find user (select minimal fields)
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) throw new NotFoundException('User not found');

            // 2) If idempotencyKey provided and we already processed it, return current state
            if (idempotencyKey) {
                const existing = await tx.transaction.findFirst({
                    where: {
                        ownerId: user.id,
                        type: TransactionType.ITEM,
                        status: TransactionStatus.COMPLETED,
                        note: { contains: `[IDEMP:${idempotencyKey}]` },
                    },
                    select: { id: true },
                });
                if (existing) {
                    // Already processed once; return current medals + remaining bag count
                    const [u, remainingBags] = await Promise.all([
                        tx.user.findUnique({ where: { id: user.id }, select: { medals: true } }),
                        tx.item.count({
                            where: { ownerId: user.id, name: ITEM_NAME, horseId: null },
                        }),
                    ]);
                    return { added: MEDALS_PER_BAG, newMedals: u!.medals, remainingBags };
                }
            }

            // 3) Concurrency-safe: delete exactly ONE bag using a CTE with SKIP LOCKED
            //    This avoids double-spend under parallel requests.
            type Row = { id: string };
            const rows = await tx.$queryRaw<Row[]>`
        WITH picked AS (
          SELECT "id"
          FROM "Item"
          WHERE "ownerId" = ${user.id}
            AND "name" = ${ITEM_NAME}
            AND "horseId" IS NULL
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "Item"
        WHERE "id" IN (SELECT "id" FROM picked)
        RETURNING "id";
      `;

            // No available bag (or lost race under concurrency)
            if (!rows || rows.length === 0) {
                // If client sent an idempotencyKey that is brand-new but no bag exists, treat as 404
                throw new NotFoundException(`You do not own any "${ITEM_NAME}"`);
            }

            // 4) Credit medals
            const updatedUser = await tx.user.update({
                where: { id: user.id },
                data: { medals: { increment: MEDALS_PER_BAG } },
                select: { medals: true },
            });

            // 5) Log ITEM transaction (helps audit/idempotency)
            const note = `Opened ${ITEM_NAME} (+${MEDALS_PER_BAG} medals)${idempotencyKey ? ` [IDEMP:${idempotencyKey}]` : ''
                }`;
            await tx.transaction.create({
                data: {
                    ownerId: user.id,
                    type: TransactionType.ITEM,
                    status: TransactionStatus.COMPLETED,
                    value: 0,
                    note,
                },
            });

            // 6) Count remaining bags
            const remainingBags = await tx.item.count({
                where: { ownerId: user.id, name: ITEM_NAME, horseId: null },
            });

            return {
                added: MEDALS_PER_BAG,
                newMedals: updatedUser.medals,
                remainingBags,
            };
        }, { timeout: 10_000 }); // defensive: bound TX runtime
    }

    /**
    * Craft an item using a predefined recipe:
    * - Validates recipe exists
    * - Ensures user is authorized and has required PHORSE, MEDALS, and materials
    * - Deletes required materials (unequipped only), decrements balances
    * - Mints exactly one crafted item
    * - Idempotent when `idempotencyKey` is provided (safe retry)
    */
    async craftItem(
        ownerWallet: string,
        craftName: string,
        idempotencyKey?: string
    ): Promise<{ crafted: string; phorse: number; medals: number }> {
        // 0) Basic input validation
        if (typeof craftName !== 'string' || !craftName.trim()) {
            throw new BadRequestException('Invalid item name');
        }
        const target = craftName.trim();

        // 1) Recipe existence
        const recipe = itemCraftReq[target as keyof typeof itemCraftReq];
        if (!recipe) {
            throw new BadRequestException(`"${target}" cannot be crafted`);
        }

        // 2) Target item definition must exist in items map
        const def = (items as Record<string, any>)[target];
        if (!def) {
            throw new BadRequestException(
                `No item definition found for "${target}" (cannot craft)`
            );
        }

        // Extract currency costs and material requirements
        const phorseCost = Number(recipe.phorse ?? 0);
        const medalCost = Number(recipe.medals ?? 0);
        const materialReqs = Object.entries(recipe).filter(
            ([k]) => k !== 'phorse' && k !== 'medals'
        ) as Array<[string, number]>;

        return this.prisma.$transaction(async (tx) => {
            // 3) User auth
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) throw new NotFoundException('User not found');

            // 4) Idempotency short-circuit (if already completed)
            if (idempotencyKey) {
                const existing = await tx.transaction.findFirst({
                    where: {
                        ownerId: user.id,
                        type: TransactionType.ITEM,
                        status: TransactionStatus.COMPLETED,
                        note: { contains: `[CRAFT:${idempotencyKey}]` },
                    },
                    select: { id: true },
                });
                if (existing) {
                    // Return current balances (idempotent outcome)
                    const bal = await tx.user.findUnique({
                        where: { id: user.id },
                        select: { phorse: true, medals: true },
                    });
                    return { crafted: target, phorse: bal!.phorse, medals: bal!.medals };
                }
            }

            // 5) Guarded currency decrement (single roundtrip)
            if (phorseCost > 0 || medalCost > 0) {
                const dec = await tx.user.updateMany({
                    where: {
                        id: user.id,
                        phorse: { gte: phorseCost },
                        medals: { gte: medalCost },
                    },
                    data: {
                        ...(phorseCost > 0
                            ? { phorse: { decrement: phorseCost }, totalPhorseSpent: { increment: phorseCost } }
                            : {}),
                        ...(medalCost > 0 ? { medals: { decrement: medalCost } } : {}),
                        ...(phorseCost > 0
                            ? { presalePhorse: { decrement: phorseCost } }
                            : {}), // keep consistent with other spend paths
                    },
                });
                if (dec.count === 0) {
                    throw new BadRequestException(
                        `Insufficient funds: need ${phorseCost} PHORSE and ${medalCost} MEDALS`
                    );
                }
            }

            // 6) Consume materials with concurrency-safe CTE deletes
            //    For each distinct material: delete exactly N where horseId IS NULL
            for (const [matName, qty] of materialReqs) {
                const need = Number(qty) || 0;
                if (need <= 0) continue;

                // Raw SQL: delete top-N matching rows with SKIP LOCKED
                const rows = await tx.$queryRaw<{ id: string }[]>`
          WITH picked AS (
            SELECT "id"
            FROM "Item"
            WHERE "ownerId" = ${user.id}
              AND "name" = ${matName}
              AND "horseId" IS NULL
            ORDER BY "createdAt" ASC
            LIMIT ${need}
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM "Item"
          WHERE "id" IN (SELECT "id" FROM picked)
          RETURNING "id";
        `;

                if (!rows || rows.length !== need) {
                    // Not enough materials — revert currency decrement by throwing
                    throw new BadRequestException(
                        `Not enough "${matName}" to craft "${target}" (need ${need})`
                    );
                }
            }

            // 7) Mint the crafted item
            const created = await tx.item.create({
                data: {
                    ownerId: user.id,
                    name: target,
                    value: 1,
                    breakable: Boolean(def.breakable),
                    uses: def.breakable ? Number(def.uses) : null,
                },
                select: { id: true },
            });

            // 8) Log transaction (also stores idempotency tag)
            const note = `Crafted "${target}" (PHORSE: ${phorseCost}, MEDALS: ${medalCost})${idempotencyKey ? ` [CRAFT:${idempotencyKey}]` : ''
                }`;
            const bal = await tx.user.findUnique({
                where: { id: user.id },
                select: { phorse: true, medals: true },
            });

            await tx.transaction.create({
                data: {
                    ownerId: user.id,
                    type: TransactionType.ITEM,
                    status: TransactionStatus.COMPLETED,
                    value: 0,
                    note,
                },
            });

            return { crafted: target, phorse: bal!.phorse, medals: bal!.medals };
        }, { timeout: 10_000 });
    }
}
