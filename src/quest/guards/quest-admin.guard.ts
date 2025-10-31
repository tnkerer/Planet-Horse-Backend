import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';

/**
 * Quest Admin Guard
 *
 * Security guard that restricts quest creation and admin operations
 * to authorized wallet addresses only.
 *
 * IMPORTANT: This guard MUST be used with JwtAuthGuard to ensure
 * the user is authenticated before checking admin permissions.
 *
 * Usage:
 * @UseGuards(JwtAuthGuard, QuestAdminGuard)
 */
@Injectable()
export class QuestAdminGuard implements CanActivate {
  private readonly ADMIN_WALLETS = [
    '0x4dF7707Bb8BBf59C7f30F7403865a7C1aA837D6A',
    '0xD48Aad987e8400e0411486C14b56A0Bf357DaFBc',
  ];

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.wallet) {
      throw new UnauthorizedException('Authentication required');
    }

    const userWallet = user.wallet.toLowerCase();

    const isAdmin = this.ADMIN_WALLETS.some(
      adminWallet => adminWallet.toLowerCase() === userWallet
    );

    if (!isAdmin) {
      console.warn(
        `[SECURITY] Unauthorized quest admin access attempt by wallet: ${user.wallet}`
      );

      throw new ForbiddenException(
        'Access denied. Quest administration requires special permissions.'
      );
    }

    console.log(`[SECURITY] Quest admin access granted to: ${user.wallet}`);
    return true;
  }
}
