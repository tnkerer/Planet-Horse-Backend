// src/user/user.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UserService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Finds a user by wallet address or creates one with phorse = 0.
     */
    async findOrCreateByAddress(address: string) {
        return this.prisma.user.upsert({
            where: { wallet: address },
            create: {
                wallet: address,
                phorse: 0,
                // name is nullable by default,
                // horses, items, transactions start empty
            },
            update: {
                // nothing to change if already exists
            },
        });
    }

    async getBalance(wallet: string) {
        const u = await this.prisma.user.findUnique({
            where: { wallet },
            select: { phorse: true },
        });
        return u?.phorse;
    }
}
