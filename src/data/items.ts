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
    "Common Saddle": {
        "name": "Common Saddle",
        "src": "saddle",
        "description": "A common saddle, it will decrease the chance of a horse getting hurt by 20% during the course of 6 races.",
        "breakable": true,
        "consumable": false,
        "uses": 6
    },
    "Superior XP Potion": {
        "name": "Superior XP Potion",
        "src": "xp",
        "description": "Superior XP Potion, it doubles the XP earned from racing during the course of 4 races.",
        "breakable": true,
        "consumable": false,
        "uses": 4
    },
    "Common XP Potion": {
        "name": "Common XP Potion",
        "src": "common_xp",
        "description": "Common XP Potion, it grants +50% XP from racing during the course of 4 races.",
        "breakable": true,
        "consumable": false,
        "uses": 4
    },
    "Common Horseshoe": {
        "name": "Common Horseshoe",
        "src": "horseshoe",
        "description": "A horseshoe. Improve the odds of a horse scoring a better position by 10% during the course of 6 races.",
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
    }
}

export const itemModifiers = {
    "Baby Ronke Trophy" :{
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 1,
        energySaved: 2,       
    },
    "Common Saddle": {
        positionBoost: 1,
        hurtRate: 1.25,
        xpMultiplier: 1,
        energySaved: 0,
    },
    "Superior XP Potion": {
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 2,
        energySaved: 0
    },
    "Common XP Potion": {
        positionBoost: 1,
        hurtRate: 1,
        xpMultiplier: 1.5,
        energySaved: 0,
    },
    "Common Horseshoe": {
        positionBoost: 1.1,
        hurtRate: 1,
        xpMultiplier: 1,
        energySaved: 0,
    },
    "Pumpers": {
        positionBoost: 1.25,
        hurtRate: 0.6,
        xpMultiplier: 1,
        energySaved: 0,
    }
}

export const chests = {
    1: {
        "paused": false,
        "price": 500
    },
    2: {
        "paused": false,
        "price": 1500
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
    }
}
