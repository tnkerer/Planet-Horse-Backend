export const items = {
    "Hay": {
        "name": "Hay",
        "src": "hay",
        "description": "A bale of hay. Will recover 4 energy instantly.",
        "breakable": true,
        "consumable": true,
        "uses": 1,
        "property": {
            "currentEnergy": 4
        }
    },
    "Big Hay Bale": {
        "name": "Big Hay Bale",
        "src": "haybale",
        "description": "A big hay bale. Will recover 12 energy instantly.",
        "breakable": true,
        "consumable": true,
        "uses": 1,
        "property": {
            "currentEnergy": 12
        }
    },
    "Common Saddle": {
        "name": "Common Saddle",
        "src": "saddle",
        "description": "It will decrease the chance of a horse getting hurt by 30% during the course of 6 races.",
        "breakable": true,
        "consumable": false,
        "uses": 6
    },
    "Superior XP Potion": {
        "name": "Superior XP Potion",
        "src": "xp",
        "description": "It doubles the XP earned from racing during the course of 4 races.",
        "breakable": true,
        "consumable": false,
        "uses": 4
    },
    "Common XP Potion": {
        "name": "Common XP Potion",
        "src": "common_xp",
        "description": "It grants +50% XP from racing during the course of 4 races.",
        "breakable": true,
        "consumable": false,
        "uses": 4
    },
    "Common Horseshoe": {
        "name": "Common Horseshoe",
        "src": "horseshoe",
        "description": "Improve the odds of a horse scoring a better position by 10% during the course of 6 races.",
        "breakable": true,
        "consumable": false,
        "uses": 6
    },
    "Pumpers": {
        "name": "Pumpers",
        "src": "bump",
        "description": "A performance enhancing drug that greatly increases your chances of securing a better position, but also raises the risk of injury. Enough for 5 uses.",
        "breakable": true,
        "consumable": false,
        "uses": 5
    },
    "Scrap Metal": {
        "name": "Scrap Metal",
        "src": "metal",
        "description": "Pieces of repurposed metal used for several crafting techniques.",
        "breakable": true,
        "consumable": false,
        "uses": 1
    },
    "Scrap Leather": {
        "name": "Scrap Leather",
        "src": "leather",
        "description": "Pieces of repurposed leather used for several crafting techniques.",
        "breakable": true,
        "consumable": false,
        "uses": 1
    },
    "Baby Ronke Trophy": {
        "name": "Baby Ronke Trophy",
        "src": "ronke",
        "description": "Reduce race cost by 2 energy. A plush trophy to celebrate your victory!",
        "breakable": false,
        "consumable": false,
        "uses": 1
    },
    "Champion Saddle Pad": {
        "name": "Champion Saddle Pad",
        "src": "saddle_pad",
        "description": "Increase SPRINT by 3 points during races.",
        "breakable": false,
        "consumable": false,
        "uses": 1
    },
    "Champion Bridle": {
        "name": "Champion Bridle",
        "src": "bridle",
        "description": "Increase SPEED by 3 points during races.",
        "breakable": false,
        "consumable": false,
        "uses": 1
    },
    "Champion Stirrups": {
        "name": "Champion Stirrups",
        "src": "stirrups",
        "description": "Increase POWER by 3 points during races.",
        "breakable": false,
        "consumable": false,
        "uses": 1
    },
}

export const itemModifiers = {
    "Champion Stirrups": {
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 1,
        energySaved: 1,
        extraSpd: 0,
        extraSpt: 0,
        extraPwr: 3,
    },
    "Champion Bridle": {
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 1,
        energySaved: 1,
        extraSpd: 3,
        extraSpt: 0,
        extraPwr: 0,
    },
    "Champion Saddle Pad": {
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 1,
        energySaved: 1,
        extraSpd: 0,
        extraSpt: 3,
        extraPwr: 0,
    },
    "Baby Ronke Trophy": {
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 1,
        energySaved: 2,
        extraSpd: 0,
        extraSpt: 0,
        extraPwr: 0,
    },
    "Common Saddle": {
        positionBoost: 1,
        hurtRate: 1.30,
        xpMultiplier: 1,
        energySaved: 0,
        extraSpd: 0,
        extraSpt: 0,
        extraPwr: 0,
    },
    "Superior XP Potion": {
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 2,
        energySaved: 0,
        extraSpd: 0,
        extraSpt: 0,
        extraPwr: 0,
    },
    "Common XP Potion": {
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 1.5,
        energySaved: 0,
        extraSpd: 0,
        extraSpt: 0,
        extraPwr: 0,
    },
    "Common Horseshoe": {
        positionBoost: 1.1,
        hurtRate: 1,
        xpMultiplier: 1,
        energySaved: 0,
        extraSpd: 0,
        extraSpt: 0,
        extraPwr: 0,
    },
    "Pumpers": {
        positionBoost: 1.25,
        hurtRate: 0.6,
        xpMultiplier: 1,
        energySaved: 0,
        extraSpd: 0,
        extraSpt: 0,
        extraPwr: 0,
    }
}

export const chests = {
    1: {
        "paused": false,
        "price": 500
    },
    2: {
        "paused": false,
        "price": 2000
    }
}

export const chestsPercentage = {
    1: {
        0.5: "5000 phorse",
        3: "1250 phorse",
        13: "Common Horseshoe",
        19: "Superior XP Potion",
        30: "Common XP Potion",
        40: "Hay",
        60: "250 phorse",
        80: "Common Saddle",
        100: "Pumpers",
    },
    2: {
        0.3: "60 medals",
        0.6: "6000 phorse",
        4.2: "20 medals",
        9.2: "10 medals",
        23: "Champion Stirrups",
        37: "Champion Bridle",
        49: "Champion Saddle Pad",
        52: "Big Hay Bale",
        70: "500 phorse",
        78: "2 medals",
        85: "Superior XP Potion",
        95: "Common XP Potion",
        100: "Hay",
    }
}
