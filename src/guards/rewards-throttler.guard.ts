// src/common/guards/rewards-throttler.guard.ts
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class RewardsThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const wallet  = req.user?.wallet as string;
    const tokenId = req.params?.tokenId as string;
    if (wallet && tokenId) {
      return `rewards:${wallet}:${tokenId}`;
    }
    // fallback to IP if something’s missing
    return super.getTracker(req);
  }
}
