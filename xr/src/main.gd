extends Node3D
## Valkyrie XR: Claude sessions and Valkyrie pages as panels placed around you.
##
## Built for the Steam Frame, where it runs on the headset against SteamVR's
## OpenXR runtime. The panels are pages of the Valkyrie web app rendered by an
## offscreen Chromium that the launcher starts (frame/valkyrie-xr.sh), driven over
## the DevTools protocol (cdp.gd). Each panel is an OpenXR quad layer (panel.gd).
## Controllers point, click, scroll and carry panels (hand.gd); a keyboard types
## into the panel clicked last (keys.gd). The layout is saved and comes back.
##
## Controls: trigger clicks, grip carries (stick pushes/pulls and resizes while
## carrying), stick scrolls, A opens a new panel on AI > Sessions in front of you,
## B closes the panel the right laser is on, or with the laser on nothing brings
## every panel back in front of you. Every panel is a v2 page; opening a session
## in its own window (v2's pop-out) puts it on a new panel beside that one.
##
## Command line, after "--": --cdp-port=9233 --base=https://host
## --panels=punch|front|mesh --passthrough=on|off

const ACCENT := Color("00ff41")
const LAYOUT := "user://layout.json"
const MAX_PANELS := 8

var base_url := "http://100.96.237.89:8420"
var cdp_port := 9233
var panel_mode := "punch"
var passthrough := true

var xr: OpenXRInterface
var origin: XROrigin3D
var head: XRCamera3D
var cdp: Cdp
var hands: Array[Hand] = []
var panels: Array[XrPanel] = []
var focused: XrPanel

var _note: Label3D
var _placed := false
var _started_ms := 0
var _save_at := 0
var _a_down := false
var _b_down := false


func _ready() -> void:
	_read_args()
	_started_ms = Time.get_ticks_msec()
	var vp := get_viewport()
	xr = XRServer.find_interface("OpenXR") as OpenXRInterface
	if xr and xr.is_initialized():
		vp.use_xr = true
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
		var modes: Array = xr.get_supported_environment_blend_modes()
		print("[xr] blend modes %s, refresh %s of %s" % [modes, xr.get_display_refresh_rate(), xr.get_available_display_refresh_rates()])
		if passthrough and XRInterface.XR_ENV_BLEND_MODE_ALPHA_BLEND in modes:
			xr.environment_blend_mode = XRInterface.XR_ENV_BLEND_MODE_ALPHA_BLEND
			vp.transparent_bg = true
			print("[xr] passthrough on")
		xr.pose_recentered.connect(_on_recentered)
	else:
		print("[xr] OpenXR is not running, flat mode")
	print("[xr] base %s, cdp port %d, panels %s" % [base_url, cdp_port, panel_mode])

	_build_world(vp.transparent_bg)
	cdp = Cdp.new()
	cdp.port = cdp_port
	add_child(cdp)
	cdp.connected.connect(_on_cdp_connected)
	cdp.disconnected.connect(_on_cdp_disconnected)
	cdp.event.connect(_on_cdp_event)
	_say("starting the browser")


func _read_args() -> void:
	for a in OS.get_cmdline_user_args():
		var kv := a.trim_prefix("--").split("=", true, 1)
		if kv.size() != 2:
			continue
		match kv[0]:
			"cdp-port":
				cdp_port = int(kv[1])
			"base":
				base_url = kv[1].trim_suffix("/")
			"panels":
				panel_mode = kv[1]
			"passthrough":
				passthrough = kv[1] != "off"


func _build_world(see_through: bool) -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0, 0, 0, 0) if see_through else Color(0.01, 0.012, 0.012)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.6, 0.65, 0.62)
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)

	origin = XROrigin3D.new()
	add_child(origin)
	head = XRCamera3D.new()
	origin.add_child(head)
	for side in ["left_hand", "right_hand"]:
		var h := Hand.new()
		h.tracker = side
		h.pressed_on.connect(_on_pressed_on)
		h.released_grab.connect(func(_p): _save_soon())
		origin.add_child(h)
		hands.append(h)

	if not see_through:
		var floor_mesh := PlaneMesh.new()
		floor_mesh.size = Vector2(40, 40)
		var floor_mat := ShaderMaterial.new()
		floor_mat.shader = preload("res://src/grid.gdshader")
		var floor_node := MeshInstance3D.new()
		floor_node.mesh = floor_mesh
		floor_node.material_override = floor_mat
		add_child(floor_node)

	_note = Label3D.new()
	_note.font_size = 40
	_note.pixel_size = 0.0008
	_note.modulate = ACCENT
	_note.outline_size = 8
	_note.outline_modulate = Color(0, 0, 0, 0.8)
	_note.position = Vector3(0, -0.15, -0.9)
	_note.no_depth_test = true
	_note.visible = false
	head.add_child(_note)


func _process(dt: float) -> void:
	_track_session()
	# Wait until someone is looking: a first panel placed while the headset
	# sits on a desk lands wherever the desk is.
	var flat := not xr or not xr.is_initialized()
	if not _placed and ((_shown and _head_tracked()) or (flat and Time.get_ticks_msec() - _started_ms > 1000)):
		_placed = true
		_restore()
	if not _shown:
		return
	for h in hands:
		h.update(dt, panels)
	_buttons()
	if _save_at > 0 and Time.get_ticks_msec() >= _save_at:
		_save_at = 0
		_save()


func _head_tracked() -> bool:
	return head.global_position.y > 0.3


var _session_state := -1
var _shown := true

## Panels show only while the runtime shows the app. Godot 4.7.2 acquires a
## layer's swapchain image every frame but releases it only in frames it
## submits, so with the headset off (nothing submitted) it logs an error per
## panel per frame. A hidden layer is not acquired at all.
func _track_session() -> void:
	if not xr or not xr.is_initialized():
		return
	var st := xr.get_session_state()
	if st == _session_state:
		return
	_session_state = st
	var shown := st == OpenXRInterface.SESSION_STATE_VISIBLE or st == OpenXRInterface.SESSION_STATE_FOCUSED
	print("[xr] session state %d, panels %s" % [st, "shown" if shown else "hidden"])
	if shown != _shown:
		_shown = shown
		for p in panels:
			p.visible = shown


func _buttons() -> void:
	var right := hands[1]
	var a := right.is_button_pressed("ax_button")
	if a and not _a_down:
		new_panel()
	_a_down = a
	var b := right.is_button_pressed("by_button")
	if b and not _b_down:
		if right.hover:
			_close_panel(right.hover)
			trigger_haptic(right)
		else:
			_bring_all_here()
	_b_down = b


func _input(event: InputEvent) -> void:
	if not (event is InputEventKey) or not focused:
		return
	var ev := event as InputEventKey
	if ev.pressed and ev.ctrl_pressed and ev.shift_pressed and ev.physical_keycode == KEY_V:
		focused.insert_text(DisplayServer.clipboard_get())
		get_viewport().set_input_as_handled()
		return
	var p := Keys.to_cdp(ev)
	if not p.is_empty():
		focused.key(p)
		get_viewport().set_input_as_handled()


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_PREDELETE:
		if cdp and cdp.is_open:
			cdp.close_browser()


# ----------------------------------------------------------------- panels --

## Opens a new panel in front of the head: AI > Sessions, or the page in route.
func new_panel(route := "/m/ai/sessions") -> void:
	if panels.size() >= MAX_PANELS:
		_say("%d panels is the cap. Close one first." % MAX_PANELS, 3.0)
		return
	var p := _spawn({"route": route})
	_place_in_front(p, 1.2)
	_focus(p)
	_say("")
	_save_soon()


## adopt: the id of a tab that already exists (a pop-out), shown instead of a new one.
func _spawn(spec: Dictionary, adopt := "") -> XrPanel:
	var p := XrPanel.new()
	if not spec.is_empty():
		p.apply_spec(spec)
	p.setup(cdp, base_url, panel_mode)
	p.visible = _shown
	p.closed.connect(_close_panel)
	p.changed.connect(func(_p): _save_soon())
	origin.add_child(p)
	panels.append(p)
	if cdp.is_open:
		p.open_tab(adopt)
	return p


func _close_panel(p: XrPanel) -> void:
	p.close_tab()
	panels.erase(p)
	for h in hands:
		if h.grab == p:
			h.grab = null
		if h.hover == p:
			h.hover = null
	if focused == p:
		focused = null
	p.queue_free()
	if panels.is_empty():
		_say("no panels open. Press A for one.")
	_save_soon()


func _focus(p: XrPanel) -> void:
	if focused == p:
		return
	if focused:
		focused.focused = false
	focused = p
	p.focused = true


func _on_pressed_on(p: XrPanel) -> void:
	_focus(p)


func _place_in_front(p: XrPanel, dist: float) -> void:
	var fwd := -head.global_basis.z
	fwd.y = 0.0
	if fwd.length() < 0.01:
		fwd = Vector3.FORWARD
	fwd = fwd.normalized()
	var pos := head.global_position + fwd * dist
	if not _head_tracked():
		pos.y = 1.5
	p.global_transform = Transform3D(Basis.looking_at(fwd, Vector3.UP), pos)


## B: the whole arrangement moves in front of you at eye height, turned to
## face where you look, every panel keeping its place relative to the others.
func _bring_all_here() -> void:
	if panels.is_empty():
		return
	var center := Vector3.ZERO
	for p in panels:
		center += p.global_position
	center /= panels.size()
	# Which way the arrangement faces: the average of the panels' fronts.
	var facing := Vector3.ZERO
	for p in panels:
		facing += p.global_basis.z
	var look := -head.global_basis.z
	facing.y = 0.0
	look.y = 0.0
	if look.length() < 0.01:
		return
	look = look.normalized()
	var angle := 0.0
	if facing.length() > 0.01:
		angle = facing.signed_angle_to(-look, Vector3.UP)
	var turn := Basis(Vector3.UP, angle)
	var target := head.global_position + look * 1.3
	for p in panels:
		var t := p.global_transform
		t.origin = target + turn * (t.origin - center)
		t.basis = turn * t.basis
		p.global_transform = t
	trigger_haptic(hands[1])
	_save_soon()


func trigger_haptic(h: Hand) -> void:
	h.trigger_haptic_pulse("haptic", 0.0, 0.3, 0.05, 0.0)


func _on_recentered() -> void:
	print("[xr] recentered")


# ----------------------------------------------------------------- layout --

func _restore() -> void:
	var specs: Array = []
	if FileAccess.file_exists(LAYOUT):
		var data = JSON.parse_string(FileAccess.get_file_as_string(LAYOUT))
		if typeof(data) == TYPE_DICTIONARY:
			specs = data.get("panels", [])
	for s in specs:
		if typeof(s) == TYPE_DICTIONARY and panels.size() < MAX_PANELS:
			_spawn(s)
	print("[xr] restored %d panels" % panels.size())
	if panels.is_empty():
		new_panel("/m/dashboard")


func _save_soon() -> void:
	_save_at = Time.get_ticks_msec() + 500


func _save() -> void:
	var specs := []
	for p in panels:
		specs.append(p.spec())
	var f := FileAccess.open(LAYOUT, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify({"version": 1, "panels": specs}, "\t"))


# -------------------------------------------------------------------- cdp --

func _on_cdp_connected() -> void:
	_say("")
	# targetCreated for every new tab, which is how a pop-out from a panel is seen
	cdp.send("Target.setDiscoverTargets", {"discover": true})
	for p in panels:
		p.open_tab()


func _on_cdp_disconnected() -> void:
	for p in panels:
		p.lost()
	_say("lost the browser, reconnecting")


func _on_cdp_event(session: String, method: String, params: Dictionary) -> void:
	if session == "":
		_on_browser_event(method, params)
		return
	for p in panels:
		if p.session == session:
			p.on_event(method, params)
			return


## A page a panel opened with window.open (v2's pop-out window, kit/windows.ts)
## becomes a panel of its own beside that one; a panel whose page closed itself
## goes away.
func _on_browser_event(method: String, params: Dictionary) -> void:
	match method:
		"Target.targetCreated":
			var info: Dictionary = params.targetInfo
			var opener := str(info.get("openerId", ""))
			if info.get("type") != "page" or opener == "" or _panel_for(info.targetId):
				return
			var from := _panel_for(opener)
			if not from:
				return
			if panels.size() >= MAX_PANELS:
				cdp.send("Target.closeTarget", {"targetId": info.targetId})
				_say("%d panels is the cap. Close one first." % MAX_PANELS, 3.0)
				return
			var p := _spawn({"route": "/m/ai/sessions"}, info.targetId)
			var right := from.global_basis.x.normalized()
			p.global_transform = Transform3D(from.global_basis, from.global_position + right * (from.width + p.width) * 0.53)
			_focus(p)
			_save_soon()
		"Target.targetDestroyed":
			var p := _panel_for(str(params.targetId))
			if p:
				p.target_id = ""
				_close_panel(p)


func _panel_for(target_id: String) -> XrPanel:
	for p in panels:
		if p.target_id == target_id:
			return p
	return null


# ------------------------------------------------------------------- note --

var _note_until := 0

## A line of text under your gaze. secs > 0 hides it again after that long.
func _say(text: String, secs := 0.0) -> void:
	_note.text = text
	_note.visible = text != ""
	_note_until = Time.get_ticks_msec() + int(secs * 1000) if secs > 0 else 0
	if text != "":
		print("[xr] ", text)
	if secs > 0:
		get_tree().create_timer(secs).timeout.connect(_expire_note)


func _expire_note() -> void:
	if _note_until > 0 and Time.get_ticks_msec() >= _note_until:
		_note.visible = false
