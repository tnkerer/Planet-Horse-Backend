export const QUEST_SEED_DATA = [
  // 1. DAILY_CHECKIN
  {
    id: 1,
    title: 'Daily Checkin',
    description: 'Log in to the game daily',
    questType: 'DAILY_CHECKIN',
    reward: [
      { type: 'shards', amount: 250 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 0,
  },

  // 2. WIN_RACES
  {
    id: 2,
    title: 'Victorious',
    description: 'Win 3 races in 1st place',
    questType: 'WIN_RACES',
    reward: [
      { type: 'shards', amount: 1200 },
      { type: 'medals', amount: 35 },
    ],
    questsToComplete: 3,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 15,
  },

  // 3. RUN_RACES
  {
    id: 3,
    title: 'First Race',
    description: 'Complete your first race',
    questType: 'RUN_RACES',
    reward: [
      { type: 'shards', amount: 175 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 1,
  },

  {
    id: 4,
    title: 'Pro Jockey',
    description: 'Complete 10 races',
    questType: 'RUN_RACES',
    reward: [
      { type: 'shards', amount: 400 },
      { type: 'item', itemName: 'Pumpers', amount: 1}
    ],
    questsToComplete: 10,
    difficulty: 'SIMPLE',
    isDailyQuest: false,
    horsesToUnlock: 5,
  },

  // 5. LEVEL_UP_HORSES
  {
    id: 5,
    title: 'Level Up',
    description: 'Level up any horse',
    questType: 'LEVEL_UP_HORSES',
    reward: [
      { type: 'shards', amount: 400 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 5,
  },

/*   // 6. EQUIP_ITEMS
  {
    id: 6,
    title: 'First Equipment',
    description: 'Equip an item on your horse',
    questType: 'EQUIP_ITEMS',
    reward: [
      { type: 'phorse', amount: 100 },
      { type: 'medals', amount: 10 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: false,
    horsesToUnlock: 1,
  }, */

  // 7. OPEN_CHESTS
  {
    id: 7,
    title: 'First Treasure',
    description: 'Open your first chest',
    questType: 'OPEN_CHESTS',
    reward: [
      { type: 'shards', amount: 150 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 0,
  },

  // 8. SPEND_PHORSE
  {
    id: 8,
    title: 'Big Spender',
    description: 'Spend 15000 PHORSE tokens',
    questType: 'SPEND_PHORSE',
    reward: [
      { type: 'shards', amount: 800 },
      { type: 'medals', amount: 15 },
    ],
    questsToComplete: 15000,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 10,
  },

  // 9. EARN_PHORSE
  {
    id: 9,
    title: 'Money Maker',
    description: 'Earn 7000 PHORSE tokens',
    questType: 'EARN_PHORSE',
    reward: [
      { type: 'shards', amount: 100 },
      { type: 'item', itemName: 'Maneki-Neko', amount: 1}
    ],
    questsToComplete: 7000,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 0,
  },

  // 10. UPGRADE_ITEMS
  {
    id: 10,
    title: 'First Upgrade',
    description: 'Upgrade an item',
    questType: 'UPGRADE_ITEMS',
    reward: [
      { type: 'phorse', amount: 1000 },
      { type: 'shards', amount: 150 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 0,
  },

  // 11. RECYCLE_ITEMS
  {
    id: 11,
    title: 'Recycler',
    description: 'Recycle an item for resources',
    questType: 'RECYCLE_ITEMS',
    reward: [
      { type: 'shards', amount: 75 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 0,
  },


/*     // 12. RESTORE_ENERGY
  {
    id: 12,
    title: 'Energy Boost',
    description: 'Restore any horse energy',
    questType: 'RESTORE_ENERGY',
    reward: [
      { type: 'shards', amount: 125 },
      { type: 'medals', amount: 5 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 10,
  },
// 13. CLAIM_REWARDS
  {
    id: 13,
    title: 'Reward Collector',
    description: 'Claim your first quest reward',
    questType: 'CLAIM_REWARDS',
    reward: [
      { type: 'phorse', amount: 100 },
      { type: 'medals', amount: 10 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: false,
    horsesToUnlock: 0,
  }, */
];
