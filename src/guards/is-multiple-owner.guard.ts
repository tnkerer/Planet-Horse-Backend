// src/guards/is-multiple-owner.guard.ts

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ethers } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';

const CONTRACT_ADDRESS_LEGACY = process.env.NFT_CONTRACT_ADDRESS!;        // up to 2202
const CONTRACT_ADDRESS_OFH = process.env.NFT_CONTRACT_ADDRESS_OFH!;    // 2203+

const RPC_URL = process.env.RONIN_RPC_URL!;
const LEGACY_MAX_TOKEN_ID = 2202 as const;

const ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
];

@Injectable()
export class IsMultipleOwnerGuard implements CanActivate {
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
    const req = context.switchToHttp().getRequest();
    const tokenIds: string[] = req.body.tokenIds;
    const wallet: string = (req.user.wallet as string).toLowerCase();

    if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
      throw new ForbiddenException('tokenIds array is missing or empty');
    }

    // 1) Verify on-chain ownership for each token
    const owners = await Promise.all(
      tokenIds.map(id => this.getOwnerOf(id).then(addr => addr.toLowerCase()))
    );

    for (let i = 0; i < tokenIds.length; i++) {
      if (owners[i] !== wallet) {
        throw new ForbiddenException(`You are not the on-chain owner of token ${tokenIds[i]}`);
      }
    }

    // 2) Upsert the user in DB
    const user = await this.prisma.user.upsert({
      where: { wallet },
      update: {},
      create: { wallet },
      select: { id: true },
    });

    // 3) Load existing horse records and fix any mismatches
    const horses = await this.prisma.horse.findMany({
      where: { tokenId: { in: tokenIds } },
      select: { id: true, tokenId: true, ownerId: true },
    });

    const mismatchedIds = horses
      .filter(h => h.ownerId !== user.id)
      .map(h => h.id);

    if (mismatchedIds.length > 0) {
      await this.prisma.$transaction(async tx => {
        // reassign ownership
        await tx.horse.updateMany({
          where: { id: { in: mismatchedIds } },
          data: { ownerId: user.id, ownedSince: new Date() },
        });
        // unequip items
        await tx.item.updateMany({
          where: { horseId: { in: mismatchedIds } },
          data: { horseId: null },
        });
      });
    }

    return true;
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
