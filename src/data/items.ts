export const items = {
    "Hay": {
        "name": "Hay",
        "src": "hay",
        "description": "A bale of hay. Will recover 3 energy instantly.",
        "breakable" : true,
        "consumable" : true,
        "uses" : 1,
        "property" : { 
            "currentEnergy" : 3
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
        "description": "Superior XP Potion, it doubles the XP earned from racing during the course of 15 races.",
        "breakable" : true,
        "consumable" : false,  
        "uses" : 15
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
        "description": "A horseshoe. Improve the odds of a horse scoring a better position by 10% during the course of 30 races.",
        "breakable" : true,
        "consumable" : false,  
        "uses" : 30
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

export const chests = {
    1: {
        "paused": false,
        "price": 250
    }
}

export const chestsPercentage = {
    1: {
        1 : "5000 phorse",
        8 : "Superior XP Potion",
        13 : "500 phorse",
        23 : "Common XP Potion",
        28 : "Common Horseshoe" ,
        47 : "Common Saddle",
        62 :  "Hay",
        82 :  "Pumpers",
        100 : "100 phorse"
    }
}
