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
}
