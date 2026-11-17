class_name Hand
extends XRController3D
## One controller: a laser that points at panels, clicks and drags with the
## trigger, scrolls with the stick, and carries a panel while the grip is held.
## While carrying, the stick pushes or pulls the panel (up/down) and resizes it
## (left/right). main.gd calls update() once a frame with the current panels.

signal pressed_on(panel: XrPanel)
signal released_grab(panel: XrPanel)

const ACCENT := Color("00ff41")
const PRESS := 0.7
const LET_GO := 0.35
## Wheel notches per second at full stick, and pixels per notch.
const NOTCH_RATE := 14.0
const NOTCH_PX := 100.0
const PUSH_SPEED := 1.5
const RESIZE_SPEED := 0.9

var hover: XrPanel
var grab: XrPanel

var _laser: MeshInstance3D
var _dot: MeshInstance3D
var _hover_px := Vector2()
var _down: XrPanel
var _down_px := Vector2()
var _last_sent := Vector2(-1, -1)
var _trigger := false
var _grip := false
var _wheel := 0.0
var _grab_offset := Transform3D()


func _ready() -> void:
	pose = &"aim"
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.albedo_color = Color(ACCENT, 0.55)
	var beam := BoxMesh.new()
	beam.size = Vector3(0.0025, 0.0025, 1.0)
	_laser = MeshInstance3D.new()
	_laser.mesh = beam
	_laser.material_override = mat
	_laser.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_laser)
	var dot_mat := StandardMaterial3D.new()
	dot_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	dot_mat.albedo_color = Color.WHITE
	var sphere := SphereMesh.new()
	sphere.radius = 0.006
	sphere.height = 0.012
	_dot = MeshInstance3D.new()
	_dot.mesh = sphere
	_dot.material_override = dot_mat
	_dot.top_level = true
	add_child(_dot)
	var grip_mesh := BoxMesh.new()
	grip_mesh.size = Vector3(0.03, 0.025, 0.09)
	var body := MeshInstance3D.new()
	body.mesh = grip_mesh
	var body_mat := StandardMaterial3D.new()
	body_mat.albedo_color = Color(0.08, 0.1, 0.09)
	body_mat.emission_enabled = true
	body_mat.emission = Color(ACCENT, 1.0) * 0.08
	body.material_override = body_mat
	body.position = Vector3(0, -0.01, 0.05)
	add_child(body)


func update(dt: float, panels: Array) -> void:
	if not get_has_tracking_data():
		_laser.visible = false
		_dot.visible = false
		return
	var from := global_position
	var dir := -global_basis.z
	var trig := get_float("trigger")
	var grip := get_float("grip")
	var stick := get_vector2("primary")

	if grab:
		_carry(dt, grip, stick)
		_draw_laser(-1.0)
		return

	var best: XrPanel = null
	var best_hit := Vector3()
	for p: XrPanel in panels:
		var h = p.hit(from, dir)
		if h != null and (best == null or h.z < best_hit.z):
			best = p
			best_hit = h
	if hover and hover != best and hover != _down:
		hover.hide_cursor()
	hover = best
	if best:
		_hover_px = Vector2(best_hit.x, best_hit.y)

	# Grip on a panel picks it up.
	var grip_now := grip > (LET_GO if _grip else PRESS)
	if grip_now and not _grip and best and not _down:
		_start_carry(best)
		_grip = true
		return
	_grip = grip_now

	# Trigger is the left mouse button.
	var trig_now := trig > (LET_GO if _trigger else PRESS)
	if trig_now and not _trigger and best:
		_down = best
		_down_px = _hover_px
		best.mouse("mouseMoved", _hover_px)
		best.mouse("mousePressed", _hover_px, "left", 1, 1)
		_last_sent = _hover_px
		pressed_on.emit(best)
		trigger_haptic_pulse("haptic", 0.0, 0.25, 0.02, 0.0)
	elif not trig_now and _trigger and _down:
		var px := _drag_px(from, dir)
		_down.mouse("mouseReleased", px, "left", 0, 1)
		_down = null
	_trigger = trig_now

	# Moves go to the panel under the laser, or during a drag to the one pressed.
	if _down:
		var px := _drag_px(from, dir)
		if px.distance_to(_last_sent) > 0.5:
			_down.mouse("mouseMoved", px, "left", 1)
			_last_sent = px
		_down.show_cursor(px)
	elif best:
		if _hover_px.distance_to(_last_sent) > 0.5:
			best.mouse("mouseMoved", _hover_px)
			_last_sent = _hover_px
		best.show_cursor(_hover_px)

	# Stick up and down scrolls whatever is under the laser.
	if best and not _down and absf(stick.y) > 0.25:
		_wheel += stick.y * NOTCH_RATE * dt
		while absf(_wheel) >= 1.0:
			var s := signf(_wheel)
			best.wheel(_hover_px, -NOTCH_PX * s)
			_wheel -= s
	else:
		_wheel = 0.0

	if best:
		_dot.visible = true
		_dot.global_position = best.point_at(_hover_px)
		_draw_laser(best_hit.z)
	else:
		_dot.visible = false
		_draw_laser(-1.0)


func _drag_px(from: Vector3, dir: Vector3) -> Vector2:
	var h = _down.hit(from, dir)
	if h != null:
		_down_px = Vector2(h.x, h.y)
	return _down_px


func _start_carry(p: XrPanel) -> void:
	grab = p
	_grab_offset = global_transform.affine_inverse() * p.global_transform
	p.hide_cursor()
	_dot.visible = false
	trigger_haptic_pulse("haptic", 0.0, 0.4, 0.04, 0.0)


func _carry(dt: float, grip: float, stick: Vector2) -> void:
	if grip < LET_GO:
		var p := grab
		grab = null
		_grip = false
		released_grab.emit(p)
		return
	if absf(stick.y) > 0.2:
		# Hand-local -Z is along the laser, so this pushes the panel away or pulls it in.
		var d := _grab_offset.origin.length()
		var nd := clampf(d + stick.y * PUSH_SPEED * dt, 0.25, 8.0)
		if d > 0.001:
			_grab_offset.origin *= nd / d
	if absf(stick.x) > 0.2:
		grab.set_width(grab.width * (1.0 + stick.x * RESIZE_SPEED * dt))
	var t := global_transform * _grab_offset
	# Keep it upright: follow the hand's pitch and yaw, never its roll.
	var fwd := t.basis.z.normalized()
	if absf(fwd.dot(Vector3.UP)) < 0.98:
		t.basis = Basis.looking_at(-fwd, Vector3.UP)
	grab.global_transform = t


func _draw_laser(length: float) -> void:
	_laser.visible = true
	var l := length if length > 0.0 else 3.0
	_laser.scale = Vector3(1, 1, l)
	_laser.position = Vector3(0, 0, -l * 0.5)
	(_laser.material_override as StandardMaterial3D).albedo_color = Color(ACCENT, 0.55 if length > 0.0 else 0.18)
