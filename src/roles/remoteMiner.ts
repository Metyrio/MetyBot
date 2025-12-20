import a = require("../lib/actions")
import motion = require("../lib/motion")
import settings = require("../config/settings")
import { MoveStatus , cU } from "../lib/creepUtils"
import u = require("../lib/utils")
import { cN, BodyType } from "../lib/creepNames"
import roomU = require("../lib/roomUtils")

const rM = {
    name: cN.REMOTE_MINER_NAME,
    type: BodyType.miner,

    run: function(creep: Creep) {
        if(creep.spawning){
            return
        }
        rM.checkRespawn(creep)
        if (rM.retreat(creep)) return
        if (creep.memory.paired && !Game.getObjectById(creep.memory.paired))
            creep.memory.paired = null
        if (!creep.memory.source || !creep.memory.sourcePos) {
            rM.nextSource(creep)
            return
        }
        
        // Try to get source - may be null if room is not visible
        const source = Game.getObjectById(creep.memory.source) as Source
        
        // If source is null, it means we don't have vision of the room
        // Move towards sourcePos until we get vision
        if(!source){
            // Validate we have a valid sourcePos to move towards
            if(!creep.memory.sourcePos || !creep.memory.sourcePos.roomName){
                Log.error(`[remoteMiner] ${creep.name}: Missing sourcePos! Resetting...`)
                creep.memory.source = null
                creep.memory.sourcePos = null
                rM.nextSource(creep)
                return
            }
            
            // Move towards the source position
            const targetPos = new RoomPosition(
                creep.memory.sourcePos.x, 
                creep.memory.sourcePos.y, 
                creep.memory.sourcePos.roomName
            )
            motion.newMove(creep, targetPos, 1)
            return
        }
        
        cU.setMoveStatus(creep)
        rM.maybeMove(creep, source)
        if(creep.memory.construction && rM.build(creep, source))
            return
        if(creep.memory.link){
            const link = Game.getObjectById(creep.memory.link)
            if(link){
                if(source.energy > 0 && creep.store.getFreeCapacity() > 0)
                    creep.harvest(source)
                if(!creep.store.getFreeCapacity())
                    a.charge(creep, link)
                return
            } else {
                creep.memory.link = null
            }
        } else if(creep.memory.container){
            const container = Game.getObjectById(creep.memory.container)
            if(container){
                const containerHitsRatio = container.hits / container.hitsMax
                if(containerHitsRatio < 0.3 && creep.store.getUsedCapacity() > 0 && !creep.store.getFreeCapacity()){
                    creep.repair(container)
                } else if(source.energy > 0 && (container.store.getFreeCapacity() > 0 || creep.store.getFreeCapacity() > 0)){
                    creep.harvest(source)
                } else if (containerHitsRatio < 0.9 && creep.store.getUsedCapacity() > 0){
                    creep.repair(container)
                }
            } else {
                creep.memory.container = null
            }
        } else if(source.energy > 0){
            creep.harvest(source)
        }
        if(Game.time % settings.minerUpdateTime == 0){
            if(creep.pos.isNearTo(source.pos) && !creep.memory.spawnBuffer){
                creep.memory.spawnBuffer = PathFinder.search(Game.spawns[creep.memory.city].pos, source.pos).cost
            }
            //update container/link status
            //if we have a link no need to search
            if(creep.memory.link && Game.getObjectById(creep.memory.link))
                return
            //get Destination assigns structures/sites anyway so might as well reuse
            rM.getDestination(creep, source)
            if(!creep.memory.link && !creep.memory.container && !creep.memory.construction && creep.body.length > 5)
                rM.placeContainer(creep, source)
        }
    },

    checkRespawn: function(creep: Creep) {
        if(creep.ticksToLive == creep.memory.spawnBuffer + (creep.body.length * CREEP_SPAWN_TIME)) {
            const spawn = Game.spawns[creep.memory.city]
            const creeps = u.splitCreepsByCity()[creep.memory.city]

            // 2 creeps needed, because one is still alive
            cU.scheduleIfNeeded(cN.REMOTE_MINER_NAME, 2, false, spawn, creeps, creep.memory.flag)
        }
    },

    retreat: function(creep: Creep){
        // Throttle awareness check to every 10 ticks unless damaged
        if (creep.memory.aware || creep.hits < creep.hitsMax || Game.time % 10 == 9) {
            creep.memory.aware = true
            
            // Cache hostile check in Tmp
            const roomName = creep.room.name
            if (!Tmp[roomName]) {
                Tmp[roomName] = {}
            }
            if (!Tmp[roomName].hostileCheck || Game.time % 5 == 0) {
                const allHostiles = u.findHostileCreeps(creep.room)
                Tmp[roomName].nearHostiles = []
                for (const hostile of allHostiles) {
                    if (hostile.pos.getRangeTo(creep.pos) < 15) {
                        Tmp[roomName].nearHostiles.push(hostile)
                    }
                }
                Tmp[roomName].hostileCheck = Game.time
            }
            const hostiles = Tmp[roomName].nearHostiles || []
            
            // Cache lair check
            if (!Tmp[roomName].lairCheck || Game.time % 10 == 0) {
                const structures = creep.room.find(FIND_HOSTILE_STRUCTURES)
                let foundLair = null
                for (const s of structures) {
                    if (s.structureType == STRUCTURE_KEEPER_LAIR && s.pos.getRangeTo(creep.pos) < 10) {
                        foundLair = s as StructureKeeperLair
                        break
                    }
                }
                Tmp[roomName].dangerLair = foundLair
                Tmp[roomName].lairCheck = Game.time
            }
            const lair = Tmp[roomName].dangerLair as StructureKeeperLair | null | false
            const dangerousLair = lair && typeof lair !== "boolean" && lair.ticksToSpawn < 20
            
            //lose awareness if no hostiles or lairs
            if(hostiles.length == 0 && !dangerousLair && creep.hits == creep.hitsMax){
                creep.memory.aware = false
            } else if (creep.pos.roomName == Game.spawns[creep.memory.city].pos.roomName) {
                Game.spawns[creep.memory.city].memory.towersActive = true
            }
            // if creep has an enemy within 5 spaces, retreat
            const enemies = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 5) as Array<Creep | Structure>
            if(dangerousLair && lair && typeof lair !== "boolean") {
                enemies.push(lair)
            }
            if(enemies.length > 0){
                motion.retreat(creep, enemies)
                return true
            }
        }
        return false
    },

    placeContainer: function(creep, source){
        const spawn = Game.spawns[creep.memory.city]
        
        // Validate source exists in spawn memory
        if(!spawn.memory.sources[source.id]){
            Log.error(`[remoteMiner] placeContainer: Source ${source.id} not in spawn memory for ${spawn.name}`)
            return
        }
        
        if(spawn.room.energyCapacityAvailable < 800 || Math.random() < 0.95)
            return
        if(spawn.memory.sources[source.id][STRUCTURE_CONTAINER + "Pos"]){
            const pos = spawn.memory.sources[source.id][STRUCTURE_CONTAINER + "Pos"]
            source.room.createConstructionSite(Math.floor(pos/50), pos%50, STRUCTURE_CONTAINER)
            return
        }
        if(creep.memory.miningPos || creep.memory.destination){
            const pos = creep.memory.miningPos || creep.memory.destination
            if(creep.pos.isEqualTo(new RoomPosition(pos.x, pos.y, pos.roomName))){
                spawn.memory.sources[source.id][STRUCTURE_CONTAINER + "Pos"] = creep.pos.x * 50 + creep.pos.y
                creep.pos.createConstructionSite(STRUCTURE_CONTAINER)
            }
        }
    },

    build: function (creep, source){
        const cSite = Game.getObjectById(creep.memory.construction)
        if(!cSite){
            creep.memory.construction = null
            return false
        }
        if(creep.store.getUsedCapacity() > creep.store.getCapacity() * 0.5){
            creep.build(cSite)
        } else {
            creep.harvest(source)
        }
        return true
    },

    maybeMove: function(creep: Creep, source: Source){
        if(creep.memory.moveStatus == MoveStatus.STATIC){
            // STATIC miners (no MOVE parts) request pull from runners
            // For STATIC miners, we need destination set for the tug system
            if(!creep.memory.destination){
                // Try to get destination from source if we have vision
                if(source){
                    const dest = rM.getDestination(creep, source)
                    if(dest){
                        creep.memory.destination = dest
                        return
                    }
                }
                
                // If no source (no vision), try to calculate from spawn memory
                const spawn = Game.spawns[creep.memory.city]
                if(spawn && spawn.memory.sources && creep.memory.source){
                    const sourceMemory = spawn.memory.sources[creep.memory.source]
                    if(sourceMemory){
                        const containerPos = sourceMemory[STRUCTURE_CONTAINER + "Pos"]
                        if(containerPos){
                            creep.memory.destination = new RoomPosition(
                                Math.floor(containerPos/50), 
                                containerPos%50, 
                                creep.memory.sourcePos.roomName
                            )
                            return
                        }
                        // No container yet - use sourcePos as destination
                        if(creep.memory.sourcePos){
                            creep.memory.destination = new RoomPosition(
                                creep.memory.sourcePos.x,
                                creep.memory.sourcePos.y,
                                creep.memory.sourcePos.roomName
                            )
                            return
                        }
                    }
                }
            }
            
            // Static miner waits for runner to pull them to destination
            // No movement code here - runner.ts handles the tug
            return
        }
        
        // MOBILE miners (with MOVE parts) move themselves
        if(!source){
            // No vision - move towards sourcePos
            if(!creep.memory.sourcePos || !creep.memory.sourcePos.roomName){
                Log.error(`[remoteMiner] ${creep.name}: Invalid sourcePos for mobile miner!`)
                return
            }
            motion.newMove(creep, new RoomPosition(
                creep.memory.sourcePos.x, 
                creep.memory.sourcePos.y, 
                creep.memory.sourcePos.roomName
            ), 1)
            return
        }
        
        // We have vision of source - move to mining position
        if(!creep.memory.miningPos){
            creep.memory.miningPos = rM.getDestination(creep, source)
            if(!creep.memory.miningPos)
                return
        }
        const miningPos = new RoomPosition(creep.memory.miningPos.x, creep.memory.miningPos.y, creep.memory.miningPos.roomName)
        if(!creep.pos.isEqualTo(miningPos))
            motion.newMove(creep, miningPos)
    },

    getLinkMiningPos: function(link, source){
        // Unroll nested loop for better performance
        const offsets = [
            [-1, -1], [0, -1], [1, -1],
            [-1, 0], [0, 0], [1, 0],
            [-1, 1], [0, 1], [1, 1]
        ]
        
        for (const offset of offsets) {
            const testPos = new RoomPosition(link.pos.x + offset[0], link.pos.y + offset[1], link.pos.roomName)
            if(testPos.isNearTo(source) && !rM.isPositionBlockedMiner(testPos))
                return testPos
        }
        return null
    },

    getDestination: function(creep, source) {
        //look for links
        const link = rM.findStruct(creep, source, STRUCTURE_LINK)
        if(link){
            creep.memory.link = link.id
            return rM.getLinkMiningPos(link, source)
        }
        const linkSite = rM.findStruct(creep, source, STRUCTURE_LINK, true)
        if(linkSite){
            creep.memory.construction = linkSite.id
            return rM.getLinkMiningPos(linkSite, source)
        }
        //look for containers
        const container = rM.findStruct(creep, source, STRUCTURE_CONTAINER)
        if(container){
            creep.memory.container = container.id
            return container.pos
        }
        const containerSite = rM.findStruct(creep, source, STRUCTURE_CONTAINER, true)
        if(containerSite){
            creep.memory.construction = containerSite.id
            return containerSite.pos
        }
        //look for empty space to mine - unroll loop
        const offsets = [
            [-1, -1], [0, -1], [1, -1],
            [-1, 0], [0, 0], [1, 0],
            [-1, 1], [0, 1], [1, 1]
        ]
        
        for (const offset of offsets) {
            const testPos = new RoomPosition(source.pos.x + offset[0], source.pos.y + offset[1], source.pos.roomName)
            if(!rM.isPositionBlockedMiner(testPos))
                return testPos
        }
    },

    findStruct: function(creep: Creep, source: Source, structureType, construction = false){
        const type = construction ? LOOK_CONSTRUCTION_SITES : LOOK_STRUCTURES
        const memory = Game.spawns[creep.memory.city].memory
        
        // Validate source exists in memory
        if(!memory.sources[source.id]){
            return null
        }
        
        const structPos = memory.sources[source.id][structureType + "Pos"]
        if(structPos){
            const realPos = new RoomPosition(Math.floor(structPos/50), structPos%50, source.pos.roomName)
            const look = realPos.lookFor(type)
            // Use simple loop instead of _.find
            for (const struct of look) {
                if (struct.structureType == structureType && (!("owner" in struct) || struct.my)) {
                    return struct
                }
            }
        }
        return null
    },

    isPositionBlockedMiner: function(roomPos: RoomPosition){
        const look = roomPos.look()
        for(const lookObject of look){
            if((lookObject.type == LOOK_TERRAIN 
                && lookObject[LOOK_TERRAIN] == "wall")
                || (lookObject.type == LOOK_STRUCTURES
                && OBSTACLE_OBJECT_TYPES[lookObject[LOOK_STRUCTURES].structureType])
                || (lookObject.type == LOOK_CREEPS
                    && (!lookObject[LOOK_CREEPS].my 
                        || (lookObject[LOOK_CREEPS].memory.role == cN.REMOTE_MINER_NAME) && lookObject[LOOK_CREEPS].ticksToLive > 100))) {
                return true
            }
        }
        return false
    },

    canCarry: function(creep){
        return creep.getActiveBodyparts(CARRY) > 0
    },

    harvestTarget: function(creep: Creep) {
        const source = Game.getObjectById(creep.memory.source)
        if(!creep.pos.inRangeTo(source, 2)){
            motion.newMove(creep, source.pos, 2)
            return
        }
        if (creep.body.length === 15 && creep.pos.isNearTo(source) && Game.time % 2 === 0) {
            return
        }

        if(a.harvest(creep, source) === 1 && !creep.memory.spawnBuffer){
            creep.memory.spawnBuffer = PathFinder.search(Game.spawns[creep.memory.city].pos, source.pos).cost
        }
    },

    /** pick a target id for creep **/
    nextSource: function(creep: Creep) {
        if(creep.memory.flag){
            const spawn = Game.spawns[creep.memory.city]
            if(!spawn){
                Log.error(`[remoteMiner] ${creep.name}: Spawn ${creep.memory.city} not found! Suiciding...`)
                creep.suicide()
                return
            }
            roomU.initializeSources(spawn)
            
            // Validate source exists in spawn memory
            const sourceId = creep.memory.flag as Id<Source>
            if(!spawn.memory.sources[sourceId]){
                Log.error(`[remoteMiner] ${creep.name}: Source ${sourceId} not in spawn memory! Suiciding...`)
                creep.suicide()
                return
            }
            
            // Validate sourcePos is a valid RoomPosition
            const sourcePos = spawn.memory.sources[sourceId]
            if(!sourcePos || typeof sourcePos !== "object" || !sourcePos.roomName || sourcePos.x === undefined || sourcePos.y === undefined){
                Log.error(`[remoteMiner] ${creep.name}: Invalid sourcePos for ${sourceId} in ${spawn.name}! Suiciding...`)
                delete spawn.memory.sources[sourceId]
                creep.suicide()
                return
            }
            
            creep.memory.source = sourceId
            creep.memory.sourcePos = sourcePos
        } else {
            Log.error(`[remoteMiner] ${creep.name}: No flag assignment! Suiciding...`)
            creep.suicide()
        }
    }
}
export = rM
