interface WithdrawTaxConfig {
  /** % of the payout the user keeps on day 0 (i.e. initial) */
  initialUserPct: number;
  /** how many % to *add* to user’s share each step */
  stepPct: number;
  /** how many hours between each step */
  stepIntervalHours: number;
  /** never exceed this */
  maxUserPct: number;
}
/**
 * Given hours since last withdrawal (or 0 if none),
 * return the % of the value the user actually receives.
 */
export function getWithdrawUserPct(
  hoursSince: number,
  cfg: WithdrawTaxConfig
): number {
  // Treat “never withdrawn” as 0h elapsed → day 0 rate
  const steps = Math.floor(hoursSince / cfg.stepIntervalHours);
  const pct   = cfg.initialUserPct + steps * cfg.stepPct;
  return Math.min(pct, cfg.maxUserPct);
}
