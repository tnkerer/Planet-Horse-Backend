import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { globals } from 'src/data/globals';

interface Attribute {
  trait_type: string;
  value: string | number;
}

interface Metadata {
  name: string;
  description: string;
  image: string;
  attributes: Attribute[];
}

export type LevelUpSuccess = {
  status: 200;
  data: {
    level: number;
    power: number;
    sprint: number;
    speed: number;
    energy: number;
  };
};

export type LevelUpError = {
  status: 400 | 404;
  error: string;
};

export type RewardsSuccess = { status: 200; data: { xpReward: string; tokenReward: string; position: number } };
export type RewardsError = { status: 400 | 404; error: string };

@Injectable()
export class UtilsService {

  async levelUpOld(
    horseId: string,
    growth: number
  ): Promise<LevelUpSuccess | LevelUpError> {
    // utils.service.ts
    const metadataDir = path.join(__dirname, '..', 'assets', 'metadata');
    const filePath = path.join(metadataDir, `${horseId}.json`);

    try {
      // 2. Load existing metadata
      const raw = await fs.readFile(filePath, 'utf-8');
      const meta = JSON.parse(raw) as Metadata;

      // 3a. Bump level
      const lvlAttr = meta.attributes.find(a => a.trait_type === 'Level');
      if (!lvlAttr || typeof lvlAttr.value !== 'number') {
        return { status: 400, error: 'Invalid metadata: missing Level attribute' };
      }
      const newLevel = lvlAttr.value + 1;
      lvlAttr.value = newLevel;

      // 3b. Increase stats by growth * newLevel
      const inc = growth * newLevel;
      for (const stat of ['Power', 'Sprint', 'Speed'] as const) {
        const statAttr = meta.attributes.find(a => a.trait_type === stat);
        if (!statAttr || typeof statAttr.value !== 'number') {
          return { status: 400, error: `Invalid metadata: missing ${stat} attribute` };
        }
        const updated = statAttr.value + inc;
        statAttr.value = Number(updated.toFixed(2));
      }

      // 3c. Increase Energy
      const energyAttr = meta.attributes.find(a => a.trait_type === 'Energy');
      if (!energyAttr || typeof energyAttr.value !== 'number') {
        return { status: 400, error: `Invalid metadata: missing Energy attribute` };
      }
      const updatedEnergy = energyAttr.value + 3;
      energyAttr.value = Number(updatedEnergy.toFixed(2));

      // 4. Overwrite JSON file
      await fs.writeFile(filePath, JSON.stringify(meta, null, 2), 'utf-8');

      // 5. Return 20X on success
      const power = (meta.attributes.find(a => a.trait_type === 'Power')!.value as number);
      const sprint = (meta.attributes.find(a => a.trait_type === 'Sprint')!.value as number);
      const speed = (meta.attributes.find(a => a.trait_type === 'Speed')!.value as number);
      const energy = (meta.attributes.find(a => a.trait_type === 'Energy')!.value as number);

      return {
        status: 200,
        data: { level: newLevel, power, sprint, speed, energy }
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // file not found
        return { status: 404, error: 'Metadata file not found' };
      }
      // other errors => client error
      return { status: 400, error: `Failed to level up: ${err.message}` };
    }
  }

  /**
* calculateRewards:
* 1. loads metadata/{horseId}.json
* 2. computes baseRewardModifier = (Power + Sprint + Speed) / Base Denominator
* 3. rolls random [0,100), adds 2.5 * level
* 4. finds the highest Winrates threshold ≤ rolledNumber → that gives `position`
*    e.g. if rolledNumber = 80, thresholds ≤80 are [0,1,4,8,13,25,35,45,65], highest is 65 ⇒ winrates["65"] = 2
* 5. looks up globals["Rewards"][position] → [xpBase, tokenBase]
* 6. returns xpBase * modifier and tokenBase * modifier
*/
  async calculateRewardsOld(horseId: string): Promise<RewardsSuccess | RewardsError> {
    const metadataDir = path.join(__dirname, '..', 'assets', 'metadata');
    const filePath = path.join(metadataDir, `${horseId}.json`);

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const meta = JSON.parse(raw) as Metadata;

      // extract numeric traits
      const getAttr = (t: string) => meta.attributes.find(a => a.trait_type === t)?.value as number;
      const power = getAttr('Power');
      const sprint = getAttr('Sprint');
      const speed = getAttr('Speed');
      const level = getAttr('Level');
      if ([power, sprint, speed, level].some(v => typeof v !== 'number')) {
        return { status: 400, error: 'Invalid metadata: missing Power/Sprint/Speed/Level' };
      }

      // 3. base reward modifier
      const denom = globals['Base Denominator'] as number;
      const baseRewardModifier = (power + sprint + speed) / denom;

      // 4–5. roll + level bonus
      const roll = Math.random() * 100;
      const adjRoll = roll + 2.5 * level;

      // 6. determine position via Winrates thresholds
      const winrates = globals['Winrates'] as Record<string, number>;
      const thresholds = Object.keys(winrates)
        .map(k => parseFloat(k))
        .sort((a, b) => a - b);

      // pick highest threshold ≤ adjRoll
      let chosenThreshold = thresholds[0];
      for (const t of thresholds) {
        if (adjRoll >= t) chosenThreshold = t;
        else break;
      }
      const position = winrates[chosenThreshold.toString()];
      // e.g. adjRoll=80 ⇒ chosenThreshold=65 ⇒ position=winrates["65"]=2

      // 7. lookup base XP & TOKEN, apply modifier
      const rewardsCfg = globals['Rewards'] as Record<string, readonly [number, number]>;
      const [xpBase, tokenBase] = rewardsCfg[position.toString()];
      const xpReward = (xpBase * baseRewardModifier).toFixed(2);
      const tokenReward = (tokenBase * baseRewardModifier).toFixed(2);

      return {
        status: 200,
        data: { xpReward, tokenReward, position }
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { status: 404, error: 'Metadata file not found' };
      }
      return { status: 400, error: `Failed to calculate rewards: ${err.message}` };
    }
  }

  async getHorseMetadataOld(horseId: string): Promise<Metadata> {
    const metadataDir = path.join(__dirname, '..', 'assets', 'metadata');
    const filePath    = path.join(metadataDir, `${horseId}.json`);

    try {
      const raw  = await fs.readFile(filePath, 'utf-8');
      const meta = JSON.parse(raw) as Metadata;
      return meta;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new NotFoundException(`Metadata for horse "${horseId}" not found.`);
      }
      throw new InternalServerErrorException(
        `Failed to load metadata for "${horseId}": ${err.message}`
      );
    }
  }
  
}
