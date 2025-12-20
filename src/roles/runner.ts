import actions = require("../lib/actions")
import u = require("../lib/utils")
import roomU = require("../lib/roomUtils")
import { cU } from "../lib/creepUtils"
import motion = require("../lib/motion")
import rU = require("./upgrader")
import { cN, BodyType } from "../lib/creepNames"
import types = require("../config/types")
import linkLib = require("../buildings/link")

const rR = {
    name: cN.RUNNER_NAME,
    type: BodyType.runner,
    target: 0,

    run: function(creep: Creep) {
        // ? DEBUG: Comprehensive state logging every tick for problematic runners
        const shouldLog = creep.memory.tug || Game.time % 10 == 0
        if(shouldLog){
            Log.info(`[RUNNER] ${creep.name} T${Game.time} | tug:${creep.memory.tug} pullee:${creep.memory.pullee ? "YES" : "NO"} mode:${creep.memory.mode} targetId:${creep.memory.targetId ? "YES" : "NO"} store:${creep.store.energy}/${creep.store.getCapacity()}`)
        }
        
        if (creep.memory.flag && creep.memory.flag.includes("powerMine")){
            rR.runPower(creep)
            return
        }
        if (creep.memory.flag && Game.rooms[creep.memory.flag] && Game.rooms[creep.memory.flag].storage){
            rR.runDelivery(creep)
            return
        }
        if (creep.memory.juicer && rR.runController(creep)){
            return
        }
        // ? FIX: Check tug status - if tug is complete (false), clear tug memory and continue to normal tasks
        if (creep.memory.tug){
            if(shouldLog) Log.info(`[RUNNER] ${creep.name} | Calling runTug()`)
            const tugInProgress = rR.runTug(creep)
            if(shouldLog) Log.info(`[RUNNER] ${creep.name} | runTug returned: ${tugInProgress}`)
            if(tugInProgress){
                return  // Only return if tug is still in progress
            }
            // ? FIX: Tug completed or failed - clear ALL tug-related memory
            if(shouldLog) Log.info(`[RUNNER] ${creep.name} | Tug completed/failed, clearing tug memory`)
            creep.memory.tug = false
            creep.memory.pullee = null
            // Fall through to normal tasks
        }
        if (Game.cpu.bucket > 9500 || Game.time % 2) {
            actions.notice(creep)
        }
        if(creep.memory.mode == 1 && creep.store.getUsedCapacity() == 0)
            creep.memory.mode = 0
        if(creep.memory.mode == 0 && creep.store.getFreeCapacity() < 0.5 * creep.store.getCapacity()){
            if(shouldLog) Log.info(`[RUNNER] ${creep.name} | Mode switch 0->1 (store > 50%)`)
            creep.memory.mode = 1
            creep.memory.targetId = null
        }
        if(creep.memory.mode == 0 && !creep.memory.targetId){
            if(shouldLog) Log.info(`[RUNNER] ${creep.name} | Checking for pullees`)
            rR.checkForPullees(creep)
            if(creep.memory.tug){
                if(shouldLog) Log.info(`[RUNNER] ${creep.name} | Found pullee, starting tug`)
                return
            }
        }
        if (creep.memory.mode == 0) {
            if(shouldLog) Log.info(`[RUNNER] ${creep.name} | Mode 0: Calling pickup()`)
            if(!rR.pickup(creep)){
                if(shouldLog) Log.info(`[RUNNER] ${creep.name} | pickup() returned false, energy:${creep.store.energy}`)
                // ? FIX: Only call runController if runner has SOME energy
                // This prevents runners from going to upgrader link immediately after emptying a container
                if(creep.store.energy > 0 && !rR.runController(creep)){
                    if(shouldLog) Log.info(`[RUNNER] ${creep.name} | runController() returned false, parking`)
                    rR.parkRunner(creep)
                } else if(creep.store.energy == 0){
                    if(shouldLog) Log.info(`[RUNNER] ${creep.name} | Empty, parking`)
                    rR.parkRunner(creep)
                }
            } else {
                if(shouldLog) Log.info(`[RUNNER] ${creep.name} | pickup() returned true`)
            }
        } else {
            if(shouldLog) Log.info(`[RUNNER] ${creep.name} | Mode 1: Deposit cycle`)
            if (!creep.memory.location || !Game.getObjectById(creep.memory.location))
                creep.memory.location = Game.spawns[creep.memory.city].room.storage.id
            const target = Game.getObjectById(creep.memory.location)
            if(target.store.energy < 2000 || !rR.runController(creep))
                rR.deposit(creep)
        }
    },

    flipTarget: function(creep: Creep) {
        creep.memory.mode = cU.getNextLocation(creep.memory.mode, roomU.getTransferLocations(creep))
    },

    checkForPullees: function(creep: Creep){
        const roomName = creep.room.name
        if (!Tmp[roomName]) {
            Tmp[roomName] = {}
        }
        
        if (!Tmp[roomName].pulleeCheck || Game.time % 5 == 0) {
            Tmp[roomName].potentialPullees = creep.room.find(FIND_MY_CREEPS)
            Tmp[roomName].pulleeCheck = Game.time
        }
        
        const availablePullees = []
        for (const c of Tmp[roomName].potentialPullees) {
            // ? FIX: Validate ALL destination properties, not just existence
            if (c.memory.destination 
                && c.memory.destination.x !== undefined 
                && c.memory.destination.y !== undefined 
                && c.memory.destination.roomName
                && !c.memory.paired) {
                
                // ? FIX: Don't tug creeps that are ALREADY at their destination!
                // This prevents wasted tug cycles on creeps that spawned at their target location
                if(c.pos.x === c.memory.destination.x 
                    && c.pos.y === c.memory.destination.y 
                    && c.pos.roomName === c.memory.destination.roomName){
                    // Creep is already at destination, clear the destination flag
                    c.memory.destination = null
                    continue
                }
                
                availablePullees.push(c)
            }
        }
        
        Log.info(`[RUNNER] ${creep.name} | Found ${availablePullees.length} available pullees in ${roomName}`)
        
        if (availablePullees.length > 0) {
            const pullee = availablePullees[0]
            Log.info(`[RUNNER] ${creep.name} | Pairing with ${pullee.name} (${pullee.memory.role}) to ${pullee.memory.destination.roomName}`)
            creep.memory.tug = true
            creep.memory.pullee = pullee.id
            pullee.memory.paired = creep.id
        }
    },

    runDelivery: function(creep: Creep) {
        if (!creep.memory.resource) {
            return
        }
        
        // Validate room visibility before accessing storage
        if(!Game.rooms[creep.memory.flag]){
            motion.newMove(creep, new RoomPosition(25, 25, creep.memory.flag), 24)
            return
        }
        
        if (creep.store.getUsedCapacity() > 0) {
            if (creep.memory.resource == RESOURCE_GHODIUM && creep.store.getUsedCapacity() >= SAFE_MODE_COST) {
                if (creep.generateSafeMode(Game.rooms[creep.memory.flag].controller) == ERR_NOT_IN_RANGE) {
                    motion.newMove(creep, Game.rooms[creep.memory.flag].controller.pos, 1)
                }
            } else {
                actions.charge(creep, Game.rooms[creep.memory.flag].storage)
            }
        } else if (creep.room.name == creep.memory.flag) {
            if (creep.room.controller.my) {
                creep.memory.city = creep.room.name + "0"
                creep.memory.flag = null
                creep.memory.resource = null
            } else {
                const recycleSpawn = _.find(creep.room.find(FIND_MY_SPAWNS))
                if (recycleSpawn && recycleSpawn.recycleCreep(creep) == ERR_NOT_IN_RANGE) {
                    motion.newMove(creep, recycleSpawn.pos, 1)
                } else if (!recycleSpawn) {
                    creep.suicide()
                }
            }
        } else {
            actions.withdraw(creep, Game.spawns[creep.memory.city].room.terminal, creep.memory.resource)
        }
    },

    runController: function(creep: Creep){
        const link = rU.getUpgradeLink(creep)

        if(!link) return false
        if(!creep.memory.juicer && (link.store.getFreeCapacity(RESOURCE_ENERGY) == 0 || creep.room.name != link.room.name)) return false

        const tempMem = u.getsetd(Tmp, Game.spawns[creep.memory.city].room.name, {})

        if(creep.saying == "*" && creep.store.energy == 0){
            creep.memory.juicer = false
        }
        const creeps = u.splitCreepsByCity()[creep.memory.city]
        let juicersNeeded = rR.getControllerRunnersNeeded(Game.spawns[creep.memory.city])

        if (!creep.memory.juicer && creep.store.getUsedCapacity() == 0 
            && _.filter(creeps, c => c.memory.juicer && c.pos.inRangeTo(link.pos, 3)).length > juicersNeeded - 2) {
            return false
        }

        if (creep.store.getFreeCapacity() == 0 && link.store.getFreeCapacity() as number > creep.store.getUsedCapacity()) {
            juicersNeeded += Math.floor(link.store.getFreeCapacity() as number/creep.store.getUsedCapacity())
        }

        if (juicersNeeded == 0) {
            creep.memory.juicer = false
            return false
        }

        if (!creep.memory.juicer) {
            if (!tempMem.juicers) {
                tempMem.juicers = _.filter(creeps, c => c.memory.juicer).length
            }
            if (tempMem.juicers < juicersNeeded) {
                creep.memory.juicer = true
                tempMem.juicers++
            } else {
                return false
            }
        }

        if (creep.store.energy > 0) {
            if (actions.charge(creep, link) == 1) {
                creep.say("*")
            }
        } else {
            if (!creep.memory.location || !Game.getObjectById(creep.memory.location))
                creep.memory.location = Game.spawns[creep.memory.city].room.storage.id
            const target = Game.getObjectById(creep.memory.location)
            if(target.store.energy < 1500) return false
            if ( actions.withdraw(creep, target) == 1) {
                motion.newMove(creep, link.pos, 1)
            }
        }
        return true
    },

    pickup: function(creep: Creep) {
        // DEBUG: Log entry
        if(Game.time % 50 == 0){
            Log.info("[runner.pickup] Called for " + creep.name + " with targetId: " + creep.memory.targetId)
        }
        
        if(creep.memory.targetId) {
            const target = Game.getObjectById(creep.memory.targetId)
            if(target){
                let result
                if(!(target instanceof Resource)) {
                    const storeTarget = target as AnyStoreStructure
                    let max = 0
                    let maxResource: ResourceConstant = null
                    for(const resource of Object.keys(storeTarget.store) as ResourceConstant[]){
                        if(storeTarget.store[resource] > max){
                            max = storeTarget.store[resource]
                            maxResource = resource
                        }
                    }
                    result = actions.withdraw(creep, target, maxResource)
                } else {
                    result = actions.pick(creep, target)
                }
                
                // Clear targetId on success or if target is depleted
                if(result == 1 || result == ERR_NOT_ENOUGH_RESOURCES){
                    creep.memory.targetId = null
                }
                return true
            } else {
                creep.memory.targetId = null
            }
        }
        
        // DEBUG: Log before getGoodPickups
        if(Game.time % 50 == 0){
            Log.info("[runner.pickup] Calling getGoodPickups for " + creep.name)
        }
        
        const goodLoads = cU.getGoodPickups(creep)
        
        // DEBUG: Log result
        if(Game.time % 50 == 0){
            Log.info("[runner.pickup] getGoodPickups returned " + goodLoads.length + " loads")
        }
        
        if(!goodLoads.length)
            return false
            
        if (!Tmp.pickupReservations) {
            Tmp.pickupReservations = {}
        }
        
        const runners = _.filter(u.splitCreepsByCity()[creep.memory.city], c => c.memory.role == rR.name)
        
        for (const runner of runners) {
            if (runner.memory.targetId && runner.id !== creep.id) {
                if (!Tmp.pickupReservations[runner.memory.targetId]) {
                    Tmp.pickupReservations[runner.memory.targetId] = 0
                }
                Tmp.pickupReservations[runner.memory.targetId] += runner.store.getFreeCapacity()
            }
        }
        
        const myFreeCapacity = creep.store.getFreeCapacity()
        
        const newTarget = _.min(goodLoads, function(drop: Resource | Tombstone | AnyStoreStructure){
            const distance = creep.pos.getRangeTo(drop.pos)
            
            const isResource = "amount" in drop
            let amount: number
            if (isResource) {
                amount = (drop as Resource).amount
            } else {
                amount = drop.store.getUsedCapacity()
            }
            
            const reserved = Tmp.pickupReservations[drop.id] || 0
            amount = Math.max(amount - reserved, 0)
            
            const isTombstoneOrRuin = "creep" in drop || "structure" in drop
            const isValuableResource = isResource && (drop as Resource).resourceType !== RESOURCE_ENERGY
            const isHighPriority = isTombstoneOrRuin || isValuableResource
            
            if (!isHighPriority && amount < myFreeCapacity) {
                return Infinity
            }
            
            if (amount === 0) {
                return Infinity
            }
            
            const effectiveDistance = isHighPriority ? distance * 0.5 : distance
            return effectiveDistance / amount
        })
        
        if (newTarget && _.isFinite(creep.pos.getRangeTo(newTarget.pos))) {
            const isResource = "amount" in newTarget
            const targetAmount = isResource ? 
                (newTarget as Resource).amount : 
                newTarget.store.getUsedCapacity()
            
            const reserved = Tmp.pickupReservations[newTarget.id] || 0
            const available = Math.max(targetAmount - reserved, 1)
            const score = creep.pos.getRangeTo(newTarget.pos) / available
            
            if (score !== Infinity) {
                creep.memory.targetId = newTarget.id
                if (!Tmp.pickupReservations[newTarget.id]) {
                    Tmp.pickupReservations[newTarget.id] = 0
                }
                Tmp.pickupReservations[newTarget.id] += myFreeCapacity
                return rR.pickup(creep)
            }
        }
        
        return false
    },

    deposit: function(creep: Creep){
        if (!creep.memory.location || !Game.getObjectById(creep.memory.location))
            creep.memory.location = Game.spawns[creep.memory.city].room.storage.id
        const target = Game.getObjectById(creep.memory.location)
        if (actions.charge(creep, target) == ERR_FULL) 
            creep.memory.location = Game.spawns[creep.memory.city].room.storage.id
    },

    parkRunner: function(creep: Creep) {
        if (Game.time % 5 !== 0) return
        
        const spawn = Game.spawns[creep.memory.city]
        if (!spawn || !spawn.room) return
        
        const roomName = spawn.room.name
        if (!Tmp[roomName]) {
            Tmp[roomName] = {}
        }
        
        if (!Tmp[roomName].parkingStructures || Game.time % 50 == 0) {
            Tmp[roomName].parkingStructures = spawn.room.find(FIND_STRUCTURES, {
                filter: (s) => s.structureType === STRUCTURE_STORAGE ||
                              s.structureType === STRUCTURE_TERMINAL ||
                              s.structureType === STRUCTURE_CONTAINER ||
                              s.structureType === STRUCTURE_SPAWN
            })
        }
        
        const storeStructures = Tmp[roomName].parkingStructures
        if (!storeStructures || !storeStructures.length) return
        
        let closestStore = null
        let minDistance = Infinity
        
        for (const structure of storeStructures) {
            const distance = creep.pos.getRangeTo(structure)
            if (distance < minDistance) {
                minDistance = distance
                closestStore = structure
            }
        }
        
        if (!closestStore) return
        
        const idealDistance = 4
        
        if (minDistance >= idealDistance) {
            const blockingCheck = creep.pos.lookFor(LOOK_CREEPS)
            if (blockingCheck.length > 1) {
                const direction = creep.pos.getDirectionTo(closestStore)
                const oppositeDirection = ((direction + 3) % 8 + 1) as DirectionConstant
                creep.move(oppositeDirection)
            }
            return
        }
        
        const storePos = closestStore.pos
        const dx = creep.pos.x - storePos.x
        const dy = creep.pos.y - storePos.y
        
        const length = Math.sqrt(dx * dx + dy * dy) || 1
        const targetX = Math.floor(storePos.x + (dx / length) * idealDistance)
        const targetY = Math.floor(storePos.y + (dy / length) * idealDistance)
        
        const clampedX = Math.max(1, Math.min(48, targetX))
        const clampedY = Math.max(1, Math.min(48, targetY))
        
        const parkingSpot = new RoomPosition(clampedX, clampedY, roomName)
        
        motion.newMove(creep, parkingSpot, 1)
    },

    runTug: function(creep: Creep){
        const pullee = Game.getObjectById(creep.memory.pullee)
        if(!pullee){
            Log.info(`[TUG] ${creep.name} | Pullee not found, aborting tug`)
            creep.memory.tug = false
            creep.memory.pullee = null
            return false
        }
        
        Log.info(`[TUG] ${creep.name} | Tugging ${pullee.name} at ${pullee.pos}`)
        
        // ? FIX: Comprehensive destination validation AND immediate RoomPosition creation
        // Create destination IMMEDIATELY after validation to prevent race conditions
        if(!pullee.memory.destination 
            || pullee.memory.destination.x === undefined 
            || pullee.memory.destination.y === undefined 
            || !pullee.memory.destination.roomName){
            Log.info(`[TUG] ${creep.name} | Invalid destination for ${pullee.name}, aborting`)
            creep.memory.tug = false
            creep.memory.pullee = null
            pullee.memory.paired = null
            return false
        }
        
        // ? FIX: Create destination object IMMEDIATELY after validation
        // This prevents race conditions where destination could become null between validation and usage
        const destination = new RoomPosition(pullee.memory.destination.x, pullee.memory.destination.y, pullee.memory.destination.roomName)
        Log.info(`[TUG] ${creep.name} | Destination: ${destination}`)
        
        if(creep.ticksToLive == 1){
            pullee.memory.paired = null
            pullee.memory.destination = null
        }
        if(creep.fatigue){
            Log.info(`[TUG] ${creep.name} | Fatigued, waiting`)
            return true
        }
        
        if((roomU.isOnEdge(creep.pos) && roomU.isNearEdge(pullee.pos)) || (roomU.isOnEdge(pullee.pos) && roomU.isNearEdge(creep.pos))){
            Log.info(`[TUG] ${creep.name} | Border tug mode`)
            rR.runBorderTug(creep, pullee, destination)
            return true
        }
        
        if(!pullee.pos.isNearTo(creep.pos)){
            Log.info(`[TUG] ${creep.name} | Moving to pullee`)
            motion.newMove(creep, pullee.pos, 1)
            return true
        }
        
        if(pullee.pos.isEqualTo(destination)){
            Log.info(`[TUG] ${creep.name} | Pullee reached destination, tug complete`)
            creep.memory.tug = false
            creep.memory.pullee = null
            pullee.memory.paired = null
            pullee.memory.destination = null
            return false
        }
        
        if(creep.pos.isEqualTo(destination)){
            Log.info(`[TUG] ${creep.name} | Runner at destination, final pull`)
            creep.move(pullee)
            creep.pull(pullee)
            pullee.move(creep)
            creep.memory.tug = false
            pullee.memory.paired = null
            return true
        }
        
        Log.info(`[TUG] ${creep.name} | Tugging to destination`)
        const range = pullee.memory.sourcePos && new RoomPosition(destination.x, destination.y, destination.roomName).isEqualTo(pullee.memory.sourcePos.x, pullee.memory.sourcePos.y) ? 1 : 0
        motion.newMove(creep, destination, range)
        creep.pull(pullee)
        pullee.move(creep)
        
        return true
    },

    runBorderTug: function(creep, pullee, destination){
        // ? FIX: Validate destination properties before use
        if(!destination || !destination.roomName || destination.x === undefined || destination.y === undefined){
            creep.memory.tug = false
            creep.memory.pullee = null
            if(pullee && pullee.memory){
                pullee.memory.paired = null
                pullee.memory.destination = null
            }
            return
        }
        
        if(roomU.isOnEdge(creep.pos) && !roomU.isOnEdge(pullee.pos)){
            creep.move(pullee)
            creep.pull(pullee)
            pullee.move(creep)
            return
        }
        
        const endRoom = destination.roomName
        const path = PathFinder.search(creep.pos, destination).path
        
        if(!path || path.length < 2){
            motion.newMove(creep, destination, 0)
            return
        }
        
        let nextRoomDir = path[0].getDirectionTo(path[1]) as number
        if(nextRoomDir % 2 == 0){
            nextRoomDir = Math.random() < 0.5 ? nextRoomDir - 1 : nextRoomDir + 1
            if (nextRoomDir == 9)
                nextRoomDir = 1
        }

        const nextRoom = Game.map.describeExits(creep.pos.roomName)[nextRoomDir]
        if(roomU.isOnEdge(creep.pos) && roomU.isOnEdge(pullee.pos)){
            let direction = null
            if(creep.pos.x == 0){
                direction = RIGHT
            } else if(creep.pos.x == 49){
                direction = LEFT
            } else if(creep.pos.y == 0){
                direction = BOTTOM
            } else {
                direction = TOP
            }
            creep.move(direction)
            return
        }
        
        const sameRoom = creep.pos.roomName == pullee.pos.roomName
        let direction = null
        if(pullee.pos.x == 0){
            direction = LEFT
        } else if(pullee.pos.x == 49){
            direction = RIGHT
        } else if(pullee.pos.y == 0){
            direction = TOP
        } else {
            direction = BOTTOM
        }
        
        const range = (pullee.memory.sourcePos && new RoomPosition(destination.x, destination.y, destination.roomName).isEqualTo(pullee.memory.sourcePos.x, pullee.memory.sourcePos.y)) ? 1 : 0
        
        if(sameRoom && (creep.pos.roomName == endRoom || direction != nextRoomDir)){
            if(!creep.pos.isNearTo(pullee.pos)){
                motion.newMove(creep, pullee.pos, 1)
                return
            }
            motion.newMove(creep, destination, range)
            creep.pull(pullee)
            pullee.move(creep)
            return
        }
        
        if(!sameRoom && (pullee.pos.roomName == endRoom || pullee.pos.roomName == nextRoom)){
            motion.newMove(creep, pullee.pos)
        }
    },

    runPower: function(creep){
        if (_.sum(creep.store) > 0){
            if (!creep.memory.location){
                creep.memory.location = Game.spawns[creep.memory.city].room.storage.id
            }
            const target = Game.getObjectById(creep.memory.location)
            if (target){
                actions.charge(creep, target)
            }
            return
        }
        const flagName = creep.memory.flag || creep.memory.city + "powerMine"
        const flag = Memory.flags[flagName]
        if (flag && flag.roomName !== creep.pos.roomName){
            motion.newMove(creep, new RoomPosition(flag.x, flag.y, flag.roomName), 5)
            return
        }
        if (flag) {
            // Validate room visibility before lookFor operations
            if(!Game.rooms[flag.roomName]){
                motion.newMove(creep, new RoomPosition(flag.x, flag.y, flag.roomName), 5)
                return
            }
            
            const flagPos = new RoomPosition(flag.x, flag.y, flag.roomName)
            const resource = Game.rooms[flag.roomName].lookForAt(LOOK_RESOURCES, flagPos)
            if (resource.length){
                if (creep.pickup(resource[0]) == ERR_NOT_IN_RANGE){
                    motion.newMove(creep, flagPos, 1)
                }
                return
            }
            const ruin = Game.rooms[flag.roomName].lookForAt(LOOK_RUINS, flagPos)
            if (ruin.length){
                if (creep.withdraw(ruin[0], RESOURCE_POWER) == ERR_NOT_IN_RANGE)
                    motion.newMove(creep, flagPos, 1)
                return
            }
            if (!creep.pos.inRangeTo(flagPos, 4))
                motion.newMove(creep, flagPos, 4)
            if (Game.time % 50 == 0){
                const powerBank = Game.rooms[flag.roomName].lookForAt(LOOK_STRUCTURES, flagPos)
                if (!powerBank.length)
                    delete Memory.flags[flagName]
            }
            return
        }
        if (Game.time % 50 == 0)
            creep.memory.flag = null
    },

    getControllerRunnersNeeded: function(spawn: StructureSpawn){
        const roomCache = u.getRoomCache(spawn.room.name)
        const controllerRunnersNeeded = u.getsetd(roomCache, "cRunners", [0, 0])
        if (Game.time > controllerRunnersNeeded[1]) {
            controllerRunnersNeeded[0] = rR.updateControllerRunnersNeeded(spawn)
            controllerRunnersNeeded[1] = Game.time + 36
        }
        return controllerRunnersNeeded[0]
    },

    updateControllerRunnersNeeded: function(spawn: StructureSpawn){
        const upgraders = _.filter(u.splitCreepsByCity()[spawn.name], c => c.memory.role == cN.UPGRADER_NAME).length
        const upgraderBody = types.getRecipe(cN.UPGRADER_NAME, spawn.room.energyCapacityAvailable, spawn.room)
        const totalWorks = upgraders * upgraderBody.filter(part => part == WORK).length

        const runnerBody = types.getRecipe(cN.RUNNER_NAME, spawn.room.energyCapacityAvailable, spawn.room)
        const runnerCarryCapacity = runnerBody.filter(part => part == CARRY).length * CARRY_CAPACITY

        const controllerPos = linkLib.getUpgradeLinkPos(spawn.room) || spawn.room.controller.pos

        const distance = PathFinder.search(spawn.pos, {pos: controllerPos, range: 2}, {swampCost: 1}).cost
        const energyNeeded = totalWorks * distance * 2

        return Math.ceil(energyNeeded/runnerCarryCapacity)
    }
    
}
export = rR
