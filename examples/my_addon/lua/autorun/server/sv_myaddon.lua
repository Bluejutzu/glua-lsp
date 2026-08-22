-- Serverside entry point.
--
-- Everything in this file is analysed as SERVER because of the
-- lua/autorun/server/ path. Try calling a clientside function like
-- surface.SetDrawColor here and watch the realm diagnostic appear.

AddCSLuaFile("myaddon/sh_config.lua")
include("myaddon/sh_config.lua")

util.AddNetworkString("MyAddon.TurretPlaced")

-- Cross-file: MyAddon.CanPlace comes from sh_config.lua.
-- Go to definition works, and so does find-all-references.
hook.Add("PlayerSpawnedProp", "MyAddon.TrackProps", function(ply, model, ent)
	-- ply is typed Player and ent is typed Entity, straight from the wiki's
	-- documented hook signature. Type `ply:` to see it.
	if not MyAddon.CanPlace(ply) then
		ent:Remove()
		return
	end

	ent:SetNWEntity("myaddon.owner", ply)
	MyAddon.NotifyCountChanged(#ents.FindByClass("prop_physics"))
end)

concommand.Add("myaddon_place", function(ply, cmd, args)
	-- These three parameters are typed from the wiki's <callback> block.
	if not MyAddon.CanPlace(ply) then
		ply:ChatPrint("You are not allowed to do that.")
		return
	end

	local turret = ents.Create("prop_physics")
	turret:SetModel("models/props_c17/oildrum001.mdl")
	turret:SetPos(ply:GetPos() + ply:GetAimVector() * 64)
	turret:Spawn()

	-- The payload written here is matched against the reads in cl_myaddon.lua.
	net.Start("MyAddon.TurretPlaced")
		net.WriteEntity(turret)
		net.WriteString(ply:Nick())
	net.Broadcast()
end)
