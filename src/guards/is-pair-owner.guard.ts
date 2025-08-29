// guards/is-pair-owner.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ethers } from 'ethers';

const CONTRACT_ADDRESS_LEGACY = process.env.NFT_CONTRACT_ADDRESS!;        // up to 2202
const CONTRACT_ADDRESS_OFH = process.env.NFT_CONTRACT_ADDRESS_OFH!;    // 2203+

const RPC_URL = process.env.RONIN_RPC_URL!;
const LEGACY_MAX_TOKEN_ID = 2202 as const;

const ABI = ['function ownerOf(uint256 tokenId) view returns (address)'];

@Injectable()
export class IsPairOwnerGuard implements CanActivate {
  private provider: ethers.JsonRpcProvider;
  private contractLegacy: ethers.Contract;
  private contractOFH: ethers.Contract;

  constructor(private readonly prisma: PrismaService) {
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

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const wallet = (req.user?.wallet || '').toLowerCase();
    const a = req.body?.a;
    const b = req.body?.b;

    if (!a || !b) throw new ForbiddenException('Missing token IDs "a" and/or "b"');

    // On-chain ownership for both tokens
    const [ownerA, ownerB] = await Promise.all([
      this.ownerOf(a),
      this.ownerOf(b),
    ]);

    if (ownerA.toLowerCase() !== wallet || ownerB.toLowerCase() !== wallet) {
      throw new ForbiddenException('Caller does not own both horses on-chain');
    }

    // Upsert user once, reuse id
    const user = await this.prisma.user.upsert({
      where: { wallet },
      update: {},
      create: { wallet },
      select: { id: true },
    });

    // Sync DB ownership for both tokenIds (and unequip items if owner changed)
    const parents = await this.prisma.horse.findMany({
      where: { tokenId: { in: [a, b] } },
      select: { id: true, ownerId: true, tokenId: true },
    });

    // For each found horse, if ownerId != user.id, fix owner and unequip items
    for (const h of parents) {
      if (h.ownerId && h.ownerId !== user.id) {
        await this.prisma.$transaction(async (tx) => {
          await tx.horse.update({ where: { id: h.id }, data: { ownerId: user.id, ownedSince: new Date() } });
          await tx.item.updateMany({ where: { horseId: h.id }, data: { horseId: null } });
        });
      }
    }

    // Proceed — service layer will still re-validate all breeding constraints.
    return true;
  }

  private async ownerOf(tokenId: string): Promise<string> {
    try {
      const c = this.getContractFor(tokenId);
      return await c.ownerOf(tokenId);
    } catch {
      throw new ForbiddenException(`Failed to verify on-chain owner for token ${tokenId}`);
    }
  }
}
