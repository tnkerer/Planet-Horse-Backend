import {
    Injectable,
    ForbiddenException,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { AssignHorseDto, CreateDerbyDto, HorseOdds, RemoveHorseDto } from './derby.dto';
import { PvpRaceStatus, TransactionType, TransactionStatus } from '@prisma/client';
import { addMinutes, isBefore } from 'date-fns';
import { PrismaService } from 'src/prisma/prisma.service';
import { itemModifiers } from 'src/data/items';
import { DerbyOddsResponse } from './derby.dto'

type HorseEquipSnapshot = {
    currentPower: number;
    currentSprint: number;
    currentSpeed: number;
    equipments: { name: string }[];
};

@Injectable()
export class DerbyService {
    private readonly derbyAdminWallets: string[];

    constructor(private readonly prisma: PrismaService) {
        this.derbyAdminWallets = (
            '0xD48Aad987e8400e0411486C14b56A0Bf357DaFBc, 0xf293628f6669Cb443148d877F022d62B7b7093D2, 0xC304355430b4bDefC85F391F428739903B0EBE66, 0x84F70cF2704D33A35d3dE3201FB6C331DD4Dc2d5, 0x163ad77bba3A5E5f9Daaa4E60A5258c21F5062aa, 0x8509C1A3E6EDe978988E66d7366B5feD064ae2E3'
        )
            .split(',')
            .map((w) => w.trim().toLowerCase())
            .filter(Boolean);
    }

    // --- Helpers -------------------------------------------------------------

    private getItemStatBonus(equipments: { name: string }[]) {
        let extraSpd = 0;
        let extraSpt = 0;
        let extraPwr = 0;

        for (const item of equipments) {
            const mod = itemModifiers[item.name];
            if (!mod) continue;

            if (typeof mod.extraSpd === 'number') extraSpd += mod.extraSpd;
            if (typeof mod.extraSpt === 'number') extraSpt += mod.extraSpt;
            if (typeof mod.extraPwr === 'number') extraPwr += mod.extraPwr;
        }

        return { extraSpd, extraSpt, extraPwr };
    }


    public isDerbyAdmin(walletRaw?: string | null): boolean {
        if (!walletRaw) return false;
        const wallet = walletRaw.toLowerCase();
        return this.derbyAdminWallets.includes(wallet);
    }

    /**
     * Check if a wallet is in the derby admin allowlist.
     */
    private async assertAdmin(walletRaw: string): Promise<void> {
        if (!walletRaw) {
            throw new ForbiddenException('Missing wallet');
        }
        const wallet = walletRaw.toLowerCase();
        if (!this.derbyAdminWallets.includes(wallet)) {
            throw new ForbiddenException('Only derby admins can perform this action');
        }
    }

    private ensureRaceOpenForRegistration(race: any) {
        if (race.status !== PvpRaceStatus.OPEN) {
            throw new BadRequestException('Derby is not open for registration');
        }
        const now = new Date();
        const regOpen = race.registrationOpensAt as Date;
        const startsAt = race.startsAt as Date;

        if (isBefore(now, regOpen)) {
            throw new BadRequestException('Registration has not opened yet');
        }
        if (!isBefore(now, startsAt)) {
            throw new BadRequestException('Registration period has ended');
        }
    }

    private ensureRaceOpenForBetting(race: any) {
        this.ensureRaceOpenForRegistration(race);
    }

    // Simple score function: base stats + luck
    private computeHorseScore(horse: HorseEquipSnapshot): number {
        const { extraSpd, extraSpt, extraPwr } = this.getItemStatBonus(
            horse.equipments,
        );

        const effectivePower = horse.currentPower + extraPwr;
        const effectiveSprint = horse.currentSprint + extraSpt;
        const effectiveSpeed = horse.currentSpeed + extraSpd;

        const statSum = effectivePower + effectiveSprint + effectiveSpeed;

        // Luck scaled by total effective stats
        const luck = Math.random() * statSum;

        return statSum + luck;
    }

    // Very simple MMR update based on expected vs actual placement.
    private computeMmrUpdates(entries: { horseId: string; mmr: number; position: number }[]) {
        const n = entries.length;
        if (n <= 1) {
            return entries.map(e => ({ horseId: e.horseId, mmrAfter: e.mmr }));
        }

        const K = n * 3; // main tuning knob — keeps ±32 range for top/bottom regardless of N

        // Normalize: position 1 = best, position n = worst
        // ActualScore = 1.0 for winner, 0.0 for last, linear in between
        const actualScore = (pos: number) => (n - pos) / (n - 1);

        // Expected score vs every other horse (Elo)
        const expectedScore = (mmr_i: number, idx_i: number) => {
            let sum = 0;

            for (let j = 0; j < n; j++) {
                if (j === idx_i) continue;
                const mmr_j = entries[j].mmr;

                // Elo expected value of i beating j
                const e_ij = 1 / (1 + Math.pow(10, (mmr_j - mmr_i) / 400));
                sum += e_ij;
            }

            return sum / (n - 1);
        };

        return entries.map((entry, idx) => {
            const A = actualScore(entry.position);
            const E = expectedScore(entry.mmr, idx);
            const delta = Math.round(K * (A - E));

            return {
                horseId: entry.horseId,
                mmrAfter: Math.max(0, entry.mmr + delta),
            };
        });
    }

    // --- Public API ----------------------------------------------------------

    // 1. Create Derby (admin only)
    async createDerby(adminWallet: string, dto: CreateDerbyDto) {
        await this.assertAdmin(adminWallet);

        const registrationOpensAt = new Date(dto.registrationOpensAt);
        const startsAt = new Date(dto.startsAt);

        if (!isBefore(registrationOpensAt, startsAt)) {
            throw new BadRequestException('registrationOpensAt must be before startsAt');
        }

        if (!dto.allowedRarities || dto.allowedRarities.length === 0) {
            throw new BadRequestException('At least one rarity must be allowed');
        }

        const race = await this.prisma.pvpRace.create({
            data: {
                name: dto.name,
                description: dto.description,
                registrationOpensAt,
                startsAt,
                maxMmr: dto.maxMmr ?? null,
                maxParticipants: dto.maxParticipants ?? null,
                allowedRarities: dto.allowedRarities,
                wronEntryFee: dto.wronEntryFee ?? 0,
                phorseEntryFee: dto.phorseEntryFee ?? 0,
                wronPayoutPercent: dto.wronPayoutPercent ?? 0,
                // pctFirst/Second/Third default values already set in schema
            },
        });

        return race;
    }

    // 2. Assign Horse (join derby)
    async assignHorseToDerby(userWallet: string, derbyId: string, dto: AssignHorseDto) {
        return this.prisma.$transaction(async (tx) => {
            // Resolve user by wallet first
            const user = await tx.user.findUnique({
                where: { wallet: userWallet },
                select: { id: true, phorse: true, wron: true },
            });

            if (!user) {
                throw new NotFoundException('User not found for this wallet');
            }

            const userId = user.id;

            const race = await tx.pvpRace.findUnique({
                where: { id: derbyId },
                include: {
                    entries: {
                        where: { isActive: true },
                        select: { id: true },
                    },
                },
            });

            if (!race) throw new NotFoundException('Derby not found');

            this.ensureRaceOpenForRegistration(race);

            // Max participants
            if (race.maxParticipants && race.entries.length >= race.maxParticipants) {
                throw new BadRequestException('Derby is full');
            }

            // Check if user already has an active entry (DB also enforces, but nicer error)
            const existingEntryAny = await tx.pvpRaceEntry.findFirst({
                where: { raceId: race.id, userId },
            });

            if (existingEntryAny?.isActive) {
                // still active → keep same behavior
                throw new BadRequestException('User already has a horse in this derby');
            }

            const horse = await tx.horse.findUnique({
                where: { tokenId: dto.horseId },
                select: {
                    id: true,
                    ownerId: true,
                    rarity: true,
                    mmr: true,
                },
            });

            if (!horse) {
                throw new ForbiddenException('You do not own this horse');
            }

            if (!race.allowedRarities.includes(horse.rarity)) {
                throw new BadRequestException('Horse rarity not allowed for this derby');
            }

            if (race.maxMmr !== null && horse.mmr > race.maxMmr) {
                throw new BadRequestException('Horse MMR exceeds maximum allowed for this derby');
            }

            // Check balances using resolved user
            if (user.wron < race.wronEntryFee) {
                throw new BadRequestException('Insufficient WRON for entry fee');
            }
            if (user.phorse < race.phorseEntryFee) {
                throw new BadRequestException('Insufficient PHORSE for entry fee');
            }

            // Deduct balances and create entry atomically
            await tx.user.update({
                where: { id: userId },
                data: {
                    wron: { decrement: race.wronEntryFee },
                    phorse: { decrement: race.phorseEntryFee }, // burned
                },
            });

            // 🔹 Track derby join fees (WRON + PHORSE)
            if (race.wronEntryFee > 0) {
                await tx.transaction.create({
                    data: {
                        ownerId: userId,
                        type: TransactionType.BURN, // fee / sink
                        status: TransactionStatus.COMPLETED,
                        value: race.wronEntryFee,
                        note: `DERBY_ENTRY_WRON:${race.id}`,
                        tokenSymbol: 'WRON',
                    },
                });
            }

            if (race.phorseEntryFee > 0) {
                await tx.transaction.create({
                    data: {
                        ownerId: userId,
                        type: TransactionType.BURN, // PHORSE is actually burned
                        status: TransactionStatus.COMPLETED,
                        value: race.phorseEntryFee,
                        note: `DERBY_ENTRY_PHORSE:${race.id}`,
                        tokenSymbol: 'PHORSE',
                    },
                });
            }

            let entry;

            // If there is an inactive row, re-use it to avoid unique-constraint issues
            if (existingEntryAny && !existingEntryAny.isActive) {
                entry = await tx.pvpRaceEntry.update({
                    where: { id: existingEntryAny.id },
                    data: {
                        horseId: horse.id,
                        mmrAtEntry: horse.mmr,
                        isActive: true,
                    },
                });
            } else {
                // no row yet → create as usual
                entry = await tx.pvpRaceEntry.create({
                    data: {
                        raceId: race.id,
                        horseId: horse.id,
                        userId,
                        mmrAtEntry: horse.mmr,
                        isActive: true,
                    },
                });
            }

            return entry;

        });
    }

    // 3. Remove Horse (unregister before derby starts - 30m)
    async removeHorseFromDerby(userWallet: string, derbyId: string, dto: RemoveHorseDto) {
        return this.prisma.$transaction(async (tx) => {
            // Resolve user by wallet first
            const user = await tx.user.findUnique({
                where: { wallet: userWallet },
                select: { id: true },
            });

            if (!user) {
                throw new NotFoundException('User not found for this wallet');
            }

            const userId = user.id;

            const race = await tx.pvpRace.findUnique({
                where: { id: derbyId },
            });

            if (!race) throw new NotFoundException('Derby not found');

            const now = new Date();
            const latestLeaveTime = addMinutes(race.startsAt, -30);

            if (!isBefore(now, latestLeaveTime)) {
                throw new BadRequestException(
                    'Too late to withdraw from this derby (less than 30 minutes)',
                );
            }
            if (race.status !== PvpRaceStatus.OPEN) {
                throw new BadRequestException('Derby is not open for withdrawals');
            }

            const entry = await tx.pvpRaceEntry.findFirst({
                where: {
                    raceId: race.id,
                    userId,
                    horseId: dto.horseId,
                    isActive: true,
                },
            });

            if (!entry) {
                throw new NotFoundException('No active entry for this horse in this derby');
            }

            // Refund fees (PHORSE is "unburned" here since derby didn’t happen yet)
            await tx.user.update({
                where: { id: userId },
                data: {
                    wron: { increment: race.wronEntryFee },
                    phorse: { increment: race.phorseEntryFee },
                },
            });

            await tx.pvpRaceEntry.update({
                where: { id: entry.id },
                data: { isActive: false },
            });

            return { success: true };
        });
    }

    // 4. View Derby History for a horse
    async getDerbyHistoryForHorse(horseId: string) {
        const history = await this.prisma.pvpHistory.findMany({
            where: { horseId },
            orderBy: { createdAt: 'desc' },
            include: {
                race: true,
            },
        });

        return history;
    }

    // 5. Finalize Derby (anyone can call)
    async finalizeDerby(derbyId: string) {
        const now = new Date();

        return this.prisma.$transaction(async (tx) => {
            // 🔒 Idempotency / concurrency guard:
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${derbyId}))`;

            const race = await tx.pvpRace.findUnique({
                where: { id: derbyId },
                include: {
                    entries: {
                        where: { isActive: true },
                        include: {
                            horse: {
                                include: {
                                    equipments: true,
                                },
                            },
                            user: true,
                        },
                    },
                    bets: {
                        include: {
                            user: true,
                        },
                    },
                },
            });

            if (!race) throw new NotFoundException('Derby not found');

            if (
                race.status === PvpRaceStatus.COMPLETED ||
                race.status === PvpRaceStatus.CANCELLED
            ) {
                const history = await tx.pvpHistory.findMany({
                    where: { raceId: race.id },
                    orderBy: { position: 'asc' },
                    include: {
                        horse: true,
                        user: {
                            select: {
                                id: true,
                                wallet: true,
                                discordTag: true,
                            },
                        },
                    },
                });
                return { race, history };
            }

            if (isBefore(now, race.startsAt)) {
                throw new BadRequestException('Derby has not started yet');
            }

            const activeEntries = race.entries;

            // ------------------- CANCELLED CASE (< 5 entries) -------------------
            if (activeEntries.length < 5) {
                // Refund entry fees
                for (const entry of activeEntries) {
                    await tx.user.update({
                        where: { id: entry.user.id },
                        data: {
                            wron: { increment: race.wronEntryFee },
                            phorse: { increment: race.phorseEntryFee },
                        },
                    });

                    if (race.wronEntryFee > 0) {
                        await tx.transaction.create({
                            data: {
                                ownerId: entry.user.id,
                                type: TransactionType.DEPOSIT,
                                status: TransactionStatus.COMPLETED,
                                value: race.wronEntryFee,
                                note: `DERBY_REFUND_WRON:${race.id}`,
                                tokenSymbol: 'WRON',
                            },
                        });
                    }

                    if (race.phorseEntryFee > 0) {
                        await tx.transaction.create({
                            data: {
                                ownerId: entry.user.id,
                                type: TransactionType.DEPOSIT,
                                status: TransactionStatus.COMPLETED,
                                value: race.phorseEntryFee,
                                note: `DERBY_REFUND_PHORSE:${race.id}`,
                                tokenSymbol: 'PHORSE',
                            },
                        });
                    }

                    await tx.pvpRaceEntry.update({
                        where: { id: entry.id },
                        data: { isActive: false },
                    });
                }

                // Refund ALL bets fully if derby cancelled
                for (const bet of race.bets) {
                    await tx.user.update({
                        where: { id: bet.userId },
                        data: {
                            wron: { increment: bet.amount },
                        },
                    });

                    await tx.transaction.create({
                        data: {
                            ownerId: bet.userId,
                            type: TransactionType.DEPOSIT,
                            status: TransactionStatus.COMPLETED,
                            value: bet.amount,
                            note: `DERBY_BET_REFUND:${race.id}:${bet.horseId}`,
                            tokenSymbol: 'WRON',
                        },
                    });
                }

                const cancelledRace = await tx.pvpRace.update({
                    where: { id: race.id },
                    data: {
                        status: PvpRaceStatus.CANCELLED,
                        bettingPoolWron: 0,
                        totalBetWron: 0,
                    },
                });

                return { race: cancelledRace, history: [] };
            }

            // ------------------- NORMAL COMPLETION CASE ------------------------
            // Determine positions (stats + luck)
            const scoring = activeEntries.map((entry) => ({
                entry,
                score: this.computeHorseScore({
                    currentPower: entry.horse.currentPower,
                    currentSprint: entry.horse.currentSprint,
                    currentSpeed: entry.horse.currentSpeed,
                    equipments: entry.horse.equipments ?? [],
                }),
            }));

            scoring.sort((a, b) => b.score - a.score); // best score first

            const ranked = scoring.map((s, idx) => ({
                entry: s.entry,
                position: idx + 1,
            }));

            // Compute WRON prize pool for race entry fees (existing logic)
            const totalEntries = activeEntries.length;
            const totalWrOnFees = totalEntries * race.wronEntryFee;
            const allocatedPrize = totalWrOnFees * (race.wronPayoutPercent / 100);

            const firstPrize = allocatedPrize * race.pctFirst;
            const secondPrize = allocatedPrize * race.pctSecond;
            const thirdPrize = allocatedPrize * race.pctThird;

            // Determine MMR changes
            const mmrInputs = ranked.map((r) => ({
                horseId: r.entry.horseId,
                mmr: r.entry.horse.mmr,
                position: r.position,
            }));

            const mmrUpdates = this.computeMmrUpdates(mmrInputs);
            const mmrAfterByHorseId = new Map<string, number>();
            mmrUpdates.forEach((u) => mmrAfterByHorseId.set(u.horseId, u.mmrAfter));

            // ------------- Apply entry-fee prizes & create history rows ---------
            for (const r of ranked) {
                const horse = r.entry.horse;
                const user = r.entry.user;

                let prize = 0;
                if (r.position === 1) prize = firstPrize;
                else if (r.position === 2) prize = secondPrize;
                else if (r.position === 3) prize = thirdPrize;

                const mmrBefore = horse.mmr;
                const mmrAfter = mmrAfterByHorseId.get(horse.id) ?? mmrBefore;

                if (prize > 0) {
                    await tx.user.update({
                        where: { id: user.id },
                        data: {
                            wron: { increment: prize },
                        },
                    });

                    await tx.transaction.create({
                        data: {
                            ownerId: user.id,
                            type: TransactionType.DEPOSIT,
                            status: TransactionStatus.COMPLETED,
                            value: prize,
                            note: `DERBY_PRIZE:${race.id}:position:${r.position}`,
                            tokenSymbol: 'WRON',
                        },
                    });
                }

                await tx.horse.update({
                    where: { id: horse.id },
                    data: { mmr: mmrAfter },
                });

                await tx.pvpHistory.create({
                    data: {
                        raceId: race.id,
                        horseId: horse.id,
                        userId: user.id,
                        position: r.position,
                        mmrBefore,
                        mmrAfter,
                        wronPrize: prize,
                        phorseBurned: race.phorseEntryFee,
                    },
                });
            }

            // ------------- Betting payouts (only if there are bets) ------------
            if (race.bets.length > 0 && race.bettingPoolWron > 0) {
                const winningHorseId = ranked[0].entry.horseId;
                const winningBets = race.bets.filter(
                    (b) => b.horseId === winningHorseId,
                );

                if (winningBets.length > 0) {
                    const totalWinningStake = winningBets.reduce(
                        (sum, b) => sum + b.amount,
                        0,
                    );

                    if (totalWinningStake > 0) {
                        const pool = race.bettingPoolWron;

                        for (const bet of winningBets) {
                            const share = bet.amount / totalWinningStake;
                            const payout = pool * share;

                            if (payout <= 0) continue;

                            await tx.user.update({
                                where: { id: bet.userId },
                                data: {
                                    wron: { increment: payout },
                                },
                            });

                            await tx.transaction.create({
                                data: {
                                    ownerId: bet.userId,
                                    type: TransactionType.DEPOSIT,
                                    status: TransactionStatus.COMPLETED,
                                    value: payout,
                                    note: `DERBY_BET_PRIZE:${race.id}:${winningHorseId}`,
                                    tokenSymbol: 'WRON',
                                },
                            });
                        }
                    }
                }
                // if no one bet on the winner, pool is effectively house edge
            }

            const updatedRace = await tx.pvpRace.update({
                where: { id: race.id },
                data: { status: PvpRaceStatus.COMPLETED },
            });

            const history = await tx.pvpHistory.findMany({
                where: { raceId: race.id },
                orderBy: { position: 'asc' },
                include: {
                    horse: true,
                    user: {
                        select: {
                            id: true,
                            wallet: true,
                            discordTag: true,
                        },
                    },
                },
            });

            return { race: updatedRace, history };
        });
    }

    // Optional: list active/open derbies
    async listOpenDerbies() {
        return this.prisma.pvpRace.findMany({
            where: { status: PvpRaceStatus.OPEN },
            orderBy: { startsAt: 'asc' },
        });
    }

    async listAllDerbies() {
        return this.prisma.pvpRace.findMany({
            orderBy: { startsAt: 'asc' },
        });
    }

    async getDerbyById(id: string) {
        const race = await this.prisma.pvpRace.findUnique({
            where: { id },
            include: {
                entries: {
                    where: { isActive: true },
                    include: {
                        horse: true,
                        user: true,
                    },
                },
            },
        });

        if (!race) {
            throw new NotFoundException('Derby not found');
        }

        const history = await this.prisma.pvpHistory.findMany({
            where: { raceId: id },
            orderBy: { position: 'asc' },
            include: {
                horse: true,
                user: {
                    select: {
                        id: true,
                        wallet: true,
                        discordTag: true,
                    },
                },
            },
        });

        return { ...race, history };
    }


    // --- Betting: place a bet on a horse -----------------------------------
    async placeBet(
        userWallet: string,
        derbyId: string,
        horseId: string,
        amount: number,
    ) {
        if (!amount || amount <= 0) {
            throw new BadRequestException('Bet amount must be greater than zero');
        }

        return this.prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({
                where: { wallet: userWallet },
                select: { id: true, wron: true },
            });

            if (!user) {
                throw new NotFoundException('User not found for this wallet');
            }

            const race = await tx.pvpRace.findUnique({
                where: { id: derbyId },
                include: {
                    entries: {
                        where: { isActive: true },
                        select: { horseId: true },
                    },
                    bets: {
                        where: { userId: user.id },
                        select: { horseId: true },
                    },
                },
            });

            if (!race) throw new NotFoundException('Derby not found');

            this.ensureRaceOpenForBetting(race);

            // Horse must be participating in this derby
            const isHorseInRace = race.entries.some((e) => e.horseId === horseId);
            if (!isHorseInRace) {
                throw new BadRequestException('This horse is not registered in the derby');
            }

            // Only one bet per user per horse per race
            const hasExistingBet = race.bets.some((b) => b.horseId === horseId);
            if (hasExistingBet) {
                throw new BadRequestException('You already placed a bet on this horse');
            }

            if (user.wron < amount) {
                throw new BadRequestException('Insufficient WRON to place this bet');
            }

            // Deduct WRON from user
            await tx.user.update({
                where: { id: user.id },
                data: {
                    wron: { decrement: amount },
                },
            });

            // Log stake as a BURN (from player POV, it is spent)
            await tx.transaction.create({
                data: {
                    ownerId: user.id,
                    type: TransactionType.BURN,
                    status: TransactionStatus.COMPLETED,
                    value: amount,
                    note: `DERBY_BET_STAKE:${race.id}:${horseId}`,
                    tokenSymbol: 'WRON',
                },
            });

            const poolContribution = amount * 0.8; // 80% goes to betting pool

            // Create bet row
            const bet = await tx.pvpBet.create({
                data: {
                    raceId: race.id,
                    userId: user.id,
                    horseId,
                    amount,
                },
            });

            // Update aggregates on race
            await tx.pvpRace.update({
                where: { id: race.id },
                data: {
                    totalBetWron: { increment: amount },
                    bettingPoolWron: { increment: poolContribution },
                },
            });

            return bet;
        });
    }

    // --- Betting: get current odds & potential payouts ---------------------
    async getDerbyOdds(
        derbyId: string,
        userWallet?: string,
    ): Promise<DerbyOddsResponse> {
        const race = await this.prisma.pvpRace.findUnique({
            where: { id: derbyId },
            include: {
                bets: {
                    include: {
                        user: true,
                    },
                },
            },
        });

        if (!race) throw new NotFoundException('Derby not found');

        // If derby already cancelled, just return empty odds
        if (race.status === PvpRaceStatus.CANCELLED) {
            return {
                raceId: race.id,
                totalStaked: 0,
                poolAmount: 0,
                horses: [],
            };
        }

        const totalStaked = race.bets.reduce((sum, b) => sum + b.amount, 0);
        const poolAmount =
            race.bettingPoolWron && race.bettingPoolWron > 0
                ? race.bettingPoolWron
                : totalStaked * 0.8;

        const oddsByHorse = new Map<
            string,
            { total: number; userStake: number }
        >();

        const userId =
            userWallet && userWallet.length
                ? (
                    await this.prisma.user.findUnique({
                        where: { wallet: userWallet },
                        select: { id: true },
                    })
                )?.id
                : undefined;

        for (const bet of race.bets) {
            const key = bet.horseId;
            const rec = oddsByHorse.get(key) || { total: 0, userStake: 0 };
            rec.total += bet.amount;
            if (userId && bet.userId === userId) {
                rec.userStake += bet.amount;
            }
            oddsByHorse.set(key, rec);
        }

        const horses: HorseOdds[] = [];

        for (const [horseId, { total, userStake }] of oddsByHorse.entries()) {
            if (total <= 0 || poolAmount <= 0) {
                horses.push({
                    horseId,
                    totalStaked: total,
                    oddsMultiplier: null,
                    ...(userStake > 0
                        ? { userStake, userPotentialPayout: userStake }
                        : {}),
                });
                continue;
            }

            const oddsMultiplier = poolAmount / total;
            const h: HorseOdds = {
                horseId,
                totalStaked: total,
                oddsMultiplier,
            };

            if (userStake > 0) {
                h.userStake = userStake;
                h.userPotentialPayout = userStake * oddsMultiplier;
            }

            horses.push(h);
        }

        return {
            raceId: race.id,
            totalStaked,
            poolAmount,
            horses,
        };
    }

}
