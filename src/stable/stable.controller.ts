// src/stable/stable.controller.ts
import { Controller, Post, Body, Request, UseGuards, Get, Param } from '@nestjs/common';
import { StableService } from './stable.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IsStableOwnerGuard } from 'src/guards/is-stable-owner.guard';

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

    @Get('blockchain')
    listFromBlockchain(@Request() req) {
        return this.stableService.listBlockchainStable(req.user.wallet);
    }

    @UseGuards(IsStableOwnerGuard)
    /** Start upgrade (deducts PHORSE atomically and marks upgrading) */
    @Post(':tokenId/upgrade')
    startUpgrade(@Request() req, @Param('tokenId') tokenId: string) {
        return this.stableService.startUpgrade(req.user.wallet, tokenId);
    }

    /** Check upgrade status/ETA */
    @Get(':tokenId/upgrade')
    getUpgrade(@Request() req, @Param('tokenId') tokenId: string) {
        return this.stableService.getUpgradeEta(req.user.wallet, tokenId);
    }

    @UseGuards(IsStableOwnerGuard)
    /** Finalize upgrade (only when time has elapsed) */
    @Post(':tokenId/upgrade/finish')
    finishUpgrade(@Request() req, @Param('tokenId') tokenId: string) {
        return this.stableService.finishUpgrade(req.user.wallet, tokenId);
    }

    @Get(':tokenId/status')
    getStatus(@Request() req, @Param('tokenId') tokenId: string) {
        return this.stableService.getStableStatus(req.user.wallet, tokenId);
    }

    /** Assign one of the user's horses to this stable (capacity-limited) */
    @UseGuards(IsStableOwnerGuard)
    @Post(':tokenId/assign')
    assignHorse(
        @Request() req,
        @Param('tokenId') tokenId: string,
        @Body() body: { horseId: number },
    ) {
        return this.stableService.assignHorseToStable(req.user.wallet, tokenId, Number(body.horseId));
    }

    /** Remove a horse from this stable (24h cooldown since last assignment) */
    @UseGuards(IsStableOwnerGuard)
    @Post(':tokenId/remove')
    removeHorse(
        @Request() req,
        @Param('tokenId') tokenId: string,
        @Body() body: { horseId: number },
    ) {
        return this.stableService.removeHorseFromStable(req.user.wallet, tokenId, Number(body.horseId));
    }

    @Get('uuid/:uuid')
    getByUUID(@Param('uuid') uuid: string) {
        if(uuid == 'null' || uuid == 'NULL') return null;
        return this.stableService.getStableByUUID(uuid);
    }


}
