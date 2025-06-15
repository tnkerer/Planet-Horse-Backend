export interface TaxBracket {
  maxHours: number;
  userPct: number; // % user keeps
}

export const withdrawTaxConfig: TaxBracket[] = [
  { maxHours: 24, userPct: 50 },
  { maxHours: 48, userPct: 60 },
  { maxHours: 72, userPct: 70 },
  { maxHours: 96, userPct: 80 },
  { maxHours: 120, userPct: 90 },
  { maxHours: Infinity, userPct: 100 },
];

export function getWithdrawTax(hoursSinceLast: number): TaxBracket {
  return withdrawTaxConfig.find(b => hoursSinceLast <= b.maxHours)!;
}
