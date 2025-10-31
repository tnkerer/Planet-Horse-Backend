/**
 * Quest Type Definitions
 * Defines all available quest types and their corresponding trigger actions
 */

export enum QuestType {
  WIN_RACES = 'WIN_RACES',           // Win X races
  RUN_RACES = 'RUN_RACES',           // Complete X races (any position)
  BREED_HORSES = 'BREED_HORSES',     // Breed X horses
  LEVEL_UP_HORSES = 'LEVEL_UP_HORSES', // Level up X horses
  EQUIP_ITEMS = 'EQUIP_ITEMS',       // Equip X items on horses
  OPEN_CHESTS = 'OPEN_CHESTS',       // Open X chests
  SPEND_PHORSE = 'SPEND_PHORSE',     // Spend X PHORSE tokens
  EARN_PHORSE = 'EARN_PHORSE',       // Earn X PHORSE tokens
  UPGRADE_ITEMS = 'UPGRADE_ITEMS',   // Upgrade X items
  RECYCLE_ITEMS = 'RECYCLE_ITEMS',   // Recycle X items
  RESTORE_ENERGY = 'RESTORE_ENERGY', // Restore energy X times
  CLAIM_REWARDS = 'CLAIM_REWARDS',   // Claim X quest rewards
  DAILY_CHECKIN = 'DAILY_CHECKIN',   // Daily check-in
}

export const QUEST_TYPE_LABELS: Record<QuestType, string> = {
  [QuestType.WIN_RACES]: 'Win Races',
  [QuestType.RUN_RACES]: 'Complete Races',
  [QuestType.BREED_HORSES]: 'Breed Horses',
  [QuestType.LEVEL_UP_HORSES]: 'Level Up Horses',
  [QuestType.EQUIP_ITEMS]: 'Equip Items',
  [QuestType.OPEN_CHESTS]: 'Open Chests',
  [QuestType.SPEND_PHORSE]: 'Spend PHORSE',
  [QuestType.EARN_PHORSE]: 'Earn PHORSE',
  [QuestType.UPGRADE_ITEMS]: 'Upgrade Items',
  [QuestType.RECYCLE_ITEMS]: 'Recycle Items',
  [QuestType.RESTORE_ENERGY]: 'Restore Energy',
  [QuestType.CLAIM_REWARDS]: 'Claim Rewards',
  [QuestType.DAILY_CHECKIN]: 'Daily Check-in',
};

export const QUEST_TYPE_DESCRIPTIONS: Record<QuestType, string> = {
  [QuestType.WIN_RACES]: 'Win races in first place',
  [QuestType.RUN_RACES]: 'Complete races in any position',
  [QuestType.BREED_HORSES]: 'Successfully breed horses',
  [QuestType.LEVEL_UP_HORSES]: 'Level up your horses',
  [QuestType.EQUIP_ITEMS]: 'Equip items on your horses',
  [QuestType.OPEN_CHESTS]: 'Open treasure chests',
  [QuestType.SPEND_PHORSE]: 'Spend PHORSE tokens',
  [QuestType.EARN_PHORSE]: 'Earn PHORSE tokens from activities',
  [QuestType.UPGRADE_ITEMS]: 'Upgrade your items',
  [QuestType.RECYCLE_ITEMS]: 'Recycle items for resources',
  [QuestType.RESTORE_ENERGY]: 'Restore horse energy',
  [QuestType.CLAIM_REWARDS]: 'Claim quest rewards',
  [QuestType.DAILY_CHECKIN]: 'Complete daily check-in',
};

/**
 * Helper to get the next midnight UTC
 * Used for daily quest expiration
 */
export function getNextMidnightUTC(): Date {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return nextMidnight;
}

/**
 * Check if a date is past midnight UTC
 */
export function isPastMidnightUTC(date: Date): boolean {
  const now = new Date();
  return date < now;
}
