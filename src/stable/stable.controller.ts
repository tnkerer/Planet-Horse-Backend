// src/stable/stable.controller.ts
import { Controller, Post, Body, Request, UseGuards, Get } from '@nestjs/common';
import { StableService } from './stable.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { ThrottlerGuard } from '@nestjs/throttler';

@Controller('stable')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class StableController {
    constructor(private readonly stableService: StableService) { }

    @Post('buy')
    buy(@Request() req, @Body() body: { salePhase: 'GTD' | 'FCFS' }) {
        return this.stableService.buyStable(req.user.wallet, body.salePhase);
    }

    @Get('max-token-id')
    getMaxTokenId() {
        return this.stableService.getMaxStableTokenId();
    }
}
