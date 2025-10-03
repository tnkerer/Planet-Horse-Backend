import {
    Injectable,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
} from '@nestjs/common';
import { ethers } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import * as dotenv from 'dotenv';
dotenv.config();

// Hardcoded Stable contract (per your request)
const STABLE_CONTRACT_ADDRESS = '0x0d9e46be52fde86a0f1070725179b7a0d59229f7';
const RPC_URL = process.env.RONIN_RPC_URL!;

const ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
];

@Injectable()
export class IsStableOwnerGuard implements CanActivate {
    private readonly provider: ethers.JsonRpcProvider;
    private readonly contract: ethers.Contract;

    constructor(private readonly prisma: PrismaService) {
        this.provider = new ethers.JsonRpcProvider(RPC_URL);
        this.contract = new ethers.Contract(STABLE_CONTRACT_ADDRESS, ABI, this.provider);
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();

        const tokenId: string | undefined = request.params?.tokenId;
        const wallet: string | undefined = request.user?.wallet?.toLowerCase();

        if (!wallet) {
            throw new ForbiddenException('Missing authenticated wallet');
        }
        if (!tokenId || !/^\d+$/.test(tokenId)) {
            throw new ForbiddenException('Invalid tokenId');
        }

        // 1) Verify on-chain ownership
        const onChainOwner = await this.getOwnerOf(tokenId);
        if (onChainOwner.toLowerCase() !== wallet) {
            throw new ForbiddenException('You are not the owner of this stable');
        }

        // 2) Ensure DB consistency (idempotent)
        const user = await this.prisma.user.upsert({
            where: { wallet },
            update: {},
            create: { wallet },
            select: { id: true },
        });

        const stable = await this.prisma.stable.findUnique({
            where: { tokenId },
            select: { id: true, userId: true },
        });

        if (stable && stable.userId !== user.id) {
            await this.prisma.$transaction(async (tx) => {
                // 1) Reassign stable ownership
                await tx.stable.update({
                    where: { tokenId },
                    data: { userId: user.id, updatedAt: new Date() },
                });
                // 2) Clear all horse assignments pointing to this stable
                await tx.horse.updateMany({
                    where: { stableid: stable.id },   // ← note: 'stableid' (lowercase) as requested
                    data: { stableid: null },
                });
            });
        }

        return true;
    }

    private async getOwnerOf(tokenId: string): Promise<string> {
        try {
            // Pass tokenId as string; ethers will handle BN conversion
            return await this.contract.ownerOf(tokenId);
        } catch {
            // Typically reverts if token doesn’t exist
            throw new ForbiddenException(`Failed to verify on-chain owner for stable #${tokenId}`);
        }
    }
}
