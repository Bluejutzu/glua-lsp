-- Clientside entry point.
--
-- Analysed as CLIENT because of the lua/autorun/client/ path.

include("myaddon/sh_config.lua")

local turretCount = 0

-- The reads below are checked against the writes in sv_myaddon.lua. Delete the
-- net.ReadString call and a payload-mismatch diagnostic appears here.
net.Receive("MyAddon.TurretPlaced", function(len)
	local turret = net.ReadEntity()
	local owner = net.ReadString()

	if not IsValid(turret) then return end
	chat.AddText(Color(120, 200, 255), owner, color_white, " placed a turret.")
end)

hook.Add("MyAddon.TurretCountChanged", "MyAddon.UpdateHUD", function(count)
	-- A custom hook: not on the wiki, but sh_config.lua fires it with
	-- hook.Run, so it is recognised rather than reported as a typo.
	turretCount = count
end)

hook.Add("HUDPaint", "MyAddon.DrawCounter", function()
	if turretCount <= 0 then return end

	local text = string.format("Turrets: %d / %d", turretCount, MyAddon.MaxTurrets)
	surface.SetFont("DermaLarge")
	local w, h = surface.GetTextSize(text)

	surface.SetDrawColor(0, 0, 0, 180)
	surface.DrawRect(16, 16, w + 16, h + 8)

	draw.SimpleText(text, "DermaLarge", 24, 20, color_white)
end)

concommand.Add("myaddon_menu", function()
	local frame = vgui.Create("DFrame")
	-- frame is typed DFrame, so DFrame methods and inherited Panel methods
	-- both complete here.
	frame:SetSize(400, 300)
	frame:SetTitle("MyAddon " .. MyAddon.Version)
	frame:Center()
	frame:MakePopup()

	local list = frame:Add("DListView")
	list:Dock(FILL)
	list:AddColumn("Turret")
end)