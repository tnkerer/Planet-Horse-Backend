export const rarityBase = {
    Common: {
      "Max lvl": 10,
      "Growth Min": 1,
      "Growth Max": 1.8,
      "Starting Stats": [1, 3],
      "Origin Breeding": 14,
      "Breeding Chances": [73, 21, 5, 1, 0, 0],
      "Breeding Base Price" : 10
    },
    Uncommon: {
      "Max lvl": 10,
      "Growth Min": 1.2,
      "Growth Max": 2.2,
      "Starting Stats": [2, 4],
      "Origin Breeding": 16,
      "Breeding Chances": [30, 55, 13, 2, 0, 0],
      "Breeding Base Price" : 12.5
    },
    Rare: {
      "Max lvl": 15,
      "Growth Min": 1.4,
      "Growth Max": 2.8,
      "Starting Stats": [3, 6],
      "Origin Breeding": 18,
      "Breeding Chances": [5, 15, 65, 12, 3, 0],
      "Breeding Base Price" : 15
    },
    Epic: {
      "Max lvl": 20,
      "Growth Min": 1.8,
      "Growth Max": 3.2,
      "Starting Stats": [4, 8],
      "Origin Breeding": 20,
      "Breeding Chances": [0, 4, 25, 63, 6, 2],
      "Breeding Base Price" : 17.5
    },
    Legendary: {
      "Max lvl": 25,
      "Growth Min": 2.2,
      "Growth Max": 3.9,
      "Starting Stats": [5, 10],
      "Origin Breeding": 22,
      "Breeding Chances": [0, 1, 6, 30, 56, 7],
      "Breeding Base Price" : 20
      
    },
    Mythic: {
      "Max lvl": 30,
      "Growth Min": 2.6,
      "Growth Max": 4.5,
      "Starting Stats": [6, 12],
      "Origin Breeding": 24,
      "Breeding Chances": [0, 0, 1, 8, 30, 61],
      "Breeding Base Price" : 22.5
    }
  } as const;
  