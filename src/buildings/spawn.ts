import { boosts } from "../lib/boosts"
import types = require("../config/types")
import roomU = require("../lib/roomUtils")
import { cU } from "../lib/creepUtils"
import e = require("../operations/error")
import rM = require("../roles/remoteMiner")
import rT = require("../roles/transporter")
import rR = require("../roles/runner")

const centralSpawn = {
    makeNextCreep: function(role: CreepRole, city: string, unhealthyStore=false, creepWantsBoosts=false, flag = null, budget = null) {
        const room = Game.spawns[city].room
        if(Memory.flags.claim && Memory.flags.claim.roomName == room.name)
            return true
       
        const energyToSpend = budget || 
            (unhealthyStore ? room.energyAvailable : room.energyCapacityAvailable)
    
        const boostTier = creepWantsBoosts ? boosts.getBoostRank(role.actions, room) : 0
    
        const recipe = types.getRecipe(role.name, energyToSpend, room, boostTier, flag)
        const spawns = room.find(FIND_MY_SPAWNS)
        if(!Memory.counter){
            Memory.counter = 0
        }
        const name = cU.generateCreepName(Memory.counter.toString(), role.name)
        if (types.cost(recipe) > room.energyAvailable) return false
    
        const spawn = roomU.getAvailableSpawn(spawns)
        if (!spawn) return false
    
        Memory.counter++
        
        // ? CRITICAL FIX: Set memory BEFORE spawning to survive code reload
        if(!Memory.creeps[name]) {
            Memory.creeps[name] = {} as CreepMemory
        }
        Memory.creeps[name].role = role.name
        Memory.creeps[name].mode = role.target
        Memory.creeps[name].target = role.target as unknown as Id<RoomObject>
        Memory.creeps[name].city = city
        Memory.creeps[name].needBoost = boostTier > 0
        Memory.creeps[name].boostTier = boostTier
        Memory.creeps[name].flag = flag
        Memory.creeps[name].spawnTime = recipe.length * CREEP_SPAWN_TIME
        Memory.creeps[name].spawnTick = Game.time
        
        const result = spawn.spawnCreep(recipe, name)
        if (result) { // don't spawn and throw an error at the end of the tick
            e.reportError(new Error(`Error making ${role.name} in ${city}: ${result}`))
            // ? Clean up pre-set memory on spawn failure
            delete Memory.creeps[name]
            return false
        }
        if (boostTier > 0) {
            const boostsNeeded = boosts.getBoostsForRank(role.actions, boostTier)
            roomU.requestBoosterFill(Game.spawns[city], boostsNeeded)
        }
        // Memory is already set above - no need to set again here
        return true
    },

    makeEmergencyCreeps: function(extensions, creeps: Creep[], city, rcl8, emergency) {
        const checkTime = rcl8 ? 200 : 50
        const memory = Game.spawns[city].memory
    
        if (emergency || Game.time % checkTime == 0 && extensions >= 1) {
            if (_.filter(creeps, creep => creep.memory.role == rM.name).length < 1 && memory[rM.name] > 0){
                Log.info(`Making Emergency Miner in ${city}`)
                centralSpawn.makeNextCreep(rM, city, true)
            }
    
            if (_.filter(creeps, creep => creep.memory.role == rT.name).length < 1){
                Log.info(`Making Emergency Transporter in ${city}`)
                centralSpawn.makeNextCreep(rT, city, true)
            }
    
            // TODO disable if links are present (not rcl8!! links may be missing for rcl8)
            if ((emergency || !rcl8) && _.filter(creeps, creep => creep.memory.role == rR.name).length < 1 && memory[rR.name] > 0) {
                Log.info(`Making Emergency Runner in ${city}`)
                centralSpawn.makeNextCreep(rR, city, true)
            }
        }
    }
}

export = centralSpawn