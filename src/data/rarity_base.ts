export const rarityBase = {
    Common: {
      "Max lvl": 10,
      "Growth Min": 1,
      "Growth Max": 1.8,
      "Starting Stats": [1, 3],
      "Origin Breeding": 14,
      "Breeding Chances": [89, 9, 1, 1, 0, 0]
    },
    Uncommon: {
      "Max lvl": 10,
      "Growth Min": 1.2,
      "Growth Max": 2.2,
      "Starting Stats": [2, 4],
      "Origin Breeding": 16,
      "Breeding Chances": [5, 80, 12, 2, 1, 0]
    },
    Rare: {
      "Max lvl": 15,
      "Growth Min": 1.4,
      "Growth Max": 2.8,
      "Starting Stats": [3, 6],
      "Origin Breeding": 18,
      "Breeding Chances": [1, 6, 80, 8, 3, 1.5, 0.5]
    },
    Epic: {
      "Max lvl": 20,
      "Growth Min": 1.8,
      "Growth Max": 3.2,
      "Starting Stats": [4, 8],
      "Origin Breeding": 20,
      "Breeding Chances": [0.5, 1.5, 6, 80, 9, 3]
    },
    Legendary: {
      "Max lvl": 25,
      "Growth Min": 2.2,
      "Growth Max": 3.9,
      "Starting Stats": [5, 10],
      "Origin Breeding": 22,
      "Breeding Chances": [0, 0.5, 2, 25, 62.5, 10]
    },
    Mythic: {
      "Max lvl": 30,
      "Growth Min": 2.6,
      "Growth Max": 4.5,
      "Starting Stats": [6, 12],
      "Origin Breeding": 24,
      "Breeding Chances": [0, 0, 1, 20, 40, 39]
    }
  } as const;
  