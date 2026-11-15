-- To require this file, use util.require_natives("9999z.g")
-- Note that any given version of the natives library may not be compatible with any given script.

-- SYSTEM
	-- Pauses execution of the current script.
	WAIT=--[[void]] function(--[[int]] ms)return native_invoker.unified_void(ms, 0x4EDE34FBADD967A6, "i")end
-- ENTITY
	-- Returns true if the entity exists.
	DOES_ENTITY_EXIST=--[[BOOL (bool)]] function(--[[Entity (int)]] entity)return native_invoker.unified_bool(entity, 0x7239B21A38F536BA, "i")end
	SET_ENTITY_COORDS=--[[void]] function(--[[Entity (int)]] entity,--[[float]] xPos,--[[float]] yPos,--[[float]] zPos,--[[BOOL (bool)]] xAxis,--[[BOOL (bool)]] yAxis,--[[BOOL (bool)]] zAxis,--[[BOOL (bool)]] clearArea)return native_invoker.unified_void(entity, xPos, yPos, zPos, xAxis, yAxis, zAxis, clearArea, 0x06843DA7060A026B, "ifffbbbb")end
-- PED
	-- https://alloc8or.re/gta5/doc/enums/ePedType.txt
	CREATE_PED=--[[Ped (int)]] function(--[[int]] pedType,--[[Hash (int)]] modelHash,--[[float]] x,--[[float]] y,--[[float]] z,--[[float]] heading,--[[BOOL (bool)]] isNetwork,--[[BOOL (bool)]] bScriptHostPed)return native_invoker.unified_int(pedType, modelHash, x, y, z, heading, isNetwork, bScriptHostPed, 0xD49F9B0955C367DE, "iiffffbb")end
	GET_PED_BONE_COORDS=--[[Vector3 (vector3)]] function(--[[Ped (int)]] ped,--[[int]] boneId,--[[Any* (pointer)]] offsetX)return native_invoker.unified_vector3(ped, boneId, offsetX, 0x17C07FC640E86B4E, "iip")end
	G_ONLY_NATIVE=--[[int]] function()return native_invoker.unified_int(0x1111111111111111, "")end
