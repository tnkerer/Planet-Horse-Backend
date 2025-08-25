import { BadRequestException, Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { AppService } from './app.service';
import { Throttle } from '@nestjs/throttler';

interface SimulateRaceDto {
  level: number;
  positionBoost?: number;
}

// helpers
const softmax = (scores: number[]): number[] => {
  const m = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
};


const allowedMaxPosition = (level: number): number => {
  if (level < 5) return 10;
  if (level < 10) return 9;
  if (level < 15) return 8;
  if (level < 20) return 7;
  return 6;
};

// fair distribution using level, totalStats, baseDenominator, positionBoost
export function buildPositionDistribution({
  level,
  positionBoost = 1.0,
}: {
  level: number;
  positionBoost?: number;
}): number[] {
  // podium mass depends only on level (sigmoid), then scaled by item boost
  const Pmin = 0.15;
  const Pmax = 0.55;
  const center = 15;
  const scale = 6;
  const z = (level - center) / scale;
  let Ppodium = Pmin + (Pmax - Pmin) * (1 / (1 + Math.exp(-z)));

  Ppodium *= Math.max(0.0, positionBoost);        // allow any boost >= 0
  Ppodium = Math.max(0, Math.min(Ppodium, 0.80)); // safety ceiling

  // split 1–3
  const betaTop = 0.32;
  const podiumSplit = softmax([0, -betaTop, -2 * betaTop]);
  const P3 = Ppodium * podiumSplit[0];
  const P2 = Ppodium * podiumSplit[1];
  const P1 = Ppodium * podiumSplit[2];

  // split mids among allowed positions only
  const maxPos = allowedMaxPosition(level);       // <10:10, <15:9, <20:8, <25:7, else:6
  const midCount = Math.max(0, maxPos - 3);       // positions 4..maxPos
  const Prest = Math.max(0, 1 - Ppodium);

  let mids: number[] = [];
  if (midCount > 0) {
    const betaMid = 0.18 + 0.04 * ((level - 1) / 29);
    const midScores = Array.from({ length: midCount }, (_, i) => -i * betaMid);
    const midSplit = softmax(midScores);
    mids = midSplit.map(w => w * Prest);
  }

  // assemble P1..P10, zeroing disallowed
  const probs = Array(10).fill(0);
  probs[0] = P1; probs[1] = P2; probs[2] = P3;
  for (let i = 0; i < mids.length; i++) probs[3 + i] = mids[i];

  // normalize
  const s = probs.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < probs.length; i++) probs[i] = probs[i] / s;

  return probs;
}


// === sample position 1..10 from distribution
function samplePosition(dist: number[], rng: () => number = Math.random): number {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < dist.length; i++) {
    acc += dist[i];
    if (r <= acc) return i + 1;
  }
  return 6; // fallback
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('simulate')
  // @Throttle({ default: { limit: 200, ttl: 30_000 } })
  simulatePosition(@Body() body: SimulateRaceDto) {
    const { level, positionBoost = 1.0 } = body || {} as SimulateRaceDto;

    if (
      typeof level !== 'number' || level < 1 || level > 30 ||
      typeof positionBoost !== 'number' || positionBoost < 0
    ) {
      throw new BadRequestException('Invalid payload: { level(1-30), positionBoost>=0 }');
    }

    const dist = buildPositionDistribution({ level, positionBoost });
    const position = samplePosition(dist);

    return {
      input: { level, positionBoost },
      distribution: dist,            // array of 10 probabilities (sum ≈ 1)
      position,                      // 1..10 (subject to level-based removal)
    };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('metadata/horse/:tokenId')
  async getHorseMetadata(@Param('tokenId') tokenId: string, @Res() res: Response) {
    const json = await this.appService.getHorseMetadata(tokenId);
    res
      .setHeader('Content-Type', 'application/json; charset=utf-8')
      .setHeader('Cache-Control', 'public, max-age=300, s-maxage=300')
      .status(200)
      .send(JSON.stringify(json));
  }
}