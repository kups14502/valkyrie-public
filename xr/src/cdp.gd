class_name Cdp
extends Node
## Chrome DevTools Protocol client for the offscreen Chromium the panels render in.
##
## One browser-level socket. Each panel is a page target attached in flat mode, so
## its commands and events carry that target's sessionId. Screencast frames are
## large (a PNG in base64, up to about 1 MB), so those packets are parsed and
## decoded on the worker pool and only the finished Image comes back to the main
## thread. Everything else is parsed here.

signal connected
signal disconnected
## A CDP event. For Page.screencastFrame, params.image holds the decoded Image.
signal event(session: String, method: String, params: Dictionary)

const FRAME_PREFIX := "{\"method\":\"Page.screencastFrame\""

var port := 9233
var is_open := false

var _ws := WebSocketPeer.new()
var _http: HTTPRequest
var _state := "idle"
var _retry_at := 0
var _next_id := 0
var _pending := {}
var _jobs: Array = []


class Reply:
	extends RefCounted
	signal done(msg: Dictionary)


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.timeout = 3.0
	add_child(_http)
	_http.request_completed.connect(_on_version)


func _process(_dt: float) -> void:
	match _state:
		"idle":
			if Time.get_ticks_msec() >= _retry_at:
				_state = "finding"
				if _http.request("http://127.0.0.1:%d/json/version" % port) != OK:
					_retry("the version request did not start")
		"connecting", "open":
			_ws.poll()
			var st := _ws.get_ready_state()
			if st == WebSocketPeer.STATE_OPEN:
				if _state == "connecting":
					_state = "open"
					is_open = true
					print("[cdp] connected")
					connected.emit()
				while _ws.get_available_packet_count() > 0:
					_receive(_ws.get_packet())
			elif st == WebSocketPeer.STATE_CLOSED:
				var was_open := is_open
				is_open = false
				_fail_pending()
				_retry("socket closed %d %s" % [_ws.get_close_code(), _ws.get_close_reason()])
				if was_open:
					disconnected.emit()
	_finish_jobs()


## Sends a command and forgets the reply.
func send(method: String, params := {}, session := "") -> int:
	if not is_open:
		return 0
	_next_id += 1
	var msg := {"id": _next_id, "method": method, "params": params}
	if session != "":
		msg["sessionId"] = session
	_ws.send_text(JSON.stringify(msg))
	return _next_id


## Sends a command and waits for its reply. A reply with "error" means it failed,
## including when the socket dropped first.
func request(method: String, params := {}, session := "") -> Dictionary:
	var id := send(method, params, session)
	if id == 0:
		return {"error": {"message": "not connected"}}
	var reply := Reply.new()
	_pending[id] = reply
	var msg: Dictionary = await reply.done
	if msg.has("error"):
		print("[cdp] %s failed: %s" % [method, msg.error])
	return msg


func close_browser() -> void:
	send("Browser.close")
	_ws.poll()


func _retry(why: String) -> void:
	if _state != "idle":
		print("[cdp] ", why, ", retrying")
	_state = "idle"
	_retry_at = Time.get_ticks_msec() + 1500


func _on_version(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	if result != HTTPRequest.RESULT_SUCCESS or code != 200:
		_retry("no browser on port %d yet" % port)
		return
	var info = JSON.parse_string(body.get_string_from_utf8())
	if typeof(info) != TYPE_DICTIONARY or not info.has("webSocketDebuggerUrl"):
		_retry("the version reply had no socket address")
		return
	_ws = WebSocketPeer.new()
	_ws.inbound_buffer_size = 16 << 20
	_ws.outbound_buffer_size = 1 << 20
	_ws.max_queued_packets = 8192
	if _ws.connect_to_url(info.webSocketDebuggerUrl) != OK:
		_retry("connect_to_url failed")
		return
	print("[cdp] browser ", info.get("Browser", "?"))
	_state = "connecting"


func _receive(pkt: PackedByteArray) -> void:
	if pkt.size() > 4096 and pkt.slice(0, FRAME_PREFIX.length()).get_string_from_ascii() == FRAME_PREFIX:
		var out := {}
		var task := WorkerThreadPool.add_task(_decode.bind(pkt, out), false, "screencast frame")
		_jobs.append([task, out])
		return
	var msg = JSON.parse_string(pkt.get_string_from_utf8())
	if typeof(msg) == TYPE_DICTIONARY:
		_dispatch(msg)


# Runs on the worker pool. Writes only into `out`.
func _decode(pkt: PackedByteArray, out: Dictionary) -> void:
	var msg = JSON.parse_string(pkt.get_string_from_utf8())
	if typeof(msg) != TYPE_DICTIONARY:
		return
	var params: Dictionary = msg.get("params", {})
	var raw := Marshalls.base64_to_raw(params.get("data", ""))
	params.erase("data")
	var img := Image.new()
	var err := ERR_INVALID_DATA
	if raw.size() > 8 and raw[1] == 0x50:
		err = img.load_png_from_buffer(raw)
	elif raw.size() > 8:
		err = img.load_jpg_from_buffer(raw)
	if err == OK:
		params["image"] = img
	out["msg"] = msg


func _finish_jobs() -> void:
	while not _jobs.is_empty() and WorkerThreadPool.is_task_completed(_jobs[0][0]):
		var job = _jobs.pop_front()
		WorkerThreadPool.wait_for_task_completion(job[0])
		if job[1].has("msg"):
			_dispatch(job[1].msg)


func _dispatch(msg: Dictionary) -> void:
	if msg.has("id"):
		var reply: Reply = _pending.get(int(msg.id))
		if reply:
			_pending.erase(int(msg.id))
			reply.done.emit(msg)
		return
	if msg.has("method"):
		event.emit(msg.get("sessionId", ""), msg.method, msg.get("params", {}))


func _fail_pending() -> void:
	var replies := _pending.values()
	_pending.clear()
	for reply in replies:
		reply.done.emit({"error": {"message": "disconnected"}})
