import {
    Injectable,
    ForbiddenException,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { AssignHorseDto, CreateDerbyDto, RemoveHorseDto } from './derby.dto';
import { PvpRaceStatus } from '@prisma/client';
import { addMinutes, isBefore } from 'date-fns';
import { PrismaService } from 'src/prisma/prisma.service';
import { itemModifiers } from 'src/data/items';

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
            '0xD48Aad987e8400e0411486C14b56A0Bf357DaFBc'
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
            return entries.map((e) => ({ horseId: e.horseId, mmrAfter: e.mmr }));
        }

        const K = 32; // tuning param

        // --- NEW: detect if all MMRs are equal ---
        const firstMmr = entries[0].mmr;
        const allEqual = entries.every((e) => e.mmr === firstMmr);

        if (allEqual) {
            // Everyone is equally rated -> same expected position (middle)
            const expectedPos = (n + 1) / 2; // e.g. 2 in a 3-horse race
            return entries.map((entry) => {
                const actual = entry.position;
                const delta = Math.round((K * (expectedPos - actual)) / (n - 1));
                const mmrAfter = Math.max(0, entry.mmr + delta);
                return { horseId: entry.horseId, mmrAfter };
            });
        }

        // --- original logic if ratings are not all equal ---
        const sortedByMmr = [...entries].sort((a, b) => b.mmr - a.mmr); // best first
        const expectedPositionByHorseId = new Map<string, number>();
        sortedByMmr.forEach((e, idx) => {
            expectedPositionByHorseId.set(e.horseId, idx + 1);
        });

        return entries.map((entry) => {
            const expected = expectedPositionByHorseId.get(entry.horseId) ?? (n + 1) / 2;
            const actual = entry.position;
            const delta = Math.round((K * (expected - actual)) / (n - 1));
            const mmrAfter = Math.max(0, entry.mmr + delta);
            return { horseId: entry.horseId, mmrAfter };
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
            const existingEntry = await tx.pvpRaceEntry.findFirst({
                where: { raceId: race.id, userId, isActive: true },
            });
            if (existingEntry) {
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

            const entry = await tx.pvpRaceEntry.create({
                data: {
                    raceId: race.id,
                    horseId: horse.id,
                    userId,
                    mmrAtEntry: horse.mmr,
                    isActive: true,
                },
            });

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
            if (activeEntries.length === 0) {
                // No entries, just mark as completed
                await tx.pvpRace.update({
                    where: { id: race.id },
                    data: { status: PvpRaceStatus.COMPLETED },
                });
                return { race, history: [] };
            }

            // --- Determine positions (stats + luck) -----------------------------
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

            // --- Compute WRON prize pool ----------------------------------------
            const totalEntries = activeEntries.length;
            const totalWrOnFees = totalEntries * race.wronEntryFee;
            const allocatedPrize = totalWrOnFees * (race.wronPayoutPercent / 100);

            const firstPrize = allocatedPrize * race.pctFirst;
            const secondPrize = allocatedPrize * race.pctSecond;
            const thirdPrize = allocatedPrize * race.pctThird;

            // --- Determine MMR changes -----------------------------------------
            const mmrInputs = ranked.map((r) => ({
                horseId: r.entry.horseId,
                mmr: r.entry.horse.mmr,
                position: r.position,
            }));

            const mmrUpdates = this.computeMmrUpdates(mmrInputs);
            const mmrAfterByHorseId = new Map<string, number>();
            mmrUpdates.forEach((u) => mmrAfterByHorseId.set(u.horseId, u.mmrAfter));

            // --- Apply prizes & create history rows -----------------------------
            for (const r of ranked) {
                const horse = r.entry.horse;
                const user = r.entry.user;

                let prize = 0;
                if (r.position === 1) prize = firstPrize;
                else if (r.position === 2) prize = secondPrize;
                else if (r.position === 3) prize = thirdPrize;

                const mmrBefore = horse.mmr;
                const mmrAfter = mmrAfterByHorseId.get(horse.id) ?? mmrBefore;

                // Update user WRON (only prize; fees were deducted at registration)
                if (prize > 0) {
                    await tx.user.update({
                        where: { id: user.id },
                        data: {
                            wron: { increment: prize },
                        },
                    });
                }

                // Update horse MMR
                await tx.horse.update({
                    where: { id: horse.id },
                    data: { mmr: mmrAfter },
                });

                // Create history record
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

            // Mark race as completed
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


}
