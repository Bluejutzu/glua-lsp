-- Every line below is wrong on purpose. Open this file with the extension
-- running to see what each diagnostic looks like; nothing here is meant to be
-- copied. Delete this file in a real addon.

include("myaddon/sh_config.lua")

-- 1. A hook name that does not exist. GMod fires PlayerSpawn, not PlayerSpawned,
--    so this callback silently never runs. Quick fix offers the near matches.
hook.Add("PlayerSpawned", "typo.example", function(ply)
	ply:SetHealth(100)
end)

-- 2. A serverside-only call in a file that also runs clientside.
--    Guard it, or move it into a server file.
if not CLIENT then
	-- (this branch is fine: the realm narrows to server here)
	game.CleanUpMap()
end

-- 3. Wrong argument type. SetActiveWeapon wants the Weapon entity, not its class.
hook.Add("PlayerSpawn", "wrongtype.example", function(ply)
	ply:SetActiveWeapon("weapon_pistol")
end)

-- 4. Missing a required argument.
hook.Add("PlayerSay", "argcount.example", function(sender)
	sender:ChatPrint()
end)

-- 5. A deprecated API. Hover shows what replaced it.
hook.Add("PlayerInitialSpawn", "deprecated.example", function(ply)
	print(ply:Name())
end)

-- 6. A net message that is never registered, never received, and never sent.
net.Start("nobody_registered_this")
net.Broadcast()

-- 7. Compound assignment, which is not valid Lua. Quick fix rewrites it.
local counter = 0
counter += 1

-- 8. A local that is never read.
local unusedValue = MyAddon.Version

-- 9. Expensive work on a path the engine runs every frame. The material is
--    looked up by name on every call, and the entity sweep walks the whole map.
--    Both are reported at the call, with the chain that reaches them.
hook.Add("HUDPaint", "hotpath.example", function()
	surface.SetMaterial(Material("icon16/cog.png"))
	for _, turret in ipairs(ents.FindByClass("my_turret")) do
		surface.DrawRect(0, 0, 4, 4)
	end
end)
