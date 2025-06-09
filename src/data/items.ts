export const items = {
    "Hay": {
        "name": "Hay",
        "src": "hay",
        "description": "A bale of hay. Will recover 4 energy instantly.",
        "breakable" : true,
        "consumable" : true,
        "uses" : 1,
        "property" : { 
            "currentEnergy" : 4
        }
    },
    "Common Saddle": {
        "name": "Common Saddle",
        "src": "saddle",
        "description": "A common saddle, it will decrease the chance of a horse getting hurt by 20% during the course of 10 races.",
        "breakable" : true,
        "consumable" : false,        
        "uses" : 10
    },
    "Superior XP Potion": {
        "name": "Superior XP Potion",
        "src": "xp",
        "description": "Superior XP Potion, it doubles the XP earned from racing during the course of 8 races.",
        "breakable" : true,
        "consumable" : false,  
        "uses" : 8
    },
    "Common XP Potion": {
        "name": "Common XP Potion",
        "src": "common_xp",
        "description": "Common XP Potion, it grants +50% XP from racing during the course of 5 races.",
        "breakable" : true,
        "consumable" : false,  
        "uses" : 5
    },
    "Common Horseshoe": {
        "name": "Common Horseshoe",
        "src": "horseshoe",
        "description": "A horseshoe. Improve the odds of a horse scoring a better position by 10% during the course of 12 races.",
        "breakable" : true,
        "consumable" : false,  
        "uses" : 12
    },
        "Pumpers": {
        "name": "Pumpers",
        "src": "bump",
        "description": "A performance enhancing drug that greatly increases your chances of securing a better position, but also raises the risk of injury. Enough for 10 uses.",
        "breakable" : true,
        "consumable" : false,  
        "uses" : 10
    }
}

export const itemModifiers = {
    "Common Saddle" : {
        positionBoost : 1,
        hurtRate: 0.8,
        xpMultiplier: 1,
        energySaved: 0,
    },
    "Superior XP Potion" : {
        positionBoost : 1,
        hurtRate: 1,
        xpMultiplier: 2,
        energySaved: 0
    },
    "Common XP Potion": {
        positionBoost : 1,
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
    }
}

export const chestsPercentage = {
    1: {
        1 : "5000 phorse",
        6 : "1250 phorse",
        13 : "Common Horseshoe" ,       
        20 : "Superior XP Potion",
        30 : "Common XP Potion",
        40 : "Hay",
        60 : "250 phorse",
        80 : "Common Saddle",
        100 :  "Pumpers",
    }
}
