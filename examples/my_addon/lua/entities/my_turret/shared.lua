-- Entity definitions get the ENT hook table.
--
-- Type `function ENT:` and the completion list is the documented ENTITY hooks,
-- inserted as a full stub. Inside any of them, `self` is an Entity.

ENT.Type = "anim"
ENT.Base = "base_gmodentity"
ENT.PrintName = "Example Turret"
ENT.Author = "GLua LSP"
ENT.Spawnable = true
ENT.Category = "MyAddon"

function ENT:SetupDataTables()
	self:NetworkVar("Int", 0, "Ammo")
	self:NetworkVar("Entity", 0, "Owner")
end

function ENT:Initialize()
	if SERVER then
		self:SetModel("models/props_c17/oildrum001.mdl")
		self:PhysicsInit(SOLID_VPHYSICS)
		self:SetMoveType(MOVETYPE_VPHYSICS)
		self:SetSolid(SOLID_VPHYSICS)
		self:SetAmmo(50)

		local physics = self:GetPhysicsObject()
		if IsValid(physics) then
			physics:Wake()
		end
	end
end
