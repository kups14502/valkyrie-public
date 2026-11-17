class_name Keys
extends RefCounted
## Turns a Godot key event into Input.dispatchKeyEvent parameters, shaped the way
## a US keyboard's DOM events look, because that is what xterm.js reads: key and
## keyCode for the special keys and Ctrl/Alt chords, text for what to insert.

const ALT := 1
const CTRL := 2
const META := 4
const SHIFT := 8

# Godot key -> [DOM key, DOM code, Windows virtual key code, text]
const SPECIAL := {
	KEY_ENTER: ["Enter", "Enter", 13, "\r"],
	KEY_KP_ENTER: ["Enter", "NumpadEnter", 13, "\r"],
	KEY_BACKSPACE: ["Backspace", "Backspace", 8, ""],
	KEY_TAB: ["Tab", "Tab", 9, ""],
	KEY_ESCAPE: ["Escape", "Escape", 27, ""],
	KEY_DELETE: ["Delete", "Delete", 46, ""],
	KEY_INSERT: ["Insert", "Insert", 45, ""],
	KEY_HOME: ["Home", "Home", 36, ""],
	KEY_END: ["End", "End", 35, ""],
	KEY_PAGEUP: ["PageUp", "PageUp", 33, ""],
	KEY_PAGEDOWN: ["PageDown", "PageDown", 34, ""],
	KEY_LEFT: ["ArrowLeft", "ArrowLeft", 37, ""],
	KEY_UP: ["ArrowUp", "ArrowUp", 38, ""],
	KEY_RIGHT: ["ArrowRight", "ArrowRight", 39, ""],
	KEY_DOWN: ["ArrowDown", "ArrowDown", 40, ""],
	KEY_SPACE: [" ", "Space", 32, " "],
}

# Physical punctuation key -> [DOM code, virtual key code]
const PUNCT := {
	KEY_SEMICOLON: ["Semicolon", 186],
	KEY_EQUAL: ["Equal", 187],
	KEY_COMMA: ["Comma", 188],
	KEY_MINUS: ["Minus", 189],
	KEY_PERIOD: ["Period", 190],
	KEY_SLASH: ["Slash", 191],
	KEY_QUOTELEFT: ["Backquote", 192],
	KEY_BRACKETLEFT: ["BracketLeft", 219],
	KEY_BACKSLASH: ["Backslash", 220],
	KEY_BRACKETRIGHT: ["BracketRight", 221],
	KEY_APOSTROPHE: ["Quote", 222],
}

const MODIFIER_KEYS := [KEY_SHIFT, KEY_CTRL, KEY_ALT, KEY_META, KEY_CAPSLOCK, KEY_NUMLOCK]


## Empty when the event is a bare modifier or has nothing to send.
static func to_cdp(ev: InputEventKey) -> Dictionary:
	if ev.keycode in MODIFIER_KEYS or ev.physical_keycode in MODIFIER_KEYS:
		return {}
	var mods := 0
	if ev.alt_pressed:
		mods |= ALT
	if ev.ctrl_pressed:
		mods |= CTRL
	if ev.meta_pressed:
		mods |= META
	if ev.shift_pressed:
		mods |= SHIFT
	var chord := (mods & (ALT | CTRL | META)) != 0

	var key := ""
	var code := ""
	var vk := 0
	var text := ""
	var phys := ev.physical_keycode if ev.physical_keycode != KEY_NONE else ev.keycode

	if SPECIAL.has(ev.keycode) or SPECIAL.has(phys):
		var s: Array = SPECIAL.get(ev.keycode, SPECIAL.get(phys))
		key = s[0]
		code = s[1]
		vk = s[2]
		text = s[3]
	elif phys >= KEY_F1 and phys <= KEY_F12:
		var n := phys - KEY_F1 + 1
		key = "F%d" % n
		code = key
		vk = 111 + n
	elif phys >= KEY_A and phys <= KEY_Z:
		var upper := char(phys)
		code = "Key" + upper
		vk = phys
		key = char(ev.unicode) if ev.unicode >= 32 else (upper if ev.shift_pressed else upper.to_lower())
		text = key
	elif phys >= KEY_0 and phys <= KEY_9:
		code = "Digit" + char(phys)
		vk = phys
		key = char(ev.unicode) if ev.unicode >= 32 else char(phys)
		text = key
	elif PUNCT.has(phys):
		code = PUNCT[phys][0]
		vk = PUNCT[phys][1]
		key = char(ev.unicode) if ev.unicode >= 32 else ""
		text = key
	elif ev.unicode >= 32:
		key = char(ev.unicode)
		text = key
	else:
		return {}

	# A Ctrl or Alt chord types nothing itself; xterm builds the bytes from key and keyCode.
	if chord:
		text = ""
	var p := {
		"type": ("keyDown" if text != "" else "rawKeyDown") if ev.pressed else "keyUp",
		"key": key,
		"code": code,
		"windowsVirtualKeyCode": vk,
		"nativeVirtualKeyCode": vk,
		"modifiers": mods,
		"autoRepeat": ev.echo,
	}
	if ev.pressed and text != "":
		p["text"] = text
		p["unmodifiedText"] = text
	return p
