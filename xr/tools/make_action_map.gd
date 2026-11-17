extends SceneTree
# Writes res://openxr_action_map.tres: Godot's default map plus the Steam Frame and
# Index profiles, which the 4.7.2 default map leaves out. SteamVR's vrclient knows
# the Frame controller as both valve/frame_controller and valve/frame_controller_valve,
# so both get the same bindings; the runtime rejects whichever it does not take.
# On the Frame controller A, B, X and Y are all on the right hand and the left has a d-pad.
# Run headless: godot --headless --script res://tools/make_action_map.gd

const BOTH := ["/user/hand/left", "/user/hand/right"]
const RIGHT := ["/user/hand/right"]
const LEFT := ["/user/hand/left"]

const FRAME := [
	["trigger", BOTH, "/input/trigger/value"],
	["trigger_click", BOTH, "/input/trigger/click"],
	["trigger_touch", BOTH, "/input/trigger/touch"],
	["grip", BOTH, "/input/squeeze/value"],
	["grip_click", BOTH, "/input/squeeze/click"],
	["primary", BOTH, "/input/thumbstick"],
	["primary_click", BOTH, "/input/thumbstick/click"],
	["primary_touch", BOTH, "/input/thumbstick/touch"],
	["ax_button", RIGHT, "/input/a/click"],
	["by_button", RIGHT, "/input/b/click"],
	["menu_button", RIGHT, "/input/menu/click"],
	["menu_button", LEFT, "/input/view/click"],
	["default_pose", BOTH, "/input/grip/pose"],
	["aim_pose", BOTH, "/input/aim/pose"],
	["grip_pose", BOTH, "/input/grip/pose"],
	["haptic", BOTH, "/output/haptic"],
]

const INDEX := [
	["trigger", BOTH, "/input/trigger/value"],
	["trigger_click", BOTH, "/input/trigger/click"],
	["trigger_touch", BOTH, "/input/trigger/touch"],
	["grip", BOTH, "/input/squeeze/value"],
	["primary", BOTH, "/input/thumbstick"],
	["primary_click", BOTH, "/input/thumbstick/click"],
	["primary_touch", BOTH, "/input/thumbstick/touch"],
	["ax_button", BOTH, "/input/a/click"],
	["by_button", BOTH, "/input/b/click"],
	["default_pose", BOTH, "/input/grip/pose"],
	["aim_pose", BOTH, "/input/aim/pose"],
	["grip_pose", BOTH, "/input/grip/pose"],
	["haptic", BOTH, "/output/haptic"],
]

var map: OpenXRActionMap


func _init():
	map = OpenXRActionMap.new()
	map.create_default_action_sets()
	_add_profile("/interaction_profiles/valve/frame_controller", FRAME)
	_add_profile("/interaction_profiles/valve/frame_controller_valve", FRAME)
	_add_profile("/interaction_profiles/valve/index_controller", INDEX)
	var err := ResourceSaver.save(map, "res://openxr_action_map.tres")
	print("SAVED openxr_action_map.tres err=", err)
	for p in map.interaction_profiles:
		print("PROFILE ", p.interaction_profile_path, " bindings=", p.get_binding_count())
	quit(0 if err == OK else 1)


func _add_profile(path: String, rows: Array) -> void:
	for existing in map.interaction_profiles:
		if existing.interaction_profile_path == path:
			map.remove_interaction_profile(existing)
			break
	var profile := OpenXRInteractionProfile.new()
	profile.interaction_profile_path = path
	var bindings := []
	for row in rows:
		var action := _action(row[0])
		if action == null:
			push_error("missing action " + row[0])
			continue
		for hand in row[1]:
			var binding := OpenXRIPBinding.new()
			binding.action = action
			binding.binding_path = hand + row[2]
			bindings.append(binding)
	profile.bindings = bindings
	map.add_interaction_profile(profile)


func _action(action_name: String) -> OpenXRAction:
	for s in map.action_sets:
		if s.resource_name != "godot":
			continue
		for a in s.actions:
			if a.resource_name == action_name:
				return a
	return null
