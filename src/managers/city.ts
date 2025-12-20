import { cN } from "../lib/creepNames"
import centralSpawn = require("../buildings/spawn")
import { cU } from "../lib/creepUtils"
import fact = require("../buildings/factory")
import labsLib = require("../buildings/labs")
import link = require("../buildings/link")
import motion = require("../lib/motion")
import pSpawn = require("../buildings/powerSpawn")
import roomU = require("../lib/roomUtils")
import rp = require("./roomplan")
import rr = require("../roles/roles")
import settings = require("../config/settings")
import sq = require("../lib/spawnQueue")
import t = require("../buildings/tower")
import template = require("../config/template")
import types = require("../config/types")
import u = require("../lib/utils")
import rR = require("../roles/runner")

//runCity function
function runCity(city, creeps: Creep[]){
    const spawn = Game.spawns[city]
    if (!spawn) return false
    const room = spawn.room

    updateSpawnStress(spawn)

    // Only build required roles during financial stress
    const emergencyRoles = rr.getEmergencyRoles()
    const allRoles = rr.getRoles()

    const storage = roomU.getStorage(room) as StructureContainer | StructureStorage
    const halfCapacity = storage && storage.store.getCapacity() / 2
    const unhealthyStore = storage && storage.store[RESOURCE_ENERGY] < Math.min(5000, halfCapacity)
    const roles = (unhealthyStore) ? emergencyRoles : allRoles

    // Get counts for roles by looking at all living and queued creeps
    const nameToRole = _.groupBy(allRoles, role => role.name) // map from names to roles
    const counts = _.countBy(creeps, creep => creep.memory.role) // lookup table from role to count
    const queuedCounts = sq.getCounts(spawn)
    _.forEach(roles, role => {
        const liveCount = counts[role.name] || 0
        const queueCount = queuedCounts[role.name] || 0
        counts[role.name] = liveCount + queueCount
    })

    if(Game.time % 50 == 0){
        sq.sort(spawn)
    }
    
    let usedQueue = true
    const nextRoleInfo = sq.peekNextRole(spawn) || {} as QueuedCreep
    const spawnQueueRoleName = nextRoleInfo.role
    let nextRole = spawnQueueRoleName ? nameToRole[spawnQueueRoleName][0] : null

    if (!nextRole) {
        nextRole = _.find(roles, role => (typeof counts[role.name] == "undefined" && 
        spawn.memory[role.name]) || (counts[role.name] < spawn.memory[role.name]))
        usedQueue = false
    }
    
    if (nextRole) {
        if(centralSpawn.makeNextCreep(nextRole, city, unhealthyStore, nextRoleInfo.boosted, 
            nextRoleInfo.flag, nextRoleInfo.budget) && usedQueue) {
            sq.removeNextRole(spawn)
        }
    }


    // Run all the creeps in this city
    _.forEach(creeps, (creep) => {
        // Validate creep has a role before running
        if(!creep.memory.role){
            Log.error(`[runCity] Creep ${creep.name} in ${city} has no role! Suiciding...`)
            creep.suicide()
            return
        }
        
        // Validate role exists in nameToRole
        if(!nameToRole[creep.memory.role]){
            Log.error(`[runCity] Creep ${creep.name} has invalid role ${creep.memory.role}! Suiciding...`)
            creep.suicide()
            return
        }
        
        nameToRole[creep.memory.role][0].run(creep)
    })
    
    link.run(room)
    pSpawn.run(city)
    labsLib.run(city)
    fact.runFactory(city)
    checkNukes(room)
    updateRemotes(city, creeps)
}

//updateCountsCity function
function updateCountsCity(city, creeps, rooms, claimRoom, unclaimRoom) {
    const spawn = Game.spawns[city]
    if (!spawn) return false
    const memory = spawn.memory
    const controller = spawn.room.controller
    const rcl = controller.level
    const rcl8 = rcl > 7
    const emergencyTime = spawn.room.storage && spawn.room.storage.store.energy < 5000 && rcl > 4 || 
                (rcl > 6 && !spawn.room.storage)
    const logisticsTime = rcl8 && !emergencyTime ? 500 : 50

    // Always update defender
    updateDefender(spawn, rcl, creeps)

    if(Game.time % 200 == 0){
        updateMilitary(city, memory, rooms, spawn, creeps)
    }
    if (Game.time % logisticsTime == 0 || Game.time < 10) {
        // Cache structures in Tmp
        const roomName = spawn.room.name
        if (!Tmp[roomName]) {
            Tmp[roomName] = {}
        }
        if (!Tmp[roomName].cityStructures || Game.time % 50 == 0) {
            Tmp[roomName].cityStructures = spawn.room.find(FIND_STRUCTURES)
        }
        const structures = Tmp[roomName].cityStructures
        
        // Cache extensions count
        let extensions = 0
        for (const s of structures) {
            if (s.structureType == STRUCTURE_EXTENSION) {
                extensions++
            }
        }
        
        updateRunner(creeps, spawn, extensions, memory, rcl, emergencyTime)
        updateFerry(spawn, rcl)
        updateMiner(creeps, rcl8, memory, spawn)
        updateBuilder(rcl, memory, spawn, creeps)
        updateRepairer(spawn, memory, creeps)
        updateUpgrader(city, controller, memory, rcl8, creeps, rcl)
        updateTransporter(extensions, memory, creeps, structures, spawn)
    
        if (Game.time % 500 === 0) {
            runNuker(city)
            labsLib.checkLabs(city)
            updateColonizers(city, claimRoom, unclaimRoom)
            updateMineralMiner(rcl, structures, spawn, creeps)
            pSpawn.update(city, memory)
            updateStorageLink(spawn, memory, structures)
        }
        centralSpawn.makeEmergencyCreeps(extensions, creeps, city, rcl8, emergencyTime) 
    }
}

function checkNukes(room){
    if(Game.time % 1000 === 3){
        const nukes = room.find(FIND_NUKES)
        if(nukes.length){
            Game.notify("Nuclear launch detected in " + room.name, 720)
            Log.warning(`Nuclear launch detected in ${room.name}`)
        }
    }
}

// Run the tower function
function runTowers(city: string){
    const spawn = Game.spawns[city]
    if (spawn){
        if(spawn.memory.towersActive == undefined){
            spawn.memory.towersActive = false
        }
        const checkTime = 20
        if(spawn.memory.towersActive == false && Game.time % checkTime != 0){
            return
        }
        
        // Cache towers and creeps in Tmp
        const roomName = spawn.room.name
        if (!Tmp[roomName]) {
            Tmp[roomName] = {}
        }
        
        // Cache towers
        if (!Tmp[roomName].towers || Game.time % 100 == 0) {
            const structures = spawn.room.find(FIND_MY_STRUCTURES)
            Tmp[roomName].towers = []
            for (const s of structures) {
                if (s.structureType == STRUCTURE_TOWER) {
                    Tmp[roomName].towers.push(s as StructureTower)
                }
            }
        }
        const towers = Tmp[roomName].towers
        
        // Cache injured creeps (refresh every 5 ticks)
        if (!Tmp[roomName].injuredCreeps || Game.time % 5 == 0) {
            const myCreeps = spawn.room.find(FIND_MY_CREEPS)
            const myPowerCreeps = spawn.room.find(FIND_MY_POWER_CREEPS)
            Tmp[roomName].injuredCreeps = []
            for (const c of myCreeps) {
                if (c.hits < c.hitsMax) {
                    Tmp[roomName].injuredCreeps.push(c)
                }
            }
            for (const pc of myPowerCreeps) {
                if (pc.hits < pc.hitsMax) {
                    Tmp[roomName].injuredCreeps.push(pc)
                }
            }
        }
        const injured = Tmp[roomName].injuredCreeps
        
        const hostiles = u.findHostileCreeps(spawn.room)
        let damaged = null
        let repair = 0
        let target = null
        maybeSafeMode(city, hostiles)
        
        if (Game.time % checkTime === 0) {
            // Cache structures for repair
            if (!Tmp[roomName].towerRepairStructures || Game.time % checkTime == 0) {
                const allStructures = spawn.room.find(FIND_STRUCTURES)
                Tmp[roomName].towerRepairStructures = []
                for (const s of allStructures) {
                    if (s.structureType != STRUCTURE_WALL
                        && s.structureType != STRUCTURE_RAMPART
                        && s.structureType != STRUCTURE_CONTAINER
                        && s.hitsMax - s.hits > TOWER_POWER_REPAIR) {
                        Tmp[roomName].towerRepairStructures.push(s)
                    }
                }
            }
            const needRepair = Tmp[roomName].towerRepairStructures
            
            if(needRepair.length){
                damaged = _.min(needRepair, function(s) {
                    return s.hits/s.hitsMax
                })
            }
            if(damaged){
                repair = damaged.hitsMax - damaged.hits
            }
        }

        const lowEnergy = spawn.room.storage && spawn.room.terminal && spawn.room.storage.store.energy < 40000
        if(hostiles.length > 0  && !lowEnergy){
            spawn.memory.towersActive = true
            //identify target 
            target = t.chooseTarget(towers, hostiles, spawn.pos.roomName)
        } else {
            spawn.memory.towersActive = false
        }
        for (let i = 0; i < towers.length; i++){
            if(target){
                towers[i].attack(target)
            } else if (injured.length > 0 && !hostiles.length){
                towers[i].heal(injured[0])
            } else if (Game.time % checkTime === 0 && damaged){
                if(repair < TOWER_POWER_REPAIR * (1 - TOWER_FALLOFF)){
                    continue
                }
                const distance = towers[i].pos.getRangeTo(damaged.pos)
                const damage_distance = Math.max(TOWER_OPTIMAL_RANGE, Math.min(distance, TOWER_FALLOFF_RANGE))
                const steps = TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE
                const step_size = TOWER_FALLOFF * TOWER_POWER_REPAIR / steps
                const repStrength = TOWER_POWER_REPAIR - (damage_distance - TOWER_OPTIMAL_RANGE) * step_size
                if(repStrength <= repair){
                    towers[i].repair(damaged)
                    repair -= repStrength 
                }
            }
        }
    }
}

function maybeSafeMode(city: string, hostiles: Array<Creep | PowerCreep>){
    const room = Game.spawns[city].room
    const plan = Memory.rooms[room.name].plan
    if(!plan) return
    const minX = plan.x - template.wallDistance
    const minY = plan.y - template.wallDistance
    const maxX = plan.x + template.dimensions.x + template.wallDistance - 1
    const maxY = plan.y + template.dimensions.y + template.wallDistance - 1
    if(_.find(hostiles, h => h.pos.x > minX 
            && h.pos.x < maxX 
            && h.pos.y > minY
            && h.pos.y < maxY)
        && room.controller.safeModeAvailable
        && !room.controller.safeModeCooldown){
        room.controller.activateSafeMode()
    }
}

function updateMilitary(city: string, memory, rooms, spawn, creeps) {
    const flags = ["harass", "powerMine", "deposit"]
    const roles = [cN.HARASSER_NAME, cN.POWER_MINER_NAME, cN.DEPOSIT_MINER_NAME]
    for (let i = 0; i < flags.length; i++) {
        const flagName = city + flags[i]
        const role = roles[i]
        updateHighwayCreep(flagName, spawn, creeps, role)
    }
}

function chooseClosestRoom(myCities: Room[], flag){
    if(!flag){
        return 0
    }
    const goodCities = _.filter(myCities, city => city.controller.level >= 4 && Game.spawns[city.memory.city] && city.storage)
    if(!goodCities.length) return null
    let closestRoomPos = goodCities[0].getPositionAt(25, 25)
    let closestLength = CREEP_CLAIM_LIFE_TIME + 100//more than max claimer lifetime
    for (let i = 0; i < goodCities.length; i += 1){
        const testRoomPos = goodCities[i].getPositionAt(25, 25)
        const testPath = u.findMultiRoomPath(testRoomPos, flag)
        if(!testPath.incomplete && testPath.cost < closestLength && goodCities[i].name != flag.roomName){
            closestRoomPos =  goodCities[i].getPositionAt(25, 25)
            closestLength = testPath.cost
        }
    }
    if(closestLength == 700){
        Game.notify("No valid rooms in range for claim operation in " + flag.roomName)
    }
    return closestRoomPos.roomName
}

function updateColonizers(city, claimRoom, unclaimRoom) {
    //claimer and spawnBuilder reset
    // TODO only make a claimer if city is close
    const roomName = Game.spawns[city].room.name
    if(roomName == claimRoom){
        const flag = Memory.flags.claim
        const harassFlagName = u.generateFlagName(city + "harass")
        if(!_.find(Object.keys(Memory.flags), f => Memory.flags[f].roomName == Memory.flags.claim.roomName && f.includes("harass"))){
            Memory.flags[harassFlagName] = new RoomPosition(25, 25, Memory.flags.claim.roomName)
            Memory.flags[harassFlagName].boosted = true
        }
        if(Game.spawns[city].room.controller.level < 7){
            cU.scheduleIfNeeded(cN.SPAWN_BUILDER_NAME, 4, true, Game.spawns[city], u.splitCreepsByCity()[city])
        } else if (flag && Game.rooms[flag.roomName] && Game.rooms[flag.roomName].terminal) {
            cU.scheduleIfNeeded(cN.SPAWN_BUILDER_NAME, 4, true, Game.spawns[city], u.splitCreepsByCity()[city])
        } else {
            cU.scheduleIfNeeded(cN.SPAWN_BUILDER_NAME, 2, true, Game.spawns[city], u.splitCreepsByCity()[city])
        }
        if(flag && !Game.rooms[flag.roomName] || !Game.rooms[flag.roomName].controller.my){
            cU.scheduleIfNeeded(cN.CLAIMER_NAME, 1, false, Game.spawns[city], u.splitCreepsByCity()[city])
        }
    }
    if (roomName == unclaimRoom && Game.time % 1000 == 0) {
        sq.schedule(Game.spawns[city], cN.UNCLAIMER_NAME)
    }
}

// Automated defender count for defense
function updateDefender(spawn: StructureSpawn, rcl, creeps) {
    if (Game.time % 30 != 0) {
        return
    }
    const room = spawn.room
    if(spawn.memory.towersActive){
        const hostiles = _.filter(u.findHostileCreeps(room), hostile => hostile instanceof PowerCreep || (_(hostile.body).find(part => part.boost) || rcl < 7) && 
            (hostile.getActiveBodyparts(TOUGH) > 0 || hostile.body.length == 50 || rcl < 8)).length
        if(hostiles > 3){
            //request quad from nearest ally
            Log.info(`City ${spawn.name}: requesting quad from nearest ally`)
            requestSupport(spawn, Math.floor(hostiles/4), rcl)
            if(Game.time % 1500 == 0 && spawn.memory.wallMultiplier)
                spawn.memory.wallMultiplier = Math.min(spawn.memory.wallMultiplier + .1, 20)
        } else {
            cU.scheduleIfNeeded(cN.DEFENDER_NAME, Math.min(Math.floor(hostiles/2), 4), true, spawn, creeps)
        }
    }
    if((rcl <= 2 || room.controller.safeModeCooldown) && !room.controller.safeMode)
        requestSupport(spawn, 1, rcl)
}

function requestSupport(spawn, quadsNeeded, rcl){
    //find reinforce City
    const reinforceCities = _.filter(u.getMyCities(), c => c.controller.level >= rcl)
    const closestRoom = chooseClosestRoom(reinforceCities, spawn.pos)
    if(!closestRoom)
        return
    const reinforceCity = closestRoom + "0"
    const reinforcingSpawn = Game.spawns[reinforceCity]
    const creeps = u.splitCreepsByCity()[reinforceCity]
    cU.scheduleIfNeeded(cN.TRANSPORTER_NAME, 2, false, reinforcingSpawn, creeps)
    cU.scheduleIfNeeded(cN.QUAD_NAME, 4 * quadsNeeded, true, reinforcingSpawn, creeps, spawn.room.name, 400)
}

function cityFraction(cityName) {
    const myCities = _.map(u.getMyCities(), city => city.name).sort()
    return _.indexOf(myCities, cityName) / myCities.length
}

function updateMiner(creeps: Creep[], rcl8: boolean, memory: SpawnMemory, spawn: StructureSpawn){
    const flag = Memory.flags.claim
    if(flag && flag.roomName === spawn.pos.roomName &&
        Game.rooms[flag.roomName].controller.level < 6){
        return
    }
    roomU.initializeSources(spawn)

    // Cache power creep check in Tmp
    const roomName = spawn.room.name
    if (!Tmp[roomName]) {
        Tmp[roomName] = {}
    }
    if (!Tmp[roomName].powerCreepCheck || Game.time % 50 == 0) {
        const powerCreeps = spawn.room.find(FIND_MY_POWER_CREEPS)
        let hasPowerCreep = false
        for (const pc of powerCreeps) {
            if (pc.powers[PWR_REGEN_SOURCE]) {
                hasPowerCreep = true
                break
            }
        }
        Tmp[roomName].hasPowerCreep = hasPowerCreep
        Tmp[roomName].powerCreepCheck = Game.time
    }
    const powerCreep = Tmp[roomName].hasPowerCreep
    
    let bucketThreshold = settings.bucket.energyMining + settings.bucket.range * cityFraction(spawn.room.name)
    if(powerCreep || (spawn.room.storage && spawn.room.storage.store[RESOURCE_ENERGY] < settings.energy.processPower)){
        bucketThreshold -= settings.bucket.range/2
    }
    if (spawn.memory.towersActive || (Game.cpu.bucket < bucketThreshold && rcl8) || Game.time < 100) {
        return
    }
    
    // ? LEVEL 1 VALIDATION: Critical Path Validation (Every Tick)
    // Validates source structure BEFORE scheduling miners to prevent corruption
    for(const sourceId in memory.sources){
        const sourcePos = memory.sources[sourceId]
        
        // Validate RoomPosition structure exists and is valid
        if(!sourcePos || typeof sourcePos !== "object"){
            Log.error(`[L1] Invalid source entry ${sourceId} in ${spawn.name}, removing`)
            delete memory.sources[sourceId]
            continue
        }
        
        // Validate RoomPosition has required fields
        if(!sourcePos.roomName || sourcePos.x === undefined || sourcePos.y === undefined){
            Log.error(`[L1] Incomplete RoomPosition for ${sourceId} in ${spawn.name}, removing`)
            delete memory.sources[sourceId]
            continue
        }
        
        // Validate coordinates are within bounds (0-49)
        if(sourcePos.x < 0 || sourcePos.x > 49 || sourcePos.y < 0 || sourcePos.y > 49){
            Log.error(`[L1] Out of bounds position for ${sourceId}: (${sourcePos.x}, ${sourcePos.y}) in ${spawn.name}, removing`)
            delete memory.sources[sourceId]
            continue
        }
        
        // Validate source exists (only for LOCAL sources to avoid remote lookup overhead)
        if(sourcePos.roomName == spawn.room.name){
            const source = Game.getObjectById(sourceId as Id<Source>)
            if(!source){
                Log.warning(`[L1] Dead local source ${sourceId} in ${spawn.room.name}, removing`)
                delete memory.sources[sourceId]
                continue
            }
        }
        
        // Source is valid, schedule miner
        cU.scheduleIfNeeded(cN.REMOTE_MINER_NAME, 1, false, spawn, creeps, sourceId)
    }     
}

function updateMineralMiner(rcl, buildings: Structure[], spawn, creeps) {
    if (rcl > 5){
        const extractor = _.find(buildings, structure => structure.structureType == STRUCTURE_EXTRACTOR)
        if(extractor) {
            const minerals = extractor.pos.lookFor(LOOK_MINERALS)
            if (!minerals.length) return
            const mineral = minerals[0]
            const room = spawn.room as Room
            if(room.terminal
                    && mineral.mineralAmount > 0
                    && (room.terminal.store[mineral.mineralType] < 6000
                        || (Game.cpu.bucket > settings.bucket.mineralMining 
                        && room.storage 
                        && room.storage.store.getUsedCapacity(mineral.mineralType) < settings.mineralAmount))){
                cU.scheduleIfNeeded(cN.MINERAL_MINER_NAME, 1, false, spawn, creeps, room.name)
            }
        }
    }
}

function updateTransporter(extensions, memory, creeps, structures: Structure[], spawn) {
    let transportersNeeded = 0
    if (extensions < 1 && !_.find(structures, struct => struct.structureType == STRUCTURE_CONTAINER)){
        return
    } else if (extensions < 5 || creeps.length < 9){
        transportersNeeded = 1
    } else {//arbitrary 'load' on transporters
        transportersNeeded = settings.max.transporters
    }
    cU.scheduleIfNeeded(cN.TRANSPORTER_NAME, transportersNeeded, false, spawn, creeps, null, 200)
    memory[cN.TRANSPORTER_NAME] = 0 //TODO: remove
}

function updateUpgrader(city: string, controller: StructureController, memory: SpawnMemory, rcl8: boolean, creeps: Creep[], rcl: number) {
    const room = Game.spawns[city].room
    const spawn = Game.spawns[city]
    
    // EMERGENCY MODE: Only active during DOWNGRADE events (RCL 5+ losing storage)
    // Not for normal early game (RCL 1-4 without storage is expected)
    const isDowngradeEmergency = rcl >= 5 && (!room.storage || (room.storage && room.storage.store.energy < 1000))
    
    if (rcl8){
        const bucketThreshold = settings.bucket.upgrade + settings.bucket.range * cityFraction(room.name)
        const haveEnoughCpu = Game.cpu.bucket > bucketThreshold
        if (controller.ticksToDowngrade < CONTROLLER_DOWNGRADE[rcl]/2 
            || (controller.room.storage.store.energy > settings.energy.rcl8upgrade && haveEnoughCpu && settings.rcl8upgrade)){
            cU.scheduleIfNeeded(cN.UPGRADER_NAME, 1, true, spawn, creeps)
        }
    } else {
        // EMERGENCY MODE: Only for RCL 5+ downgrade situations
        if(isDowngradeEmergency){
            const upgraders = _.filter(creeps, c => c.memory.role == cN.UPGRADER_NAME).length
            const queuedUpgraders = sq.getCounts(spawn)[cN.UPGRADER_NAME] || 0
            
            if(upgraders + queuedUpgraders == 0){
                // CRITICAL: No upgraders during downgrade! Schedule with high priority and minimal budget
                sq.schedule(spawn, cN.UPGRADER_NAME, false, null, 300, -100) // High priority (-100)
                Log.info(`DOWNGRADE EMERGENCY: Spawning minimal upgrader in ${spawn.name} (RCL ${rcl}, storage < 1000)`)
                return
            } else if(upgraders + queuedUpgraders < 2 && controller.ticksToDowngrade < CONTROLLER_DOWNGRADE[rcl] * 0.5){
                // Downgrade risk! Schedule second upgrader
                sq.schedule(spawn, cN.UPGRADER_NAME, false, null, 300, -50)
                Log.info(`DOWNGRADE EMERGENCY: Controller downgrade risk in ${spawn.name}, spawning 2nd upgrader`)
                return
            }
        }
        
        // NORMAL MODE: Regular upgrader spawning logic
        const builders = _.filter(creeps, c => c.memory.role == cN.BUILDER_NAME).length + (sq.getCounts(spawn)[cN.BUILDER_NAME] || 0)
        const storage = roomU.getStorage(room)
        const bank = storage as StructureStorage | StructureContainer
        if(!bank) return
        let money = bank.store[RESOURCE_ENERGY]
        const capacity = bank.store.getCapacity()
        if(rcl < 6 && Game.gcl.level <= 2)//keep us from saving energy in early game
            money += capacity * 0.2
        if(capacity < CONTAINER_CAPACITY){
            if(!builders)
                cU.scheduleIfNeeded(cN.UPGRADER_NAME,1, false, spawn, creeps)
            return
        }
        let storedEnergy = bank.store[RESOURCE_ENERGY]
        for(const c of creeps){
            if(c.room.name == controller.room.name)
                storedEnergy += c.store.energy
        }
        const energyMultiplier = rcl > 2 ? 2 : 4
        const upgradersRequested = room.storage ? Math.floor(Math.pow((money/capacity) * 4, 8)) : Math.floor((storedEnergy*energyMultiplier/capacity))
        Log.info(`City ${city}: stored energy: ${storedEnergy}, upgraders requested: ${upgradersRequested}`)
        const upgradeLinkPos = link.getUpgradeLinkPos(room) || controller.pos
        let upgraderSpots = 0
        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                const testPos = new RoomPosition(upgradeLinkPos.x + i, upgradeLinkPos.y + j, upgradeLinkPos.roomName)
                if (!roomU.isPositionBlocked(testPos) && testPos.inRangeTo(controller.pos, 3)) {
                    upgraderSpots++
                }
            }
        }
        const upgradersNeeded = Math.min(upgradersRequested - builders, upgraderSpots)
        cU.scheduleIfNeeded(cN.UPGRADER_NAME, upgradersNeeded, rcl >= 6, spawn, creeps)
        if (controller.ticksToDowngrade < CONTROLLER_DOWNGRADE[rcl]/2){
            cU.scheduleIfNeeded(cN.UPGRADER_NAME, 1, rcl >= 6, spawn, creeps)
        }
    }
}

function updateRepairer(spawn, memory: SpawnMemory, creeps){
    const remotes = Object.keys(_.countBy(memory.sources, s => s.roomName))
    let csites = 0
    let damagedRoads = 0
    for(const remoteName of remotes){
        const room = Game.rooms[remoteName]
        if(!room || (room.controller && room.controller.owner)) continue
        
        // ? Cache construction sites and damaged roads per remote room
        // ? Fast refresh (10 ticks) for sites, slow refresh (50 ticks) for roads
        if (!Tmp[remoteName]) {
            Tmp[remoteName] = {}
        }
        if (!Tmp[remoteName].repairerData || Game.time % 10 == 0) {
            const sites = room.find(FIND_MY_CONSTRUCTION_SITES)
            let damagedCount = 0
            
            // Only check roads every 50 ticks (roads decay slowly)
            if (!Tmp[remoteName].repairerStructures || Game.time % 50 == 0) {
                const structures = room.find(FIND_STRUCTURES)
                Tmp[remoteName].repairerStructures = []
                for (const s of structures) {
                    if (s.structureType == STRUCTURE_ROAD && s.hits/s.hitsMax < 0.3) {
                        Tmp[remoteName].repairerStructures.push(s)
                    }
                }
            }
            damagedCount = Tmp[remoteName].repairerStructures.length
            
            Tmp[remoteName].repairerData = {
                sites: sites.length,
                damaged: damagedCount
            }
        }
        csites += Tmp[remoteName].repairerData.sites
        damagedRoads += Tmp[remoteName].repairerData.damaged
    }
    let repairersNeeded = 0
    if(csites > 0)
        repairersNeeded++
    repairersNeeded += Math.floor(damagedRoads/20)
    cU.scheduleIfNeeded(cN.REPAIRER_NAME, repairersNeeded, false, spawn, creeps)
}

function updateBuilder(rcl, memory, spawn: StructureSpawn, creeps: [Creep]) {
    const room = spawn.room
    const roomName = room.name
    
    // ? Cache construction sites (refresh every 10 ticks for good reactivity)
    if (!Tmp[roomName]) {
        Tmp[roomName] = {}
    }
    if (!Tmp[roomName].builderSites || Game.time % 10 == 0) {
        Tmp[roomName].builderSites = room.find(FIND_MY_CONSTRUCTION_SITES)
    }
    const constructionSites = Tmp[roomName].builderSites
    
    const storage = roomU.getStorage(room) as StructureStorage | StructureContainer | StructureSpawn
    let totalSites
    if (rcl < 4) {
        // ? Cache repair sites (refresh every 20 ticks - structures don't decay that fast)
        if (!Tmp[roomName].builderRepairSites || Game.time % 20 == 0) {
            const structures = room.find(FIND_STRUCTURES)
            Tmp[roomName].builderRepairSites = []
            for (const s of structures) {
                if (s.hits < (s.hitsMax*0.3) && s.structureType != STRUCTURE_WALL) {
                    Tmp[roomName].builderRepairSites.push(s)
                }
            }
        }
        const repairSites = Tmp[roomName].builderRepairSites
        totalSites = (Math.floor((repairSites.length)/10) + constructionSites.length)
    } else {
        totalSites = constructionSites.length
    }
    if (totalSites > 0){
        if(storage.structureType == STRUCTURE_CONTAINER){
            //make builders based on quantity of carried energy in room
            let energyStore = storage.store.energy
            
            // ? Cache creep filtering for energy calculation
            if (!Tmp[roomName].builderCreeps || Game.time % 5 == 0) {
                Tmp[roomName].builderCreeps = creeps
            }
            for(const c of Tmp[roomName].builderCreeps){
                energyStore += c.store.energy
            }
            const upgraders = _.filter(creeps, c => c.memory.role == cN.UPGRADER_NAME).length
            const buildersNeeded = Math.max(Math.floor(energyStore*2/CONTAINER_CAPACITY) - upgraders, 3)
            Log.info(`City ${spawn.name}: stored energy: ${energyStore}, builders requested: ${buildersNeeded}`)
            cU.scheduleIfNeeded(cN.BUILDER_NAME, buildersNeeded, rcl >= 6, spawn, creeps)
        } else {
            cU.scheduleIfNeeded(cN.BUILDER_NAME, settings.max.builders, rcl >= 6, spawn, creeps)
        }
    }
    if(rcl >= 4 && Game.cpu.bucket > settings.bucket.repair + settings.bucket.range * cityFraction(room.name) && spawn.room.storage && spawn.room.storage.store[RESOURCE_ENERGY] > settings.energy.repair){
        // ? Cache walls (refresh every 100 ticks - walls change slowly)
        if (!Tmp[roomName].builderWalls || Game.time % 100 == 0) {
            const structures = spawn.room.find(FIND_STRUCTURES)
            Tmp[roomName].builderWalls = []
            for (const s of structures) {
                if ((s.structureType == STRUCTURE_RAMPART || s.structureType == STRUCTURE_WALL) 
                    && !roomU.isNukeRampart(s.pos)) {
                    Tmp[roomName].builderWalls.push(s)
                }
            }
        }
        const walls = Tmp[roomName].builderWalls
        
        if(walls.length){//find lowest hits wall
            if(!spawn.memory.wallMultiplier){
                spawn.memory.wallMultiplier = 1
            }
            if(Game.time % 10000 == 0 && Math.random() < .1)
                spawn.memory.wallMultiplier = Math.min(spawn.memory.wallMultiplier + .1, 10)
            const minHits = _.min(walls, wall => wall.hits).hits
            const defenseMode = !spawn.room.controller.safeMode && spawn.room.controller.safeModeCooldown
            const wallHeight = Game.gcl.level < settings.wallHeightGCL ? settings.wallHeight[Math.min(rcl - 1, 3)] : settings.wallHeight[rcl - 1] *  spawn.memory.wallMultiplier
            if(minHits < wallHeight || defenseMode){
                cU.scheduleIfNeeded(cN.BUILDER_NAME, 3, rcl >= 6, spawn, creeps)
                return
            }
        }
        
        // ? Cache nukes (refresh every 50 ticks - nukes don't appear often)
        if (!Tmp[roomName].builderNukes || Game.time % 50 == 0) {
            Tmp[roomName].builderNukes = spawn.room.find(FIND_NUKES)
        }
        const nukes = Tmp[roomName].builderNukes
        
        if(nukes.length){
            // ? Cache nuke structures (same refresh as nukes)
            if (!Tmp[roomName].nukeStructures || Game.time % 50 == 0) {
                const structures = spawn.room.find(FIND_MY_STRUCTURES)
                Tmp[roomName].nukeStructures = []
                for (const s of structures) {
                    if ((settings.nukeStructures as string[]).includes(s.structureType)) {
                        Tmp[roomName].nukeStructures.push(s)
                    }
                }
            }
            const nukeStructures = Tmp[roomName].nukeStructures
            
            for(const structure of nukeStructures){
                let rampartHeightNeeded = 0
                for(const nuke of nukes){
                    if(structure.pos.isEqualTo(nuke.pos)){
                        rampartHeightNeeded += 5000000
                    }
                    if(structure.pos.inRangeTo(nuke.pos, 2)){
                        rampartHeightNeeded += 5000000
                    }
                }
                if(rampartHeightNeeded == 0){
                    continue
                }
                const rampart = _.find(structure.pos.lookFor(LOOK_STRUCTURES), s => s.structureType == STRUCTURE_RAMPART)
                if(!rampart){
                    structure.pos.createConstructionSite(STRUCTURE_RAMPART)
                } else if(rampart.hits < rampartHeightNeeded + 30000){
                    sq.schedule(spawn, cN.BUILDER_NAME, rcl >= 7)
                    return
                }
            }
        }
    }
}

function updateRunner(creeps: Creep[], spawn, extensions, memory, rcl, emergencyTime) {
    if (rcl == 8 && !emergencyTime && Game.cpu.bucket < settings.bucket.mineralMining) {
        return
    }
    
    // ? Cache miner filtering (refresh every 10 ticks - miners change infrequently)
    const roomName = spawn.room.name
    if (!Tmp[roomName]) {
        Tmp[roomName] = {}
    }
    if (!Tmp[roomName].runnerMiners || Game.time % 10 == 0) {
        Tmp[roomName].runnerMiners = _.filter(creeps, creep => creep.memory.role == cN.REMOTE_MINER_NAME && !creep.memory.link)
    }
    const miners = Tmp[roomName].runnerMiners
    
    const minRunners = rcl < 7 ? 4 : 0
    const distances = _.map(miners, miner => PathFinder.search(spawn.pos, miner.pos).cost)
    let totalDistance = _.sum(distances)
    if(extensions < 10 && Object.keys(Game.rooms).length == 1) totalDistance = totalDistance * 0.8//for when there are no reservers
    const minerEnergyPerTick = SOURCE_ENERGY_CAPACITY/ENERGY_REGEN_TIME
    const energyProduced = 2 * totalDistance * minerEnergyPerTick
    const energyCarried = types.store(types.getRecipe(cN.RUNNER_NAME, spawn.room.energyCapacityAvailable, spawn.room))
    let runnersNeeded = Math.min(settings.max.runners, Math.max(Math.ceil(energyProduced / energyCarried), minRunners))
    runnersNeeded += rR.getControllerRunnersNeeded(spawn)
    cU.scheduleIfNeeded(cN.RUNNER_NAME, runnersNeeded, false, spawn, creeps)
    memory[cN.RUNNER_NAME] = 0 //TODO: remove
}

function updateFerry(spawn, rcl) {
    if (rcl >= 5) {
        cU.scheduleIfNeeded(cN.FERRY_NAME, 1, false, spawn, u.splitCreepsByCity()[spawn.name])
    }
}

function updateStorageLink(spawn, memory, structures: Structure[]) {
    if(!structures.length || !Game.getObjectById(memory.storageLink)){
        memory.storageLink = null
    }
    if(!spawn.room.storage) {
        return
    }

    const storageLink = _.find(structures, structure => structure.structureType == STRUCTURE_LINK && structure.pos.inRangeTo(spawn.room.storage.pos, 3))
    if (storageLink){
        memory.storageLink = storageLink.id
    } else {
        memory.storageLink = null
    }
}

function updateHighwayCreep(flagName: string, spawn: StructureSpawn, creeps: Creep[], role: cN) {
    const flagNames = _.filter(Object.keys(Memory.flags), flag => flag.includes(flagName))
    for(const flag of flagNames){
        const boosted = role != cN.HARASSER_NAME || Memory.flags[flag].boosted && PServ
        const numNeeded = role == cN.POWER_MINER_NAME && PServ ? 2 : 1
        // distance is a very rough approximation here, so not bothering to factor in spawn time
        const route = motion.getRoute(spawn.room.name, Memory.flags[flag].roomName, true)
        const distance = route == -2 ? 0 : route.length * 50
        cU.scheduleIfNeeded(role, numNeeded, boosted, spawn, creeps, flag, distance)
    }
}

function runNuker(city){
    const flagName = city + "nuke"
    const flag = Memory.flags[flagName]
    if (flag && !Tmp.nuked){
        Tmp.nuked = true //ensure that only one nuke is launched per tick (and per iteration)
        const nuker = _.find(Game.spawns[city].room.find(FIND_MY_STRUCTURES), structure => structure.structureType === STRUCTURE_NUKER) as StructureNuker
        nuker.launchNuke(new RoomPosition(flag.x, flag.y, flag.roomName))
        delete Memory.flags[flagName]
    }
}

function setGameState(){
    // 1 spawn and no creeps = reset
    const roomNames = Object.keys(Game.rooms)
    const room = Game.rooms[roomNames[0]]
    const rcl1 = room && room.controller && room.controller.level == 1
    const hasOneSpawn = room && room.find(FIND_MY_STRUCTURES).filter(s => s.structureType == STRUCTURE_SPAWN).length == 1
    const noCreeps = Object.keys(Game.creeps).length == 0
    if(!Memory.gameState || (roomNames.length == 1 && rcl1 && hasOneSpawn && noCreeps)){
        Object.keys(Memory).forEach(key => delete Memory[key])
        Memory.creeps = {}
        Memory.rooms = {}
        Memory.spawns = {}
        Memory.gameState = 0
        Memory.startTick = Game.time
    }
}

function runEarlyGame(){
    const spawn = Object.values(Game.spawns)[0]
    if(!spawn){
        Memory.gameState = 1
        return
    }
    const sources = spawn.room.find(FIND_SOURCES)

    // find closest source to spawn
    const closestSource = spawn.pos.findClosestByPath(sources)
    const otherSource = _.find(sources, source => source.id != closestSource.id)


    sq.schedule(spawn, cN.RUNNER_NAME, false, null, 100, -7)
    sq.schedule(spawn, cN.REMOTE_MINER_NAME, false, closestSource.id, 200, -6)
    sq.schedule(spawn, cN.RUNNER_NAME, false, null, 100, -5)
    sq.schedule(spawn, cN.UPGRADER_NAME, false, null, 200, -4)
    if(roomU.countMiningSpots(closestSource.pos) > 1){
        sq.schedule(spawn, cN.REMOTE_MINER_NAME, false, closestSource.id, 300, -3)
    }
    sq.schedule(spawn, cN.REMOTE_MINER_NAME, false, otherSource.id, 300, -2)
    if(roomU.countMiningSpots(otherSource.pos) > 1){
        sq.schedule(spawn, cN.REMOTE_MINER_NAME, false, otherSource.id, 200, -1)
    }
    Memory.gameState = 1
}

function updateSpawnStress(spawn: StructureSpawn){
    const room = spawn.room
    const memory = spawn.memory
    if(!memory.spawnAvailability && memory.spawnAvailability != 0) memory.spawnAvailability = 1//start out with expected RCL1 use

    if (Game.time % 37 == 0) {
        const spawns = room.find(FIND_MY_SPAWNS)
        //TODO: spawnAttempt errors could be tracked separately.

        const remainingSpawnTime = _.sum(spawns, s => s.spawning ? s.spawning.remainingTime : 0)
        const queueTime = sq.getTime(spawn) + remainingSpawnTime
        const windowOffset = Math.ceil(queueTime / spawns.length) // time until we deplete the queue
        const windowStartTime = Game.time + windowOffset - CREEP_LIFE_TIME

        // find all localCreeps that were spawned during our window
        const localCreepMem = u.splitCreepMemByCity()[spawn.name] // array of creep memories instead of creeps

        // whatever is less: creep spawn time, time between current time and birth, time between birth and window start
        const pastSpawnedTime = _.sum(localCreepMem, mem => Math.min(Math.max(mem.spawnTime - Math.max(windowStartTime - mem.spawnTick,
            0),
        0),
        Game.time - mem.spawnTick))

        const creepSpawnTime = pastSpawnedTime + queueTime
        memory.spawnAvailability= spawns.length - (creepSpawnTime / CREEP_LIFE_TIME)
    }
}

function updateRemotes(city: string, myCreeps: Creep[]){
    if(Game.cpu.bucket < settings.bucket.mineralMining){
        return
    }
    const spawn = Game.spawns[city]
    const stress = spawn.memory.spawnAvailability
    const remotes = Object.keys(_.countBy(spawn.memory.sources, s => s.roomName))
    if(remotes.length > 1 && stress < settings.spawnFreeTime - settings.spawnFreeTimeBuffer && Game.time % 500 == 5){
        //drop least profitable remote
        Log.info(`Spawn pressure too high in ${spawn.room.name}, dropping least profitable remote...`)
        const worstRemote = rp.findWorstRemote(spawn.room)
        if(worstRemote){
            Log.info(`Remote ${worstRemote.roomName} removed from ${spawn.room.name}`)
            rp.removeRemote(worstRemote.roomName, spawn.room.name)
        } else {
            Log.info("No remotes to remove")
        }
    }
    
    // ? LEVEL 2 VALIDATION: Remote Sync Validation (Every 100 Ticks)
    // Detects and fixes ghost remotes (sources exist but no Memory.remotes entry)
    if(Game.time % 100 == 7){
        const remotesInSpawn = Object.keys(_.countBy(spawn.memory.sources, s => s.roomName))
        
        // Check for ghost remotes (in spawn.memory but not in Memory.remotes)
        for(const remoteName of remotesInSpawn){
            if(remoteName == spawn.room.name) continue  // Skip home room
            
            if(!Memory.remotes[remoteName]){
                Log.warning(`[L2] Ghost remote ${remoteName} in ${spawn.name}, cleaning up`)
                
                // Remove all sources from this ghost remote
                for(const sourceId in spawn.memory.sources){
                    if(spawn.memory.sources[sourceId].roomName == remoteName){
                        delete spawn.memory.sources[sourceId]
                    }
                }
            }
        }
        
        // Check for orphaned Memory.remotes (no spawns have sources for this room)
        for(const remoteName of Object.keys(Memory.remotes)){
            const hasAnySource = _.some(Game.spawns, otherSpawn => 
                otherSpawn.memory && // ? Check memory exists first
                otherSpawn.memory.sources &&
                _.some(otherSpawn.memory.sources, s => s.roomName == remoteName)
            )
            
            if(!hasAnySource){
                Log.warning(`[L2] Orphaned remote ${remoteName} in Memory.remotes, cleaning up`)
                delete Memory.remotes[remoteName]
            }
        }
    }
    
    // ? LEVEL 3 VALIDATION: Deep Validation (Every 500 Ticks)
    // Comprehensive validation of all spawn.memory.sources entries
    if(Game.time % 500 == 13){
        validateSpawnMemory(spawn)
    }
    
    if(Game.time % 10 == 3){
        const harasserRecipe = types.getRecipe(cN.HARASSER_NAME, Game.spawns[city].room.energyCapacityAvailable, Game.spawns[city].room)
        const harasserSize = harasserRecipe.length
        for(const remoteName of remotes){
            if(remoteName == spawn.room.name)
                continue
            const defcon = updateDEFCON(remoteName, harasserSize)
            if(defcon >= 4){
                Log.info(`Remote ${remoteName} removed from ${spawn.room.name} due to high level threat`)
                rp.removeRemote(remoteName, spawn.room.name)
                continue
            }
            
            // ? CHECK: Source accessibility (with OR without vision)
            if(Game.time % 100 == 3 && Memory.data.lastReset < Game.time - 5) {
                let droppedRemote = false
                
                if(Game.rooms[remoteName]){
                    // WITH VISION: Check all sources
                    // Cache sources
                    if (!Tmp[remoteName]) {
                        Tmp[remoteName] = {}
                    }
                    if (!Tmp[remoteName].remoteSources || Game.time % 100 == 3) {
                        Tmp[remoteName].remoteSources = Game.rooms[remoteName].find(FIND_SOURCES)
                    }
                    const sources = Tmp[remoteName].remoteSources
                    
                    for (const source of sources) {
                        const pathLength = u.getRemoteSourceDistance(spawn.pos, source.pos)
                        if (pathLength == -1) {
                            Log.info(`Remote ${remoteName} removed from ${spawn.room.name} due to inaccessable source at ${source.pos}`)
                            rp.removeRemote(remoteName, spawn.room.name)
                            droppedRemote = true
                            break
                        }
                    }
                } else {
                    // WITHOUT VISION: Check if we can path to center (detects blocked exits)
                    const testPos = new RoomPosition(25, 25, remoteName)
                    const testPath = PathFinder.search(spawn.pos, {pos: testPos, range: 20}, {
                        plainCost: 1,
                        swampCost: 1,
                        maxOps: 10000,
                        roomCallback: function(rN){
                            const safe = Memory.remotes[rN] 
                                || (Cache.roomData[rN] && Cache.roomData[rN].own == settings.username)
                                || u.isHighway(rN)
                                || rN == remoteName
                            if(!safe) return false
                        }
                    })
                    if(testPath.incomplete){
                        Log.info(`Remote ${remoteName} removed from ${spawn.room.name} due to blocked exits (no vision)`)
                        rp.removeRemote(remoteName, spawn.room.name)
                        droppedRemote = true
                    }
                }
                
                if (droppedRemote) {
                    continue
                }
            }
            if (u.isSKRoom(remoteName)){
                //if room is under rcl7 spawn a quad
                if (spawn.room.controller.level < 7){
                    cU.scheduleIfNeeded(cN.QUAD_NAME, 1, false, spawn, myCreeps, remoteName, 300)
                } else {
                    cU.scheduleIfNeeded(cN.SK_GUARD_NAME, 1, false, spawn, myCreeps, remoteName, 300)
                    if (Game.rooms[remoteName]) {
                        // Cache minerals
                        if (!Tmp[remoteName].skMinerals || Game.time % 100 == 0) {
                            Tmp[remoteName].skMinerals = Game.rooms[remoteName].find(FIND_MINERALS)
                        }
                        const minerals = Tmp[remoteName].skMinerals
                        
                        if (minerals.length) {
                            const mineral = minerals[0]
                            if (mineral.mineralAmount > 0 && spawn.room.terminal && spawn.room.terminal.store[mineral.mineralType] < 6000) {
                                cU.scheduleIfNeeded(cN.MINERAL_MINER_NAME, 1, false, spawn, myCreeps, remoteName, 300)
                            }
                        }
                    }
                }
            }
            if(Game.rooms[remoteName]){
                // Cache hostile structures check
                if (!Tmp[remoteName]) {
                    Tmp[remoteName] = {}
                }
                if (!Tmp[remoteName].invaderCoreCheck || Game.time % 50 == 0) {
                    const hostileStructures = Game.rooms[remoteName].find(FIND_HOSTILE_STRUCTURES)
                    Tmp[remoteName].hasInvaderCore = hostileStructures.length > 0
                    Tmp[remoteName].invaderCoreCheck = Game.time
                }
                const invaderCore = Tmp[remoteName].hasInvaderCore
                
                if(invaderCore && !u.isSKRoom(remoteName)){
                    const bricksNeeded = spawn.room.controller.level < 5 ? 4 : 1
                    cU.scheduleIfNeeded(cN.BRICK_NAME, bricksNeeded, false, spawn, myCreeps, remoteName, 100)
                }
                const reserverCost = 650
                const controller = Game.rooms[remoteName].controller
                if(spawn.room.energyCapacityAvailable >= reserverCost 
                    && controller 
                    && !controller.owner 
                    && (!controller.reservation 
                        || controller.reservation.ticksToEnd < 2000 
                        || controller.reservation.username != settings.username)){
                    const reserversNeeded = spawn.room.energyCapacityAvailable >= reserverCost * 2 || roomU.countMiningSpots(controller.pos) < 2 ? 1 : 2
                    cU.scheduleIfNeeded(cN.RESERVER_NAME, reserversNeeded, false, spawn, myCreeps, remoteName, 100)
                }
            }
            if(defcon == 2){
                cU.scheduleIfNeeded(cN.HARASSER_NAME, 1, false, spawn, myCreeps, remoteName, 300)
            }
            if(defcon == 3){
                cU.scheduleIfNeeded(cN.HARASSER_NAME, 2, false, spawn, myCreeps, remoteName, 300)
                cU.scheduleIfNeeded(cN.QUAD_NAME, 4, false, spawn, myCreeps, remoteName, 300)
            }
        }
    }
}

// ? LEVEL 3 VALIDATION FUNCTION: Deep Memory Validation
// Validates all source entries including containerPos and linkPos
function validateSpawnMemory(spawn: StructureSpawn){
    if(!spawn || !spawn.memory.sources) return
    
    let fixCount = 0
    
    // Validate all source entries
    for(const sourceId in spawn.memory.sources){
        const sourcePos = spawn.memory.sources[sourceId]
        
        // Check if source entry exists and is an object
        if(!sourcePos || typeof sourcePos !== "object"){
            Log.error(`[L3] Invalid source entry ${sourceId} in ${spawn.name}, removing`)
            delete spawn.memory.sources[sourceId]
            fixCount++
            continue
        }
        
        // Check if RoomPosition has all required fields
        if(!sourcePos.roomName || sourcePos.x === undefined || sourcePos.y === undefined){
            Log.error(`[L3] Incomplete RoomPosition for ${sourceId} in ${spawn.name}, removing`)
            delete spawn.memory.sources[sourceId]
            fixCount++
            continue
        }
        
        // Check if coordinates are within valid bounds (0-49)
        if(sourcePos.x < 0 || sourcePos.x > 49 || sourcePos.y < 0 || sourcePos.y > 49){
            Log.error(`[L3] Out of bounds position for ${sourceId}: (${sourcePos.x}, ${sourcePos.y}) in ${spawn.name}, removing`)
            delete spawn.memory.sources[sourceId]
            fixCount++
            continue
        }
        
        // Validate containerPos if it exists (packed position must be 0-2499)
        if(sourcePos[STRUCTURE_CONTAINER + "Pos"] !== undefined){
            const cPos = sourcePos[STRUCTURE_CONTAINER + "Pos"]
            if(typeof cPos !== "number" || cPos < 0 || cPos > 2499){
                Log.warning(`[L3] Invalid containerPos for ${sourceId} in ${spawn.name}, resetting`)
                delete sourcePos[STRUCTURE_CONTAINER + "Pos"]
                fixCount++
            }
        }
        
        // Validate linkPos if it exists (packed position must be 0-2499)
        if(sourcePos[STRUCTURE_LINK + "Pos"] !== undefined){
            const lPos = sourcePos[STRUCTURE_LINK + "Pos"]
            if(typeof lPos !== "number" || lPos < 0 || lPos > 2499){
                Log.warning(`[L3] Invalid linkPos for ${sourceId} in ${spawn.name}, resetting`)
                delete sourcePos[STRUCTURE_LINK + "Pos"]
                fixCount++
            }
        }
    }
    
    if(fixCount > 0){
        Log.info(`[L3] ${spawn.name}: Fixed ${fixCount} corrupted source entries`)
    }
}

function updateDEFCON(remote, harasserSize){
    //1: no threat
    //2: one harasser guard for invaders
    //3: 2 harassers and a quad TODO: dynamic defense
    //4: abandon room
    const roomInfo = u.getsetd(Cache.roomData, remote, {})
    if(!roomInfo.d){
        roomInfo.d = 2
    }
    if(Game.rooms[remote]){
        const remoteRoom = Game.rooms[remote]
        if(remoteRoom.controller && (remoteRoom.controller.owner
            || (remoteRoom.controller.reservation 
                && Memory.settings.allies.includes(remoteRoom.controller.reservation.username)
                && remoteRoom.controller.reservation.username != settings.username))){
            Cache.roomData[remote].d = 4
            return Cache.roomData[remote].d
        }
        // if room is an SK room, check for invader core
        if(u.isSKRoom(remote)){
            const invaderCore = _.find(remoteRoom.find(FIND_HOSTILE_STRUCTURES), s => s.structureType == STRUCTURE_INVADER_CORE) as StructureInvaderCore
            if(invaderCore && !invaderCore.ticksToDeploy){
                Cache.roomData[remote].d = 4
                // set scout time to now
                Cache.roomData[remote].sct = Game.time
                // set safeTime to core expiry
                Cache.roomData[remote].sME = Game.time + invaderCore.effects[0].ticksRemaining
                return Cache.roomData[remote].d
            }
        }
        const hostiles = _.filter(u.findHostileCreeps(Game.rooms[remote]), h => h instanceof Creep 
            && h.owner.username != "Source Keeper" 
            && (h.getActiveBodyparts(WORK) 
                || h.getActiveBodyparts(RANGED_ATTACK) 
                || h.getActiveBodyparts(ATTACK) 
                || h.getActiveBodyparts(HEAL)))
        
        // ? FIX: Count combat AND dismantle threat
        let combatParts = 0
        for(let i = 0; i < hostiles.length; i++){
            const hostile = hostiles[i] as Creep
            const attackParts = hostile.getActiveBodyparts(ATTACK)
            const rangedParts = hostile.getActiveBodyparts(RANGED_ATTACK)
            const healParts = hostile.getActiveBodyparts(HEAL)
            const workParts = hostile.getActiveBodyparts(WORK)
            
            // ? Combat parts (full weight)
            combatParts += attackParts + rangedParts + healParts
            
            // ? Work parts (dismantler threat - but only if they have MOVE parts too)
            // Miners have WORK but few MOVE, dismantlers have balanced WORK/MOVE
            const moveParts = hostile.getActiveBodyparts(MOVE)
            if(workParts > 0 && moveParts >= workParts * 0.5){
                // This is likely a dismantler, not a miner
                combatParts += workParts
            }
        }
        
        // ? FIX: Calculate harasser combat strength (not total size)
        // Typical harasser: [4 RANGED, 5 MOVE, 1 HEAL] ? 5 combat parts per unit
        const harasserCombatParts = Math.ceil(harasserSize * 0.5) // Assume ~50% are combat parts
        
        if(combatParts > harasserCombatParts * 6){
            roomInfo.d = 4
        } else if(combatParts > harasserCombatParts){
            roomInfo.d = 3
        } else if(combatParts > 0){
            roomInfo.d = 2
        } else {
            roomInfo.d = 1
        }
    } else {
        // ? FIX: Assignment operator instead of comparison
        if(Game.time % 1000 == 3 && roomInfo.d == 4){
            roomInfo.d = 3  // ?? FIXED: Changed from == to =
        }
    }
    Cache.roomData[remote].d = roomInfo.d
    return roomInfo.d
}

export = {
    chooseClosestRoom: chooseClosestRoom,
    runCity: runCity,
    updateCountsCity: updateCountsCity,
    runTowers: runTowers,
    setGameState: setGameState,
    runEarlyGame: runEarlyGame,
}
