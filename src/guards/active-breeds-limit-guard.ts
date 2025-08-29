// guards/active-breeds-limit.guard.ts
import { CanActivate, ExecutionContext, Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ActiveBreedsLimitGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const wallet = (req.user?.wallet || '').toLowerCase();
    if (!wallet) throw new BadRequestException('Missing authenticated wallet');

    const user = await this.prisma.user.findUnique({
      where: { wallet },
      select: { id: true },
    });
    if (!user) throw new BadRequestException('User not found');

    const active = await this.prisma.breed.count({
      where: { ownerId: user.id, finalized: false },
    });

    if (active >= 2) {
      throw new BadRequestException('You already have two active breedings');
    }
    return true;
  }
}
