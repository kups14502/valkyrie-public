class_name XrPanel
extends OpenXRCompositionLayerQuad
## One floating screen: a page of the Valkyrie web app in its own offscreen tab.
##
## The tab's screencast frames land in a texture inside a SubViewport, and the
## viewport feeds an OpenXR quad layer. The runtime composites a quad layer itself,
## so text is sampled once instead of twice and stays sharper than it would on a
## mesh. The page is /xr in the web app (frontend/src/pages/Xr.tsx), which shows
## a terminal, a page, or the picker that chooses one.
##
## Must be a direct child of the XROrigin3D: the layer pose is the local transform.

signal closed(panel: XrPanel)
signal changed(panel: XrPanel)

const ACCENT := Color("00ff41")

## Path and query inside the web app, for example /xr?s=vk-ab12.
var route := "/xr"
## The page's CSS viewport and device scale. The texture is css * dpr pixels.
var css := Vector2i(1280, 800)
var dpr := 1.0
## Width in meters. Height follows the aspect of css.
var width := 1.2
var focused := false:
	set(v):
		focused = v
		if _border:
			_border.queue_redraw()

var cdp: Cdp
var base_url := ""
var session := ""
var target_id := ""

var _frame_id := ""
var _view: SubViewport
var _rect: TextureRect
var _tex: ImageTexture
var _cursor: Cursor
var _border: Border
var _mesh: MeshInstance3D
var _opening := false
var _frames := 0


class Cursor:
	extends Control
	var at := Vector2(-100, -100)
	var scale_px := 1.0

	func _draw() -> void:
		if at.x < 0:
			return
		var p := at * scale_px
		draw_arc(p, 9.0 * scale_px, 0.0, TAU, 32, Color(0, 0, 0, 0.6), 4.0 * scale_px, true)
		draw_arc(p, 9.0 * scale_px, 0.0, TAU, 32, Color(1, 1, 1, 0.95), 2.0 * scale_px, true)
		draw_circle(p, 2.5 * scale_px, ACCENT)


class Border:
	extends Control
	var panel: XrPanel

	func _draw() -> void:
		var c := ACCENT if panel.focused else Color(ACCENT, 0.18)
		draw_rect(Rect2(Vector2.ZERO, size), c, false, 3.0 if panel.focused else 2.0)


## mode: "punch" puts the layer behind the scene and cuts a hole for it, so the
## laser and cursor dot draw over it. "front" puts it over everything. "mesh"
## skips the layer and draws a textured quad, the fallback if layers misbehave.
func setup(p_cdp: Cdp, p_base: String, mode: String) -> void:
	cdp = p_cdp
	base_url = p_base
	_view = SubViewport.new()
	_view.disable_3d = true
	_view.transparent_bg = false
	_view.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	add_child(_view)
	var bg := ColorRect.new()
	bg.color = Color.BLACK
	_view.add_child(bg)
	_rect = TextureRect.new()
	_rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_rect.stretch_mode = TextureRect.STRETCH_SCALE
	_rect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_view.add_child(_rect)
	_border = Border.new()
	_border.panel = self
	_view.add_child(_border)
	_cursor = Cursor.new()
	_view.add_child(_cursor)
	for c in [bg, _rect, _border, _cursor]:
		c.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_resize_view()

	if mode == "mesh":
		_mesh = MeshInstance3D.new()
		_mesh.mesh = QuadMesh.new()
		var mat := StandardMaterial3D.new()
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		mat.albedo_texture = _view.get_texture()
		mat.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR
		_mesh.material_override = mat
		add_child(_mesh)
	else:
		layer_viewport = _view
		if mode == "punch":
			sort_order = -1
			enable_hole_punch = true
		else:
			sort_order = 1
	set_width(width)


func set_width(w: float) -> void:
	width = clampf(w, 0.3, 5.0)
	quad_size = Vector2(width, width * css.y / css.x)
	if _mesh:
		(_mesh.mesh as QuadMesh).size = quad_size


func spec() -> Dictionary:
	return {"route": route, "css": [css.x, css.y], "dpr": dpr, "width": width, "transform": var_to_str(transform)}


func apply_spec(s: Dictionary) -> void:
	route = str(s.get("route", "/xr"))
	var c: Array = s.get("css", [1280, 800])
	css = Vector2i(int(c[0]), int(c[1]))
	dpr = float(s.get("dpr", 1.0))
	width = float(s.get("width", 1.2))
	var t = str_to_var(str(s.get("transform", "")))
	if t is Transform3D:
		transform = t


## The URL the tab opens. "/" is the one path every Valkyrie host serves, and
## RootRedirect in App.tsx routes ?go= from there and keeps the other parameters.
func url() -> String:
	var path := route
	var query := ""
	var q := route.find("?")
	if q >= 0:
		path = route.substr(0, q)
		query = route.substr(q + 1)
	var u := base_url + "/?go=" + path
	if query != "":
		u += "&" + query
	return u


func open_tab() -> void:
	if _opening or not cdp.is_open:
		return
	_opening = true
	session = ""
	var r := await cdp.request("Target.createTarget", {"url": "about:blank"})
	if r.has("error"):
		_opening = false
		return
	target_id = r.result.targetId
	r = await cdp.request("Target.attachToTarget", {"targetId": target_id, "flatten": true})
	if r.has("error"):
		_opening = false
		return
	session = r.result.sessionId
	cdp.send("Page.enable", {}, session)
	cdp.send("Runtime.enable", {}, session)
	cdp.send("Runtime.addBinding", {"name": "valkyrieXr"}, session)
	cdp.send("Emulation.setDeviceMetricsOverride", {
		"width": css.x, "height": css.y, "deviceScaleFactor": dpr, "mobile": false,
	}, session)
	cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": true}, session)
	cdp.send("Emulation.setScrollbarsHidden", {"hidden": true}, session)
	cdp.send("Page.navigate", {"url": url()}, session)
	cdp.send("Page.startScreencast", {
		"format": "png", "everyNthFrame": 1, "maxWidth": _view.size.x, "maxHeight": _view.size.y,
	}, session)
	_opening = false
	print("[panel] opened ", route, " in ", target_id.substr(0, 8))


func close_tab() -> void:
	if target_id != "" and cdp.is_open:
		cdp.send("Target.closeTarget", {"targetId": target_id})
	target_id = ""
	session = ""


## The browser went away; the next connection opens a new tab.
func lost() -> void:
	target_id = ""
	session = ""
	_opening = false


func on_event(method: String, params: Dictionary) -> void:
	match method:
		"Page.screencastFrame":
			cdp.send("Page.screencastFrameAck", {"sessionId": int(params.sessionId)}, session)
			var img: Image = params.get("image")
			if img:
				_show(img)
		"Page.frameNavigated":
			var f: Dictionary = params.frame
			if not f.has("parentId"):
				_frame_id = f.id
				_route_from(f.url + str(f.get("urlFragment", "")))
		"Page.navigatedWithinDocument":
			if params.frameId == _frame_id:
				_route_from(params.url)
		"Runtime.bindingCalled":
			if params.name == "valkyrieXr":
				_on_page_message(str(params.payload))
		"Runtime.exceptionThrown":
			var d: Dictionary = params.exceptionDetails
			print("[page %s] exception: %s" % [route, d.get("exception", {}).get("description", d.get("text", "?"))])
		"Runtime.consoleAPICalled":
			if params.type == "error" or params.type == "warning":
				var parts := []
				for a in params.args:
					parts.append(str(a.get("value", a.get("description", ""))))
				print("[page %s] %s: %s" % [route, params.type, " ".join(parts)])
		"Inspector.targetCrashed":
			print("[panel] tab crashed, reopening ", route)
			lost()
			open_tab()


func _show(img: Image) -> void:
	_frames += 1
	if _tex and _tex.get_size() == Vector2(img.get_size()) and _tex.get_format() == img.get_format():
		_tex.update(img)
	else:
		_tex = ImageTexture.create_from_image(img)
		_rect.texture = _tex
		if _frames == 1:
			print("[panel] first frame %dx%d for %s" % [img.get_width(), img.get_height(), route])


func _route_from(u: String) -> void:
	if not u.begins_with(base_url):
		return
	var r := u.substr(base_url.length())
	if r == "" or not r.begins_with("/") or r.begins_with("/?go="):
		return
	if r != route:
		route = r
		changed.emit(self)


func _on_page_message(payload: String) -> void:
	var m = JSON.parse_string(payload)
	if typeof(m) != TYPE_DICTIONARY:
		return
	match str(m.get("op", "")):
		"close":
			closed.emit(self)


func _resize_view() -> void:
	_view.size = Vector2i(roundi(css.x * dpr), roundi(css.y * dpr))
	for c in [_rect, _border, _cursor, _view.get_child(0)]:
		c.position = Vector2.ZERO
		c.size = Vector2(_view.size)
	_cursor.scale_px = dpr


# ------------------------------------------------------------------ input --

## Where a ray meets this panel, as Vector3(css_x, css_y, distance), or null.
func hit(from: Vector3, dir: Vector3) -> Variant:
	var t := global_transform
	var n := t.basis.z.normalized()
	var denom := n.dot(dir)
	if absf(denom) < 1e-5:
		return null
	var d := n.dot(t.origin - from) / denom
	if d <= 0.0:
		return null
	var p := t.affine_inverse() * (from + dir * d)
	var u := p.x / quad_size.x + 0.5
	var v := 0.5 - p.y / quad_size.y
	if u < 0.0 or u > 1.0 or v < 0.0 or v > 1.0:
		return null
	return Vector3(u * css.x, v * css.y, d)


## The point on the panel's plane for a CSS position, for the 3D cursor dot.
func point_at(px: Vector2) -> Vector3:
	var local := Vector3((px.x / css.x - 0.5) * quad_size.x, (0.5 - px.y / css.y) * quad_size.y, 0.004)
	return global_transform * local


func show_cursor(px: Vector2) -> void:
	_cursor.at = px
	_cursor.queue_redraw()


func hide_cursor() -> void:
	if _cursor.at.x >= 0:
		_cursor.at = Vector2(-100, -100)
		_cursor.queue_redraw()


func mouse(type: String, px: Vector2, button := "none", buttons := 0, clicks := 0) -> void:
	if session == "":
		return
	cdp.send("Input.dispatchMouseEvent", {
		"type": type, "x": px.x, "y": px.y, "button": button, "buttons": buttons, "clickCount": clicks,
	}, session)


func wheel(px: Vector2, dy: float) -> void:
	if session == "":
		return
	cdp.send("Input.dispatchMouseEvent", {
		"type": "mouseWheel", "x": px.x, "y": px.y, "deltaX": 0, "deltaY": dy,
	}, session)


func key(params: Dictionary) -> void:
	if session != "":
		cdp.send("Input.dispatchKeyEvent", params, session)


func insert_text(text: String) -> void:
	if session != "" and text != "":
		cdp.send("Input.insertText", {"text": text}, session)
