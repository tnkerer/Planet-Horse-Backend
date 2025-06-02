// src/guards/dev-only.guard.ts
import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';

@Injectable()
export class DevOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Allow if NODE_ENV is not 'production'
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv === 'production') {
      throw new ForbiddenException('This endpoint is only available in development/beta builds.');
    }
    return true;
  }
}
