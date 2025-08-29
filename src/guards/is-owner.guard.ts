import {
    Injectable,
    CanActivate,
    ExecutionContext,
    Inject,
    ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ethers } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import * as dotenv from 'dotenv';
dotenv.config();

const CONTRACT_ADDRESS_LEGACY = process.env.NFT_CONTRACT_ADDRESS!;        // up to 2202
const CONTRACT_ADDRESS_OFH = process.env.NFT_CONTRACT_ADDRESS_OFH!;    // 2203+

const RPC_URL = process.env.RONIN_RPC_URL!;
const LEGACY_MAX_TOKEN_ID = 2202 as const;

const ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
];

@Injectable()
export class IsOwnerGuard implements CanActivate {
    private provider: ethers.JsonRpcProvider;
    private contractLegacy: ethers.Contract;
    private contractOFH: ethers.Contract;

    constructor(
        private reflector: Reflector,
        private readonly prisma: PrismaService,
    ) {
        this.provider = new ethers.JsonRpcProvider(RPC_URL);
        this.contractLegacy = new ethers.Contract(CONTRACT_ADDRESS_LEGACY, ABI, this.provider);
        this.contractOFH = new ethers.Contract(CONTRACT_ADDRESS_OFH, ABI, this.provider);
    }

    // helper: pick contract by tokenId
    private getContractFor(tokenId: string) {
        const n = Number(tokenId);
        if (!Number.isFinite(n)) throw new ForbiddenException('Invalid tokenId');
        return n <= LEGACY_MAX_TOKEN_ID ? this.contractLegacy : this.contractOFH;
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();

        const tokenId = request.params.tokenId;
        const wallet = request.user.wallet.toLowerCase();

        if (!tokenId) {
            throw new ForbiddenException('Token ID is missing');
        }

        const onChainOwner = await this.getOwnerOf(tokenId);

        if (onChainOwner.toLowerCase() === wallet) {
            // Wallet matches blockchain owner — check DB consistency

            const user = await this.prisma.user.upsert({
                where: { wallet: wallet },
                update: {},
                create: { wallet: wallet },
                select: { id: true },
            });

            const horse = await this.prisma.horse.findUnique({
                where: { tokenId },
                select: { id: true, ownerId: true, ownedSince: true },
            });

            if (horse && horse.ownerId !== user.id) {
                await this.prisma.$transaction(async (tx) => {
                    // 1. Update ownership
                    await tx.horse.update({
                        where: { tokenId },
                        data: { ownerId: user.id, ownedSince: new Date() }
                    });

                    // 2. Unequip any items
                    await tx.item.updateMany({
                        where: { horseId: horse.id },
                        data: { horseId: null },
                    });
                });
            }

            return true;
        }

        throw new ForbiddenException('You are not the owner of this horse');
    }

    private async getOwnerOf(tokenId: string): Promise<string> {
        try {
            const c = this.getContractFor(tokenId);
            return await c.ownerOf(tokenId);
        } catch {
            throw new ForbiddenException(`Failed to verify on-chain owner for token ${tokenId}`);
        }
    }
}
