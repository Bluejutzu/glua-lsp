--- Shared configuration for the example addon.
--- Hover any of these from another file to see the doc comment travel with it.
MyAddon = MyAddon or {}

MyAddon.Version = "1.0.0"
MyAddon.MaxTurrets = 8

--- Returns true when the player is allowed to place a turret.
---@param ply Player the player attempting to place one
---@return boolean
function MyAddon.CanPlace(ply)
	-- The @param above is what makes `ply:` complete Player methods below.
	if not IsValid(ply) then return false end
	return ply:IsAdmin() or ply:GetNWBool("myaddon.trusted", false)
end

--- Fired whenever the turret count changes, so other addons can react.
---@param count number
function MyAddon.NotifyCountChanged(count)
	hook.Run("MyAddon.TurretCountChanged", count)
end

--- No annotation on this one on purpose: `ent` is inferred as an Entity from
--- the methods called on it, and `owner` as a Player from IsAdmin.
function MyAddon.DescribeTurret(ent, owner)
	if not IsValid(ent) then return "" end

	return string.format(
		"%s at %s, owned by %s",
		ent:GetClass(),
		tostring(ent:GetPos()),
		owner:IsAdmin() and "an admin" or owner:Nick()
	)
end
