export const QUEST_SEED_DATA = [
  // 1. DAILY_CHECKIN
  {
    id: 1,
    title: 'Daily Checkin',
    description: 'Log in to the game daily',
    questType: 'DAILY_CHECKIN',
    reward: [
      { type: 'phorse', amount: 50 },
      { type: 'medals', amount: 10 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 0,
  },

/*   // 2. WIN_RACES
  {
    id: 2,
    title: 'First Victory',
    description: 'Win your first race with any horse',
    questType: 'WIN_RACES',
    reward: [
      { type: 'phorse', amount: 100 },
      { type: 'medals', amount: 15 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: false,
    horsesToUnlock: 1,
  }, */

  // 3. RUN_RACES
  {
    id: 3,
    title: 'First Race',
    description: 'Complete your first race',
    questType: 'RUN_RACES',
    reward: [
      { type: 'phorse', amount: 75 },
      { type: 'medals', amount: 10 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 1,
  },

/*   // 4. BREED_HORSES
  {
    id: 4,
    title: 'First Breed',
    description: 'Breed two horses together for the first time',
    questType: 'BREED_HORSES',
    reward: [
      { type: 'phorse', amount: 200 },
      { type: 'medals', amount: 20 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: false,
    horsesToUnlock: 2,
  }, */

  // 5. LEVEL_UP_HORSES
  {
    id: 5,
    title: 'Level Up',
    description: 'Level up any horse',
    questType: 'LEVEL_UP_HORSES',
    reward: [
      { type: 'phorse', amount: 150 },
      { type: 'medals', amount: 15 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 1,
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
      { type: 'phorse', amount: 150 },
      { type: 'medals', amount: 20 },
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
    description: 'Spend 100 PHORSE tokens',
    questType: 'SPEND_PHORSE',
    reward: [
      { type: 'phorse', amount: 50 },
      { type: 'medals', amount: 15 },
    ],
    questsToComplete: 100,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 0,
  },

  // 9. EARN_PHORSE
  {
    id: 9,
    title: 'Money Maker',
    description: 'Earn 200 PHORSE tokens',
    questType: 'EARN_PHORSE',
    reward: [
      { type: 'phorse', amount: 100 },
      { type: 'medals', amount: 20 },
    ],
    questsToComplete: 200,
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
      { type: 'phorse', amount: 150 },
      { type: 'medals', amount: 15 },
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
      { type: 'phorse', amount: 75 },
      { type: 'medals', amount: 10 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: true,
    horsesToUnlock: 0,
  },

/*   // 12. RESTORE_ENERGY
  {
    id: 12,
    title: 'Energy Boost',
    description: 'Restore horse energy for the first time',
    questType: 'RESTORE_ENERGY',
    reward: [
      { type: 'phorse', amount: 50 },
      { type: 'medals', amount: 5 },
    ],
    questsToComplete: 1,
    difficulty: 'SIMPLE',
    isDailyQuest: false,
    horsesToUnlock: 1,
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
