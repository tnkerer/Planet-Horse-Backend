// src/horse/dto/public-horse.dto.ts
export class PublicHorseDto {
  id: string;
  tokenId: string;
  name: string;
  nickname?: string | null;
  rarity: string;
  sex: string;
  status: string;

  level: number;
  exp: number;
  upgradable: boolean;

  basePower: number;
  currentPower: number;
  baseSprint: number;
  currentSprint: number;
  baseSpeed: number;
  currentSpeed: number;

  currentEnergy: number;
  maxEnergy: number;

  gen: number;
  currentBreeds: number;
  maxBreeds?: number | null;
  legacy: boolean;
  growthPotential?: number | null;
  traitSlotsUnlocked: number;
  careerfactor: number;
  mmr: number;

  equipments: { name: string }[];
}
