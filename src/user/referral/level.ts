export interface ReferralLevel {
  level: number;
  cumulativeXP: number;
  percentReward: number;
  title: string | null;
}

export const levels: ReferralLevel[] = [
  {
    level: 1,
    cumulativeXP: 0,
    percentReward: 0,
    title: null
  },
  {
    level: 2,
    cumulativeXP: 150,
    percentReward: 1,
    title: null
  },
  {
    level: 3,
    cumulativeXP: 500,
    percentReward: 2,
    title: 'Stablehand'
  },
  {
    level: 4,
    cumulativeXP: 1200,
    percentReward: 3.5,
    title: null
  },
  {
    level: 5,
    cumulativeXP: 2500,
    percentReward: 5,
    title: null
  },
  {
    level: 6,
    cumulativeXP: 5000,
    percentReward: 7,
    title: 'Herd Leader'
  },
  {
    level: 7,
    cumulativeXP: 9000,
    percentReward: 9,
    title: null
  },
  {
    level: 8,
    cumulativeXP: 15000,
    percentReward: 11,
    title: 'Grand Jockey'
  },
  {
    level: 9,
    cumulativeXP: 24000,
    percentReward: 13,
    title: null
  },
  {
    level: 10,
    cumulativeXP: 40000,
    percentReward: 15,
    title: 'Planetary Champion'
  }
];
