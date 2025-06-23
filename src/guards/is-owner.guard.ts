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

const CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS;
const RPC_URL = process.env.RONIN_RPC_URL;

const ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
];

@Injectable()
export class IsOwnerGuard implements CanActivate {
    private provider: ethers.JsonRpcProvider;
    private contract: ethers.Contract;

    constructor(
        private reflector: Reflector,
        private readonly prisma: PrismaService,
    ) {
        this.provider = new ethers.JsonRpcProvider(RPC_URL);
        this.contract = new ethers.Contract(CONTRACT_ADDRESS!, ABI, this.provider);
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
                select: { id: true, ownerId: true },
            });

            if (horse && horse.ownerId !== user.id) {
                await this.prisma.$transaction(async (tx) => {
                    // 1. Update ownership
                    await tx.horse.update({
                        where: { tokenId },
                        data: { ownerId: user.id },
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
            return await this.contract.ownerOf(tokenId);
        } catch (err) {
            throw new ForbiddenException('Failed to verify ownership on-chain');
        }
    }
}
