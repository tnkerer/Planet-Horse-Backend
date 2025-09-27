export type StableLevel = 1 | 2 | 3 | 4;


export const STABLE_META = {
  extraTickEveryHours: 8,            // Stable-only extra energy tick cadence
} as const;

/** Per-level static data used by UI and game logic */
export type StableLevelInfo = {
  level: StableLevel;
  capacity: number;              // Horse capacity at this level
  simultaneousBreeds: number;    // Max parallel breeds at this level
  extraEnergyPerTick: number;    // Extra energy granted to each housed horse every 8h
  upgradeCostPhorse: number;     // Cost to upgrade *to* this level (PHORSE); 0 for L1 (own the NFT)
};


/** Canonical per-level table from the docs */
export const STABLE_LEVELS: Readonly<Record<StableLevel, StableLevelInfo>> = {
  1: {
    level: 1,
    capacity: 16,
    simultaneousBreeds: 8,
    extraEnergyPerTick: 1,
    upgradeCostPhorse: 200_000
  },
  2: {
    level: 2,
    capacity: 32,
    simultaneousBreeds: 16,
    extraEnergyPerTick: 3,
    upgradeCostPhorse: 400_000
  },
  3: {
    level: 3,
    capacity: 64,
    simultaneousBreeds: 32,
    extraEnergyPerTick: 5,
    upgradeCostPhorse: 600_000
  },
  4: {
    level: 4,
    capacity: 128,
    simultaneousBreeds: 64,
    extraEnergyPerTick: 7,
    upgradeCostPhorse: 1_200_000
  },
} as const;