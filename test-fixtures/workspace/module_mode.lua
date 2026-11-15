local natives = util.require_natives('9999z')

local ped = natives.PED.CREATE_PED(4, 0, 1.0, 2.0, 3.0, 0.0, false, true)
ENTITY.SET_ENTITY_COORDS(ped, 1.0, 2.0, 3.0, false, false, false, true)
INIT_ONLY_NATIVE = PED.INIT_ONLY_NATIVE()
