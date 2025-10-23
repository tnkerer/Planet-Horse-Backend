import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
import { rarityBase } from 'src/data/rarity_base';

type Rarity = 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'MYTHIC';
type OracleResp = {
    symbol: 'PHORSE';
    usdPriceFormatted: string;
    updatedAt: string;
    source: 'moralis';
    cached: boolean;
};

const ALLOWED_GENE_IDS = new Set<number>([17000, 17001, 17002]);
const GENE_ID_TO_NAME: Record<number, string> = {
    17000: 'Power Genes',
    17001: 'Speed Genes',
    17002: 'Sprint Genes',
};
const GENE_ID_TO_BASE: Record<number, 'basePower' | 'baseSpeed' | 'baseSprint'> = {
    17000: 'basePower',
    17001: 'baseSpeed',
    17002: 'baseSprint',
};

type StableSalePreflightResponse = {
    eligible: boolean;
    reasons: string[];
    sale: {
        gtd: boolean;
        fcfs: boolean;
        discount: number;
        gtdUsed: boolean;
        fcfsUsed: boolean;
        discountList: string[];
    };
    // convenience flags for the client UI
    canUseGtd: boolean;
    canUseFcfs: boolean;
    hasDiscount: boolean;          // has a non-zero discount configured
    discountEligible: boolean;     // discountList contains this wallet (case-insensitive)
    discountPct: number;           // same as sale.discount
};

@Injectable()
export class UserService {
    constructor(private readonly prisma: PrismaService, private readonly horseService: HorseService) { }

    /**
    * Finds or creates (idempotently) the StableSale row for a given wallet,
    * then evaluates the *current* eligibility without mutating any "Used" flags.
    */
    async preflight(wallet: string): Promise<StableSalePreflightResponse> {
        const normalized = wallet.trim().toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
            throw new BadRequestException('Wallet must be a valid EVM address');
        }

        // 1) Find user
        const user = await this.prisma.user.findUnique({
            where: { wallet: normalized },
            select: { id: true, wallet: true },
        });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // 2) Ensure StableSale row exists (idempotent)
        const sale = await this.prisma.stableSale.upsert({
            where: { userId: user.id },
            update: {},
            create: {
                userId: user.id,
                // defaults follow your schema:
                // gtd: false, fcfs: false, discount: 0, gtdUsed: false, fcfsUsed: false, discountList: []
            },
            select: {
                gtd: true,
                fcfs: true,
                discount: true,
                gtdUsed: true,
                fcfsUsed: true,
                discountList: true,
            },
        });

        // 3) Compute eligibility snapshot (read-only)
        const reasons: string[] = [];

        const canUseGtd = Boolean(sale.gtd) && !sale.gtdUsed;
        if (!canUseGtd) {
            if (!sale.gtd) reasons.push('GTD not assigned');
            else if (sale.gtdUsed) reasons.push('GTD already used');
        }

        const canUseFcfs = Boolean(sale.fcfs) && !sale.fcfsUsed;
        if (!canUseFcfs) {
            if (!sale.fcfs) reasons.push('FCFS not assigned');
            else if (sale.fcfsUsed) reasons.push('FCFS already used');
        }

        const hasDiscount = (sale.discount ?? 0) > 0;
        const discountEligible = hasDiscount
            ? this.includesAddressCaseInsensitive(sale.discountList ?? [], normalized)
            : false;

        if (hasDiscount && !discountEligible) {
            reasons.push('Wallet not included in the discount list');
        }
        if (!hasDiscount) {
            reasons.push('No discount configured');
        }

        const eligible = canUseGtd || canUseFcfs || (hasDiscount && discountEligible);

        return {
            eligible,
            reasons,
            sale: {
                gtd: sale.gtd,
                fcfs: sale.fcfs,
                discount: sale.discount,
                gtdUsed: sale.gtdUsed,
                fcfsUsed: sale.fcfsUsed,
                discountList: sale.discountList ?? [],
            },
            canUseGtd,
            canUseFcfs,
            hasDiscount,
            discountEligible,
            discountPct: sale.discount ?? 0,
        };
    }

    private includesAddressCaseInsensitive(list: string[], addr: string) {
        if (!Array.isArray(list) || list.length === 0) return false;
        const needle = addr.toLowerCase();
        return list.some((x) => (x || '').toLowerCase() === needle);
    }

    // --- Moralis config (simple & explicit) ---
    private readonly PHORSE_ADDR =
        '0x6ad39689cac97a3e647fabd31534555bc7edd5c6';
    private readonly MORALIS_URL = `https://deep-index.moralis.io/api/v2.2/erc20/${this.PHORSE_ADDR}/price?chain=ronin`;

    // --- ultra-simple in-memory cache (avoid hammering & 500s) ---
    private oracleCache: OracleResp | null = null;
    private oracleCacheAt = 0;
    private readonly ORACLE_TTL_MS = 30_000; // 30s


    async breedHorsesByTokenIds(
        tokenIdA: string,
        tokenIdB: string,
        geneA?: number | null,
        geneB?: number | null,
    ) {
        if (!tokenIdA || !tokenIdB) {
            throw new BadRequestException('Both token IDs are required');
        }
        if (tokenIdA === tokenIdB) {
            throw new BadRequestException('Use two distinct parents');
        }

        const isNumeric = (s: string) => /^\d+$/.test(s);
        if (!isNumeric(tokenIdA) || !isNumeric(tokenIdB)) {
            throw new BadRequestException('Breeding requires numeric tokenIds');
        }
        const numA = Number(tokenIdA);
        const numB = Number(tokenIdB);

        // ── NEW: validate optional genes (max 2, allowed set, no duplicates)
        const requestedGenes = [geneA ?? null, geneB ?? null].filter(
            (g): g is number => g != null
        );

        if (requestedGenes.length > 2) {
            throw new BadRequestException('You can use up to two genes');
        }
        for (const gid of requestedGenes) {
            if (!ALLOWED_GENE_IDS.has(gid)) {
                throw new BadRequestException(`Unsupported gene id: ${gid}`);
            }
        }
        // no duplicates per request (mirrors no duplicate per stud)
        if (requestedGenes.length === 2 && requestedGenes[0] === requestedGenes[1]) {
            throw new BadRequestException('Duplicate gene not allowed');
        }

        // Fetch both parents in one roundtrip
        const parents = await this.prisma.horse.findMany({
            where: { tokenId: { in: [tokenIdA, tokenIdB] } },
            select: {
                id: true, tokenId: true, ownerId: true, sex: true, status: true, rarity: true, name: true,
                level: true, currentBreeds: true, ownedSince: true, gen: true,
                basePower: true, baseSprint: true, baseSpeed: true,
                parents: true,
                maxBreeds: true,
                stableid: true,
            },
        });

        if (parents.length !== 2) {
            const found = new Set(parents.map(p => p.tokenId));
            const missing = [tokenIdA, tokenIdB].filter(t => !found.has(t));
            throw new NotFoundException(`Parent(s) not found: ${missing.join(', ')}`);
        }

        const [p1, p2] = parents;

        if (!p1.stableid || !p2.stableid) {
            throw new BadRequestException('Both parents must be housed in a Stable to breed');
        }
        // Same owner
        if (p1.ownerId !== p2.ownerId) {
            throw new BadRequestException('Both parents must share the same owner');
        }

        // Sex check
        const hasMale = p1.sex === 'MALE' || p2.sex === 'MALE';
        const hasFemale = p1.sex === 'FEMALE' || p2.sex === 'FEMALE';
        if (!hasMale || !hasFemale) {
            throw new BadRequestException('Parents must be one MALE and one FEMALE');
        }
        const male = p1.sex === 'MALE' ? p1 : p2;
        const female = p1.sex === 'FEMALE' ? p1 : p2;

        // Status = IDLE
        if (p1.status !== 'IDLE' || p2.status !== 'IDLE') {
            throw new BadRequestException('Both parents must be IDLE');
        }

        // Owned ≥ 72h
        const now = Date.now();
        const minOwnedMs = 72 * 60 * 60 * 1000;
        const ownedA = p1.ownedSince ? now - p1.ownedSince.getTime() : 0;
        const ownedB = p2.ownedSince ? now - p2.ownedSince.getTime() : 0;
        if (ownedA < minOwnedMs || ownedB < minOwnedMs) {
            throw new BadRequestException('You must own both parents for at least 72 hours');
        }

        // Level rule
        if (p1.level < (p1.currentBreeds ?? 0) + 1 || p2.level < (p2.currentBreeds ?? 0) + 1) {
            throw new BadRequestException('Horse level is too low for a new breed');
        }

        // Breed limits by rarity
        const toTier = (r: string) => {
            const k = r.toLowerCase();
            if (k === 'common') return 'Common';
            if (k === 'uncommon') return 'Uncommon';
            if (k === 'rare') return 'Rare';
            if (k === 'epic') return 'Epic';
            if (k === 'legendary') return 'Legendary';
            if (k === 'mythic') return 'Mythic';
            throw new BadRequestException(`Unsupported rarity "${r}"`);
        };

        if ((p1.currentBreeds ?? 0) >= (p1.maxBreeds ?? 0)) {
            throw new BadRequestException(`Parent ${p1.tokenId} reached its breed limit`);
        }
        if ((p2.currentBreeds ?? 0) >= (p2.maxBreeds ?? 0)) {
            throw new BadRequestException(`Parent ${p2.tokenId} reached its breed limit`);
        }

        // ---------- INCEST CHECKS ----------
        const p1Parents = (parents[0].parents ?? []);
        const p2Parents = (parents[1].parents ?? []);
        if (p1Parents.includes(numB) || p2Parents.includes(numA)) {
            throw new BadRequestException('Breeding between parent and child is not allowed');
        }
        const hasCommonParent =
            p1Parents.length > 0 && p2Parents.length > 0 &&
            p1Parents.some(pid => p2Parents.includes(pid));
        if (hasCommonParent) {
            throw new BadRequestException('Breeding between siblings is not allowed');
        }

        // Costs
        const { phorseCost, ronCost } = await this.calculateBreedCosts(tokenIdA, tokenIdB);

        // Prevent duplicate “in-flight” breed
        const existing = await this.prisma.breed.findFirst({
            where: {
                ownerId: p1.ownerId,
                finalized: false,
                parents: { hasEvery: [numA, numB] },
            },
            select: { id: true },
        });
        if (existing) {
            throw new BadRequestException('There is already a pending breeding for this pair');
        }

        // Determine child rarity from lower tier chances
        const tierOrder = { Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4, Mythic: 5 };
        const t1 = toTier(p1.rarity);
        const t2 = toTier(p2.rarity);
        const lowerTier = tierOrder[t1] <= tierOrder[t2] ? t1 : t2;

        const chances = (rarityBase as any)[lowerTier]?.['Breeding Chances'] as number[] | undefined;
        if (!Array.isArray(chances) || chances.length !== 6) {
            throw new BadRequestException('Invalid rarity chances config');
        }
        const pickWeightedIndex = (weights: number[]) => {
            const sum = weights.reduce((a, b) => a + b, 0);
            let r = Math.random() * sum;
            for (let i = 0; i < weights.length; i++) {
                if ((r -= weights[i]) <= 0) return i;
            }
            return weights.length - 1;
        };
        const rarityMap = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'] as const;
        const childTier = rarityMap[pickWeightedIndex(chances)];

        const NAME_POOL = {
            Common: ['Blue Roan', 'Brown', 'Chestnut', 'Dark Bay', 'Gray', 'Light Bay', 'Liver Chestnut', 'Palamino', 'Strawberry Roan', 'White'],
            Uncommon: ['Aquamarine', 'Blue', 'Cyan', 'Dark Green', 'Green', 'Orange', 'Pink', 'Purple', 'Red', 'Yellow'],
            Rare: ['Daisy', 'Love', 'Red Eyed Black', 'Red Eyed Blue', 'Red Eyed Crimson', 'Red Eyed Green', 'Red Eyed Purple'],
            Epic: ['Black Gypsy', 'Nightmare', 'Rainbow', 'White Gypsy', 'Wooden Horse'],
            Legendary: ['Bones', 'Ghost', 'Hologram', 'Hypothetical'],
            Mythic: ['Deathcharger', 'Glitch', 'Wildfire'],
        };

        // --- Special case: if either parent is "Phoenix's Guardian", add it to the Mythic pool ---
        const mythicPool = [...NAME_POOL.Mythic];
        if (p1.name === "Phoenix's Guardian" || p2.name === "Phoenix's Guardian") {
            if (!mythicPool.includes("Phoenix's Guardian")) {
                mythicPool.push("Phoenix's Guardian");
            }
        }

        const rarePool = [...NAME_POOL.Rare];
        if (p1.name === "Akhal-Teke" || p2.name === "Akhal-Teke") {
            if (!rarePool.includes("Akhal-Teke")) {
                rarePool.push("Akhal-Teke");
            }
        }

        // Build a pool map with the (possibly) augmented Mythic list
        const EFFECTIVE_POOL: typeof NAME_POOL = {
            ...NAME_POOL,
            Rare: rarePool as typeof NAME_POOL.Rare,
            Mythic: mythicPool as typeof NAME_POOL.Mythic,
        };

        const chosenPool = EFFECTIVE_POOL[childTier];
        const childName = chosenPool[Math.floor(Math.random() * chosenPool.length)];

        // Highest stat picks
        const maleStats = [
            { key: 'basePower' as const, val: male.basePower },
            { key: 'baseSprint' as const, val: male.baseSprint },
            { key: 'baseSpeed' as const, val: male.baseSpeed },
        ].sort((a, b) => b.val - a.val);
        const malePick = maleStats[0].key;

        const femaleStats = [
            { key: 'basePower' as const, val: female.basePower },
            { key: 'baseSprint' as const, val: female.baseSprint },
            { key: 'baseSpeed' as const, val: female.baseSpeed },
        ].filter(s => s.key !== malePick).sort((a, b) => b.val - a.val);
        const femalePick = femaleStats[0].key;

        const startRange = (rarityBase as any)[childTier]['Starting Stats'] as [number, number];
        const tierStat = Math.floor(Math.random() * (startRange[1] - startRange[0] + 1)) + startRange[0];

        const slots: Array<'basePower' | 'baseSprint' | 'baseSpeed'> = ['basePower', 'baseSprint', 'baseSpeed'];
        const remaining = slots.find(k => k !== malePick && k !== femalePick)!;

        const base: Record<'basePower' | 'baseSprint' | 'baseSpeed', number> = {
            basePower: 0, baseSprint: 0, baseSpeed: 0
        };
        base[malePick] = (male as any)[malePick];
        base[femalePick] = (female as any)[femalePick];
        base[remaining] = tierStat;

        // Apply gene bonuses (+6) AFTER rolls are picked
        for (const gid of requestedGenes) {
            const key = GENE_ID_TO_BASE[gid];
            base[key] += 6;
        }

        const childSex = Math.random() < 0.5 ? 'MALE' : 'FEMALE';
        const childGen = Math.max(p1.gen ?? 0, p2.gen ?? 0) + 1;
        const nowIso = new Date();

        // Next numeric tokenId
        const [{ maxToken }] = await this.prisma.$queryRaw<{ maxToken: bigint | null }[]>`
    SELECT MAX(CASE WHEN "tokenId" ~ '^[0-9]+$' THEN ("tokenId")::bigint ELSE NULL END) AS "maxToken"
    FROM "Horse"
  `;
        const nextTokenId = ((maxToken ?? BigInt(0)) + BigInt(1)).toString();

        // ─────────────────────────────────────────────────────────────────────
        // ATOMIC TRANSACTION — includes: balance reserve, parent rechecks,
        // breed creation, child creation, and GENE CONSUMPTION.
        // If anything fails, everything rolls back.
        // ─────────────────────────────────────────────────────────────────────
        return await this.prisma.$transaction(async (tx) => {
            // --- Collect exactly one DB item (string UUID) per requested gene, by NAME ---
            // NOTE: We pick the oldest first (deterministic), require uses > 0 if column exists.
            const toConsumeIds: string[] = [];

            if (requestedGenes.length > 0) {
                for (const gid of requestedGenes) {
                    const geneName = GENE_ID_TO_NAME[gid];

                    const geneItem = await tx.item.findFirst({
                        where: {
                            ownerId: p1.ownerId,
                            name: geneName,
                            // If your schema has "uses" and "breakable" columns:
                            // breakable: true,  // genes are breakable in your config
                            // uses: { gt: 0 },
                        },
                        select: { id: true },
                        orderBy: { createdAt: 'asc' }, // or id asc if you prefer
                    });

                    if (!geneItem) {
                        // User requested a gene they do not (or no longer) own
                        throw new BadRequestException(`You do not own required gene: ${geneName}`);
                    }
                    toConsumeIds.push(geneItem.id); // <-- string UUID
                }
            }

            // Reserve PHORSE + WRON
            const dec = await tx.user.updateMany({
                where: { id: p1.ownerId, phorse: { gte: phorseCost }, wron: { gte: ronCost } },
                data: {
                    phorse: { decrement: phorseCost },
                    wron: { decrement: ronCost },
                    totalPhorseSpent: { increment: phorseCost },
                    burnScore: { increment: phorseCost },
                },
            });
            if (dec.count === 0) throw new BadRequestException('Insufficient balance to breed');


            // Optimistic rechecks + increment breeds
            const recheckA = await tx.horse.updateMany({
                where: {
                    id: p1.id,
                    ownerId: p1.ownerId,
                    status: 'IDLE',
                    level: p1.level,
                    currentBreeds: p1.currentBreeds,
                    ownedSince: { lte: new Date(now - minOwnedMs) },
                    stableid: { not: null },
                },
                data: { currentBreeds: { increment: 1 }, status: 'BREEDING', lastBreeding: new Date() },
            });
            if (recheckA.count === 0) throw new BadRequestException(`Parent ${p1.tokenId} no longer eligible`);

            const recheckB = await tx.horse.updateMany({
                where: {
                    id: p2.id,
                    ownerId: p2.ownerId,
                    status: 'IDLE',
                    level: p2.level,
                    currentBreeds: p2.currentBreeds,
                    ownedSince: { lte: new Date(now - minOwnedMs) },
                    stableid: { not: null },
                },
                data: { currentBreeds: { increment: 1 }, status: 'BREEDING', lastBreeding: new Date() },
            });
            if (recheckB.count === 0) throw new BadRequestException(`Parent ${p2.tokenId} no longer eligible`);

            // --- Consume gene items atomically by UUID (string[]) ---
            if (toConsumeIds.length > 0) {
                const del = await tx.item.deleteMany({
                    where: { id: { in: toConsumeIds } }, // <-- string[]
                });
                if (del.count !== toConsumeIds.length) {
                    // Another concurrent request raced these same items; abort safely.
                    throw new BadRequestException('Gene consumption conflict, please retry');
                }
            }

            const breed = await tx.breed.create({
                data: {
                    ownerId: p1.ownerId,
                    parents: [numA, numB],
                    started: new Date(),
                    tokenId: Number(nextTokenId),
                    finalized: false,
                    // (Optional) If you have a JSON column, persist which genes were used:
                    // meta: { genes: requestedGenes }
                },
                select: { id: true, parents: true, started: true, finalized: true },
            });

            // Create child
            const child = await tx.horse.create({
                data: {
                    tokenId: nextTokenId,
                    ownerId: p1.ownerId,
                    name: childName,
                    nickname: null,
                    sex: childSex,
                    status: 'IDLE',
                    rarity: childTier,
                    exp: 0,
                    upgradable: false,
                    level: 1,
                    basePower: base.basePower,
                    currentPower: base.basePower,
                    baseSprint: base.baseSprint,
                    currentSprint: base.baseSprint,
                    baseSpeed: base.baseSpeed,
                    currentSpeed: base.baseSpeed,
                    currentEnergy: 12,
                    maxEnergy: 12,
                    foodUsed: 0,
                    lastRace: null,
                    lastEnergy: null,
                    gen: childGen,
                    currentBreeds: 0,
                    ownedSince: nowIso,
                    traitSlotsUnlocked: Math.floor(Math.random() * 2) + 2,
                    parents: [numA, numB],
                    maxBreeds: Math.floor(Math.random() * 4),
                },
                select: {
                    id: true, tokenId: true, name: true, rarity: true, sex: true,
                    basePower: true, baseSprint: true, baseSpeed: true, gen: true,
                },
            });

            // Log PHORSE spend (you can also log WRON)
            await tx.transaction.create({
                data: {
                    ownerId: p1.ownerId,
                    type: TransactionType.ITEM,
                    status: TransactionStatus.COMPLETED,
                    value: phorseCost,
                    tokenSymbol: 'PHORSE',
                    note: `Breed: ${p1.tokenId} × ${p2.tokenId} → ${child.tokenId} (${child.rarity}); PHORSE=${phorseCost}, RON=${ronCost}${requestedGenes.length ? `; Genes=${requestedGenes.join(',')}` : ''}`,
                },
            });

            return {
                child,
                costs: { phorseCost, ronCost },
                breed
            };
        }, { timeout: 10_000 });
    }

    async preflightBreedByTokenIds(
        callerWallet: string,
        tokenIdA: string,
        tokenIdB: string
    ): Promise<{
        eligible: boolean;
        reasons: string[];
        costs?: { phorseCost: number; ronCost: number };
        parents?: Array<{
            tokenId: string;
            sex: 'MALE' | 'FEMALE';
            rarity: string;
            level: number;
            currentBreeds: number;
            maxBreeds: number | null;
            status: string;
            ownedSince: string | null;
        }>;
    }> {
        const reasons: string[] = [];

        // Basic input checks
        if (!tokenIdA || !tokenIdB) {
            throw new BadRequestException('Both token IDs are required');
        }
        if (tokenIdA === tokenIdB) {
            reasons.push('Use two distinct parents');
        }

        const isNumeric = (s: string) => /^\d+$/.test(s);
        if (!isNumeric(tokenIdA) || !isNumeric(tokenIdB)) {
            reasons.push('Breeding requires numeric tokenIds');
        }
        const numA = Number(tokenIdA);
        const numB = Number(tokenIdB);

        // Find caller (auth required)
        const caller = await this.prisma.user.findUnique({
            where: { wallet: callerWallet.toLowerCase() },
            select: { id: true },
        });
        if (!caller) throw new NotFoundException('User not found');

        // Fetch both parents in one roundtrip
        const parents = await this.prisma.horse.findMany({
            where: { tokenId: { in: [tokenIdA, tokenIdB] } },
            select: {
                id: true, tokenId: true, ownerId: true, sex: true, status: true, rarity: true,
                level: true, currentBreeds: true, ownedSince: true, gen: true,
                basePower: true, baseSprint: true, baseSpeed: true,
                parents: true,
                maxBreeds: true,
            },
        });

        if (parents.length !== 2) {
            const found = new Set(parents.map(p => p.tokenId));
            const missing = [tokenIdA, tokenIdB].filter(t => !found.has(t));
            reasons.push(`Parent(s) not found: ${missing.join(', ')}`);
        }

        // If both resolved, run validations (no DB writes)
        if (parents.length === 2) {
            const [p1, p2] = parents;

            // Caller must own both (and both parents must share the same owner)
            if (p1.ownerId !== caller.id || p2.ownerId !== caller.id) {
                reasons.push('You must be the owner of both parents');
            }
            if (p1.ownerId !== p2.ownerId) {
                reasons.push('Both parents must share the same owner');
            }

            // Sex rule (one MALE, one FEMALE)
            const hasMale = p1.sex === 'MALE' || p2.sex === 'MALE';
            const hasFemale = p1.sex === 'FEMALE' || p2.sex === 'FEMALE';
            if (!hasMale || !hasFemale) {
                reasons.push('Parents must be one MALE and one FEMALE');
            }

            // Status must be IDLE
            if (p1.status !== 'IDLE' || p2.status !== 'IDLE') {
                reasons.push('Both parents must be IDLE');
            }

            // Owned ≥ 72h
            const now = Date.now();
            const minOwnedMs = 72 * 60 * 60 * 1000;
            const ownedA = p1.ownedSince ? now - p1.ownedSince.getTime() : 0;
            const ownedB = p2.ownedSince ? now - p2.ownedSince.getTime() : 0;
            if (ownedA < minOwnedMs || ownedB < minOwnedMs) {
                reasons.push('You must own both parents for at least 72 hours');
            }

            // Level must be currentBreeds + 1 (per parent)
            if (p1.level < (p1.currentBreeds ?? 0) + 1) {
                reasons.push(`Parent ${p1.tokenId} level is too low for a new breed`);
            }
            if (p2.level < (p2.currentBreeds ?? 0) + 1) {
                reasons.push(`Parent ${p2.tokenId} level is too low for a new breed`);
            }

            // Max breed limits (use per-horse maxBreeds)
            if ((p1.currentBreeds ?? 0) >= (p1.maxBreeds ?? 0)) {
                reasons.push(`Parent ${p1.tokenId} reached its breed limit`);
            }
            if ((p2.currentBreeds ?? 0) >= (p2.maxBreeds ?? 0)) {
                reasons.push(`Parent ${p2.tokenId} reached its breed limit`);
            }

            // Incest checks: parent↔child or siblings
            const p1Parents = (p1.parents ?? []);
            const p2Parents = (p2.parents ?? []);
            if (p1Parents.includes(numB) || p2Parents.includes(numA)) {
                reasons.push('Breeding between parent and child is not allowed');
            }
            if (p1Parents.length && p2Parents.length && p1Parents.some(pid => p2Parents.includes(pid))) {
                reasons.push('Breeding between siblings is not allowed');
            }

            // Pending (unfinalized) breeding for this owner & pair?
            const pending = await this.prisma.breed.findFirst({
                where: {
                    ownerId: caller.id,
                    finalized: false,
                    parents: { hasEvery: [numA, numB] },
                },
                select: { id: true },
            });
            if (pending) {
                reasons.push('There is already a pending breeding for this pair');
            }
        }

        // Try compute costs (helpful even if ineligible; if oracle fails, add reason)
        let costs: { phorseCost: number; ronCost: number } | undefined = undefined;
        try {
            const c = await this.calculateBreedCosts(tokenIdA, tokenIdB);
            costs = c;
        } catch (e: any) {
            reasons.push('Unable to fetch breeding costs at the moment');
        }

        // Lightweight parent echo (for UI)
        const parentsEcho =
            parents.length === 2
                ? parents.map(p => ({
                    tokenId: p.tokenId,
                    sex: p.sex as 'MALE' | 'FEMALE',
                    rarity: p.rarity,
                    level: p.level,
                    currentBreeds: p.currentBreeds ?? 0,
                    maxBreeds: p.maxBreeds ?? null,
                    status: p.status,
                    ownedSince: p.ownedSince ? p.ownedSince.toISOString() : null,
                }))
                : undefined;

        return {
            eligible: reasons.length === 0,
            reasons,
            ...(costs ? { costs } : {}),
            ...(parentsEcho ? { parents: parentsEcho } : {}),
        };
    }

    async listBreedsByOwner(
        ownerWallet: string,
        finalizedOnly?: boolean
    ) {
        const user = await this.prisma.user.findUnique({
            where: { wallet: ownerWallet.toLowerCase() },
            select: { id: true },
        });
        if (!user) throw new NotFoundException('User not found');

        return this.prisma.breed.findMany({
            where: {
                ownerId: user.id,
                ...(finalizedOnly ? { finalized: false } : {}),
            },
            orderBy: [{ started: 'desc' } as any].filter(Boolean),
        });
    }

    /**
    * Preflight: tell if a breed for (a,b) is eligible to finalize RIGHT NOW.
    * - Does not mutate state.
    * - No horse ownership checks (only Breed ownership).
    */
    async checkFinalizeBreedingByParents(
        callerWallet: string,
        parentA: string | number,
        parentB: string | number,
    ): Promise<{ eligible: boolean; reasons: string[]; etaHours?: number; tokenId?: number }> {
        const wallet = (callerWallet || '').toLowerCase();
        const reasons: string[] = [];

        const toInt = (v: string | number, name: string): number => {
            const s = String(v).trim();
            if (!/^\d+$/.test(s)) {
                reasons.push(`${name} must be a numeric tokenId`);
                return NaN as unknown as number;
            }
            const n = Number(s);
            if (!Number.isSafeInteger(n) || n < 0) {
                reasons.push(`${name} is invalid`);
                return NaN as unknown as number;
            }
            return n;
        };

        const aInt = toInt(parentA, 'Parent A');
        const bInt = toInt(parentB, 'Parent B');
        if (Number.isNaN(aInt) || Number.isNaN(bInt)) return { eligible: false, reasons };
        if (aInt === bInt) {
            reasons.push('Use two distinct parents');
            return { eligible: false, reasons };
        }

        const user = await this.prisma.user.findUnique({
            where: { wallet },
            select: { id: true },
        });
        if (!user) {
            reasons.push('User not found');
            return { eligible: false, reasons };
        }

        // Latest Breed for this pair owned by caller
        const breed = await this.prisma.breed.findFirst({
            where: { ownerId: user.id, parents: { hasEvery: [aInt, bInt] } },
            orderBy: [{ started: 'desc' }, { id: 'desc' }],
            select: { id: true, started: true, finalized: true, tokenId: true },
        });
        if (!breed) {
            reasons.push('No breeding found for this parent pair');
            return { eligible: false, reasons };
        }

        if (!breed.started) reasons.push('Breeding has not started yet');
        if (breed.finalized) reasons.push('This breeding is already finalized');
        if (breed.tokenId == null) reasons.push('Breeding has no tokenId assigned yet');

        const DAY_MS = 24 * 60 * 60 * 1000;
        const readyAt = breed.started ? breed.started.getTime() + DAY_MS : 0;
        if (breed.started && Date.now() < readyAt) {
            const etaHours = Math.ceil((readyAt - Date.now()) / 36e5);
            reasons.push(`Breeding not ready yet. Try again in ~${etaHours}h`);
        }

        // Parents must be BREEDING (no ownership checks)
        const [aStr, bStr] = [String(aInt), String(bInt)];
        const parents = await this.prisma.horse.findMany({
            where: { tokenId: { in: [aStr, bStr] } },
            select: { tokenId: true, status: true },
        });
        if (parents.length !== 2) {
            const found = new Set(parents.map(p => p.tokenId));
            const missing = [aStr, bStr].filter(x => !found.has(x));
            reasons.push(`Parent horse(s) not found: ${missing.join(', ')}`);
        } else {
            const notBreeding = parents.filter(p => p.status !== 'BREEDING').map(p => p.tokenId);
            if (notBreeding.length) {
                reasons.push(`Parent(s) not in BREEDING state: ${notBreeding.join(', ')}`);
            }
        }

        const eligible = reasons.length === 0;
        const payload: { eligible: boolean; reasons: string[]; etaHours?: number; tokenId?: number } = {
            eligible,
            reasons,
        };
        if (breed.started && Date.now() < readyAt) {
            payload.etaHours = Math.ceil((readyAt - Date.now()) / 36e5);
        }
        if (breed.tokenId != null) payload.tokenId = breed.tokenId;

        return payload;
    }

    /**
    * Finalize a breeding for the latest Breed matching (a,b).
    * - No current horse ownership checks.
    * - Requires both parents currently be BREEDING.
    * - Atomic: finalize Breed, create HorseMintRequest(PENDING), flip parents → IDLE.
    */
    async finalizeBreedingByParents(
        callerWallet: string,
        parentA: string | number,
        parentB: string | number,
    ) {
        const wallet = (callerWallet || '').toLowerCase();
        if (!wallet) throw new BadRequestException('Missing authenticated wallet');

        const toInt = (v: string | number, name: string): number => {
            const s = String(v).trim();
            if (!/^\d+$/.test(s)) throw new BadRequestException(`${name} must be a numeric tokenId`);
            const n = Number(s);
            if (!Number.isSafeInteger(n) || n < 0) throw new BadRequestException(`${name} is invalid`);
            return n;
        };

        const aInt = toInt(parentA, 'Parent A');
        const bInt = toInt(parentB, 'Parent B');
        if (aInt === bInt) throw new BadRequestException('Use two distinct parents');

        const user = await this.prisma.user.findUnique({
            where: { wallet },
            select: { id: true },
        });
        if (!user) throw new NotFoundException('User not found');

        const breed = await this.prisma.breed.findFirst({
            where: { ownerId: user.id, parents: { hasEvery: [aInt, bInt] } },
            orderBy: [{ started: 'desc' }, { id: 'desc' }],
            select: { id: true, started: true, finalized: true, tokenId: true },
        });
        if (!breed) throw new NotFoundException('No breeding found for this parent pair');
        if (!breed.started) throw new BadRequestException('Breeding has not started yet');
        if (breed.finalized) throw new BadRequestException('This breeding is already finalized');
        if (breed.tokenId == null) throw new BadRequestException('Breeding has no tokenId assigned yet');

        const DAY_MS = 24 * 60 * 60 * 1000;
        const cutoff = new Date(Date.now() - DAY_MS);
        if (breed.started > cutoff) {
            const hrs = Math.ceil((breed.started.getTime() + DAY_MS - Date.now()) / 36e5);
            throw new BadRequestException(`Breeding not ready yet. Try again in ~${hrs}h`);
        }

        // Parents must be BREEDING at finalize time
        const [aStr, bStr] = [String(aInt), String(bInt)];
        const parents = await this.prisma.horse.findMany({
            where: { tokenId: { in: [aStr, bStr] } },
            select: { tokenId: true, status: true },
        });
        if (parents.length !== 2) {
            const found = new Set(parents.map(p => p.tokenId));
            const missing = [aStr, bStr].filter(x => !found.has(x));
            throw new NotFoundException(`Parent horse(s) not found: ${missing.join(', ')}`);
        }
        const notBreeding = parents.filter(p => p.status !== 'BREEDING').map(p => p.tokenId);
        if (notBreeding.length) {
            throw new BadRequestException(
                `Cannot finalize: parent(s) not in BREEDING state: ${notBreeding.join(', ')}`
            );
        }

        // Atomic: finalize + mint request + flip parents → IDLE
        const mintRequest = await this.prisma.$transaction(async (tx) => {
            // Re-check and finalize
            const upd = await tx.breed.updateMany({
                where: { id: breed.id, finalized: false, started: { lte: cutoff } },
                data: { finalized: true },
            });
            if (upd.count === 0) {
                throw new BadRequestException('Breeding not eligible to finalize (already finalized or not ready)');
            }

            // Create mint request for caller
            const req = await tx.horseMintRequest.create({
                data: {
                    requesterId: user.id,
                    tokenId: breed.tokenId!,
                    txId: null,
                    status: TransactionStatus.PENDING,
                },
                select: { id: true, tokenId: true, status: true, txId: true, createdAt: true },
            });

            // Flip parents to IDLE only if they are BREEDING now
            const affected: number = await tx.$executeRaw`
        UPDATE "Horse"
           SET "status" = 'IDLE'::"Status"
         WHERE "tokenId" IN (${aStr}, ${bStr})
           AND "status" = 'BREEDING'::"Status"
      `;
            if (affected !== 2) {
                throw new BadRequestException('Parents are no longer in BREEDING state; unable to finalize');
            }

            return req;
        });

        return {
            message: 'Breeding finalized. Mint request created and parents returned to IDLE.',
            mintRequest,
        };
    }

    /**
    * Simple, Moralis-like call that only returns the field you need:
    * usdPriceFormatted. No DB trips. 30s in-memory cache. Converts all
    * upstream failures into 503 to avoid 500s.
    */
    async getPhorseUsdOracle(): Promise<OracleResp> {
        // Serve fresh cache if available
        const now = Date.now();
        if (this.oracleCache && now - this.oracleCacheAt < this.ORACLE_TTL_MS) {
            return { ...this.oracleCache, cached: true };
        }

        const apiKey = process.env.MORALIS_API_KEY;
        if (!apiKey) {
            // Don’t 500 if config is missing; return 503 with a safe message.
            throw new ServiceUnavailableException('Oracle temporarily unavailable');
        }

        // Single external roundtrip, short timeout
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4500);

        try {
            const res = await fetch(this.MORALIS_URL, {
                headers: { 'X-API-Key': apiKey },
                signal: controller.signal,
            });

            if (!res.ok) {
                // Prefer serving a slightly stale value over 500s
                if (this.oracleCache) {
                    return { ...this.oracleCache, cached: true };
                }
                throw new ServiceUnavailableException('Oracle upstream unavailable');
            }

            const json = await res.json();
            const usdPriceFormatted = json?.usdPriceFormatted;

            if (typeof usdPriceFormatted !== 'string' || !usdPriceFormatted) {
                // If Moralis shape changes, shield callers from 500s
                if (this.oracleCache) {
                    return { ...this.oracleCache, cached: true };
                }
                throw new ServiceUnavailableException('Oracle payload invalid');
            }

            const payload: OracleResp = {
                symbol: 'PHORSE',
                usdPriceFormatted,
                updatedAt: new Date().toISOString(),
                source: 'moralis',
                cached: false,
            };

            // Update cache atomically
            this.oracleCache = payload;
            this.oracleCacheAt = now;

            return payload;
        } catch (err) {
            // Timeout / network / abort — serve stale if we have it
            if (this.oracleCache) {
                return { ...this.oracleCache, cached: true };
            }
            throw new ServiceUnavailableException('Oracle not reachable');
        } finally {
            clearTimeout(timer);
        }
    }

    private normalizeRarity(r: string): Rarity {
        const key = (r || '').trim().toUpperCase();
        switch (key) {
            case 'COMMON': return 'COMMON';
            case 'UNCOMMON': return 'UNCOMMON';
            case 'RARE': return 'RARE';
            case 'EPIC': return 'EPIC';
            case 'LEGENDARY': return 'LEGENDARY';
            case 'MYTHIC': return 'MYTHIC';
            default:
                throw new BadRequestException(`Unsupported rarity "${r}"`);
        }
    }

    private readonly rarityOrder: Record<Rarity, number> = {
        COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4, MYTHIC: 5
    };

    // USD base by lowest rarity
    private readonly breedBaseUsd: Record<Rarity, number> = {
        COMMON: 10,
        UNCOMMON: 15,
        RARE: 20,
        EPIC: 25,
        LEGENDARY: 30,
        MYTHIC: 40,
    };

    private readonly breedBaseRon: Record<number, number> = {
        1: 1.8,
        2: 3.6,
        3: 5.4,
        4: 7.2,
        5: 9,
        6: 10.8,
        7: 12.6,
        8: 14.4,
        9: 16.2,
        10: 18,
        11: 19.8,
        12: 21.6,
        13: 23.4,
        14: 25.2,
        15: 27.0,
        16: 28.8,
        17: 30.6,
        18: 32.4,
        19: 34.2,
        20: 36.0,
        21: 37.8,
        22: 39.6,
        23: 41.4,
        24: 43.2
    }

    /**
     * Calculate breed costs (PHORSE + RON).
     * Changes:
     * 1) Use the parent's **maximum** currentBreeds instead of the sum.
     * 2) Add a +$1 modifier to baseUsd for each current breed on that parent
     *    (i.e., baseUsd += maxCurrentBreeds * 1).
     *
     * PHORSE formula:
     *   rawPhorse = ((baseUsd + maxCurrentBreeds * 1) / usdPrice) + (maxCurrentBreeds * usdPrice)
     *
     * RON formula:
     *   ronCost = breedBaseRon[maxCurrentBreeds + 1]
     */
    async calculateBreedCosts(horseIdA: string, horseIdB: string) {
        if (!horseIdA || !horseIdB) {
            throw new BadRequestException('Both horse IDs are required');
        }
        if (horseIdA === horseIdB) {
            throw new BadRequestException('Use two distinct horses');
        }

        // Fetch both horses in a single roundtrip
        const horses = await this.prisma.horse.findMany({
            where: { tokenId: { in: [horseIdA, horseIdB] } },
            select: { id: true, rarity: true, currentBreeds: true, gen: true },
        });

        if (horses.length !== 2) {
            const foundTokenIds = new Set(horses.map(h => h.id));
            const missing = [horseIdA, horseIdB].filter(id => !foundTokenIds.has(id));
            throw new NotFoundException(`Horse(s) not found: ${missing.join(', ')}`);
        }

        // Normalize rarities & compute the lowest rarity (for base USD)
        const r1 = this.normalizeRarity(horses[0].rarity);
        const r2 = this.normalizeRarity(horses[1].rarity);
        const lowestRarity = this.rarityOrder[r1] <= this.rarityOrder[r2] ? r1 : r2;

        // Use the parent's MAX currentBreeds (not the sum)
        const breedsA = horses[0].currentBreeds ?? 0;
        const breedsB = horses[1].currentBreeds ?? 0;
        const maxCurrentBreeds = Math.max(breedsA, breedsB);

        // Oracle price (cached)
        const { usdPriceFormatted } = await this.getPhorseUsdOracle();

        const usd = Number(usdPriceFormatted);

        if (!Number.isFinite(usd) || usd <= 0) {
            throw new ServiceUnavailableException('Oracle price invalid');
        }

        // Base USD from rarity, then add +$1 per current breed on the higher-breed parent
        const baseUsdBare = this.breedBaseUsd[lowestRarity];
        if (!Number.isFinite(baseUsdBare)) {
            throw new ServiceUnavailableException(`Base USD not defined for rarity ${lowestRarity}`);
        }
        const baseUsdWithModifier = baseUsdBare + maxCurrentBreeds * 5; // $5 per consecutive breed

        // PHORSE cost
        let rawPhorse = baseUsdWithModifier / usd + maxCurrentBreeds * usd;

        if (horses[0].gen > 0 || horses[1].gen > 0) {
            rawPhorse = rawPhorse * 1.80;
        }

        if (!Number.isFinite(rawPhorse) || rawPhorse <= 0) {
            throw new ServiceUnavailableException('Calculated PHORSE cost invalid');
        }
        const phorseCost = Math.ceil(rawPhorse);

        // RON cost indexed by (maxCurrentBreeds + 1)
        const ronKey = maxCurrentBreeds + 1;
        const ronCost = this.breedBaseRon[ronKey];
        if (ronCost == null) {
            throw new ServiceUnavailableException(`RON cost not defined for breed #${ronKey}`);
        }

        return {
            phorseCost,
            ronCost,
        };
    }

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

    async getWron(wallet: string) {
        const u = await this.prisma.user.findUnique({
            where: { wallet },
            select: { wron: true },
        });
        return u?.wron;
    }

    async getShards(wallet: string) {
        const u = await this.prisma.user.findUnique({
            where: { wallet },
            select: { shards: true },
        });
        return u?.shards;
    }

    async getCareerFactor(wallet: string) {
        const u = await this.prisma.user.findUnique({
            where: { wallet },
            select: { careerfactor: true },
        });
        return u?.careerfactor.toFixed(2);
    }

    async getNickname(wallet: string) {
        const u = await this.prisma.user.findUnique({
            where: { wallet },
            select: { discordTag: true },
        });
        return u?.discordTag ? String(u?.discordTag) : `${wallet.slice(0, 8)}...`;
    }

    // ------------------- ITEMS SECTION -----------------------

    /**
    * Buy a given chest type/quantity for a user identified by wallet.
    * Uses PHORSE/USD oracle to convert USD item price -> PHORSE (ceil to integer).
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

        // 3) Run everything in one Prisma transaction
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
                    burnScore: { increment: totalCost },
                    presalePhorse: { decrement: totalCost },
                },
            });
            if (upd.count === 0) {
                throw new BadRequestException('Insufficient PHORSE balance');
            }

            // B) Look up user id
            const u = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!u) {
                throw new NotFoundException('User not found');
            }

            // C) Upsert Chest
            const chest = await tx.chest.upsert({
                where: {
                    ownerId_chestType: { ownerId: u.id, chestType },
                },
                create: {
                    owner: { connect: { id: u.id } },
                    chestType,
                    quantity: chestQuantity,
                },
                update: {
                    quantity: { increment: chestQuantity },
                },
            });

            // D) Record the purchase transaction (note includes pricing context)
            await tx.transaction.create({
                data: {
                    owner: { connect: { id: u.id } },
                    type: TransactionType.ITEM,
                    status: TransactionStatus.COMPLETED,
                    note: `Bought ${chestQuantity} chest(s) @ ${price} PHORSE/chest`,
                    value: totalCost,
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
                    burnScore: { increment: cost.phorse },
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
                    tokenSymbol: 'PHORSE',
                },
            });

            // 5) create the BridgeRequest linked 1:1 to that transaction
            await tx.bridgeRequest.create({
                data: {
                    owner: { connect: { id: user.id } },
                    request: Request.WITHDRAW,
                    value: amount,
                    transaction: { connect: { id: transaction.id } },
                    tokenSymbol: 'PHORSE'
                },
            });

            // 6) return the pending TX for client‐side tracking
            return { transactionId: transaction.id, message: `Transaction ${transaction.id.slice(0, 8)} added to the bridge queue!` };
        });
    }

    /**
     * 1. Validate amount
     * 2. Atomically “reserve” WRON via a decrement-if-enough
     * 3. Create a PENDING Transaction (tokenSymbol only; no tokenAddress)
     * 4. Create the BridgeRequest pointing at that Transaction
     * 5. All in one Prisma TX ⇒ full rollback on any failure
     */
    async wronWithdraw(ownerWallet: string, amount: number) {
        // 1) sanity‐check
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new BadRequestException('Invalid withdraw amount');
        }

        // Optional small anti-abuse: cap concurrent pending WRON withdrawals
        const MAX_PENDING = 5;

        return this.prisma.$transaction(async (tx) => {
            // A) cheap guard to avoid queue spam
            const pendingCount = await tx.transaction.count({
                where: {
                    type: TransactionType.WITHDRAW,
                    status: TransactionStatus.PENDING,
                    tokenSymbol: 'WRON',
                    owner: { wallet: ownerWallet },
                },
            });
            if (pendingCount >= MAX_PENDING) {
                throw new BadRequestException('Too many pending WRON withdrawals; please wait for processing.');
            }

            // 2) reserve the WRON balance (atomic decrement)
            const dec = await tx.user.updateMany({
                where: { wallet: ownerWallet, wron: { gte: amount } },
                data: { wron: { decrement: amount } },
            });
            if (dec.count === 0) {
                throw new BadRequestException('Insufficient WRON balance');
            }

            // 3) fetch the user’s internal id
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) {
                throw new NotFoundException('User not found');
            }

            // 4) create the PENDING withdrawal transaction
            const transaction = await tx.transaction.create({
                data: {
                    owner: { connect: { id: user.id } },
                    type: TransactionType.WITHDRAW,
                    status: TransactionStatus.PENDING,
                    value: amount,
                    note: `Requested withdraw of ${amount} WRON`,
                    txId: null,               // to be filled by CRON when it broadcasts on-chain
                    tokenAddress: null,       // decoupled here
                    tokenSymbol: 'WRON', // this is enough for CRON to resolve later
                },
                select: { id: true },
            });

            // 5) create the BridgeRequest linked 1:1 to that transaction
            await tx.bridgeRequest.create({
                data: {
                    owner: { connect: { id: user.id } },
                    request: Request.WITHDRAW,
                    value: amount,
                    transaction: { connect: { id: transaction.id } },
                    tokenSymbol: 'WRON',
                },
            });

            // 6) return the pending TX for client‐side tracking
            return {
                transactionId: transaction.id,
                message: `Transaction ${transaction.id.slice(0, 8)} added to the bridge queue!`,
            };
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
                    totalPhorseSpent: { increment: totalTax },
                    burnScore: { increment: totalTax }
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
                            ? { phorse: { decrement: phorseCost }, totalPhorseSpent: { increment: phorseCost }, burnScore: { increment: phorseCost } }
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

    /**
 * Destroy up to `quantity` copies of an item (exact `uses` match) and credit shards.
 * - Requires: item exists in items map and has a numeric `shards` value.
 * - Only consumes unequipped items (horseId IS NULL).
 * - Concurrency-safe single-shot delete using SKIP LOCKED.
 * - Optional idempotencyKey prevents double-charging on retries.
 *
 * @returns { destroyed, perItemShards, totalShards, newShards, remaining }
 */
    async breakItem(
        ownerWallet: string,
        itemName: string,
        uses: number,
        quantity: number,
        idempotencyKey?: string
    ): Promise<{ destroyed: number; perItemShards: number; totalShards: number; newShards: number; remaining: number }> {

        // 1) Validate item definition & shards
        const def = (items as Record<string, any>)[itemName];
        if (!def) {
            throw new NotFoundException(`Item "${itemName}" does not exist`);
        }
        const perItemShards = Number(def.shards ?? 0);
        if (!Number.isFinite(perItemShards) || perItemShards < 0) {
            throw new BadRequestException(`Item "${itemName}" has invalid shards value`);
        }

        // 2) Run as a single transaction
        return this.prisma.$transaction(async (tx) => {
            // A) Find user
            const user = await tx.user.findUnique({
                where: { wallet: ownerWallet },
                select: { id: true },
            });
            if (!user) throw new NotFoundException('User not found');

            // B) Idempotency short-circuit (if already processed)
            if (idempotencyKey) {
                const existing = await tx.transaction.findFirst({
                    where: {
                        ownerId: user.id,
                        type: TransactionType.ITEM,
                        status: TransactionStatus.COMPLETED,
                        note: { contains: `[BREAK:${idempotencyKey}]` },
                    },
                    select: { value: true }, // we store totalShards in value
                });
                if (existing) {
                    const bal = await tx.user.findUnique({
                        where: { id: user.id },
                        select: { shards: true },
                    });
                    // destroyed count can be derived because shards per item is constant
                    const destroyed = perItemShards > 0 ? Math.round(existing.value / perItemShards) : quantity;
                    return {
                        destroyed,
                        perItemShards,
                        totalShards: existing.value,
                        newShards: bal!.shards,
                        remaining: await tx.item.count({
                            where: { ownerId: user.id, name: itemName, uses, horseId: null },
                        }),
                    };
                }
            }

            // C) Concurrency-safe delete of exactly N items (oldest first) with SKIP LOCKED
            type Row = { id: string };

            let rows: Row[];

            // IMPORTANT: handle null uses with IS NULL (not "= NULL")
            if (uses === null || uses === undefined) {
                rows = await tx.$queryRaw<Row[]>`
                WITH picked AS (
                  SELECT "id"
                  FROM "Item"
                  WHERE "ownerId" = ${user.id}
                    AND "name" = ${itemName}
                    AND "horseId" IS NULL
                    AND "uses" IS NULL
                  ORDER BY "createdAt" ASC
                  LIMIT ${quantity}
                  FOR UPDATE SKIP LOCKED
                )
                DELETE FROM "Item"
                WHERE "id" IN (SELECT "id" FROM picked)
                RETURNING "id";
              `;
            } else {
                rows = await tx.$queryRaw<Row[]>`
                WITH picked AS (
                  SELECT "id"
                  FROM "Item"
                  WHERE "ownerId" = ${user.id}
                    AND "name" = ${itemName}
                    AND "horseId" IS NULL
                    AND "uses" = ${uses}
                  ORDER BY "createdAt" ASC
                  LIMIT ${quantity}
                  FOR UPDATE SKIP LOCKED
                )
                DELETE FROM "Item"
                WHERE "id" IN (SELECT "id" FROM picked)
                RETURNING "id";
              `;
            }

            const destroyed = rows?.length ?? 0;
            if (destroyed === 0) {
                // friendlier message when uses is null
                const usesMsg = (uses === null || uses === undefined) ? '' : ` (uses=${uses})`;
                throw new BadRequestException(
                    `You don’t own any unequipped "${itemName}"${usesMsg}`
                );
            }
            if (destroyed < quantity) {
                const usesMsg = (uses === null || uses === undefined) ? '' : ` (uses=${uses})`;
                throw new BadRequestException(
                    `You only have ${destroyed} "${itemName}"${usesMsg} available to break`
                );
            }

            // D) Credit shards in one guarded update
            const totalShards = perItemShards * destroyed;
            const updated = await tx.user.update({
                where: { id: user.id },
                data: { shards: { increment: totalShards } },
                select: { shards: true },
            });

            // E) Log a single ITEM transaction (store totalShards in `value` for idempotency reads)
            const note = `Broke "${itemName}" (uses=${uses}) x${destroyed}, +${totalShards} shards${idempotencyKey ? ` [BREAK:${idempotencyKey}]` : ''
                }`;
            await tx.transaction.create({
                data: {
                    ownerId: user.id,
                    type: TransactionType.ITEM,
                    status: TransactionStatus.COMPLETED,
                    value: totalShards, // important: used for idempotency replay
                    note,
                },
            });

            // F) Return snapshot (including how many remain with same filter)
            const remaining = await tx.item.count({
                where: { ownerId: user.id, name: itemName, uses, horseId: null },
            });

            return {
                destroyed,
                perItemShards,
                totalShards,
                newShards: updated.shards,
                remaining,
            };
        });
    }

}
