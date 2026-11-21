use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_window_state::StateFlags;

/// This machine's name, lowercased. The page uses it to decide whether a
/// session lives here or on another host, so "open" can always mean "open in
/// front of me" instead of making the user pick a machine.
#[tauri::command]
fn local_hostname() -> String {
  std::env::var("COMPUTERNAME")
    .or_else(|_| std::env::var("HOSTNAME"))
    .unwrap_or_default()
    .to_lowercase()
}

/// Shapes the page is allowed to hand this file. Nothing here ever becomes a
/// path: a session id is a uuid, a target is a key from thor's own list, and
/// the host is a tailnet address, so no input can grow an extra argument or a
/// second command.
fn is_uuid(s: &str) -> bool {
  let b = s.as_bytes();
  b.len() == 36
    && b.iter().enumerate().all(|(i, c)| match i {
      8 | 13 | 18 | 23 => *c == b'-',
      _ => c.is_ascii_hexdigit(),
    })
}

/// A launch-target key, the same shape thor's agent and Remote-Session.ps1
/// enforce on their own side.
fn is_target(s: &str) -> bool {
  let b = s.as_bytes();
  !b.is_empty()
    && b.len() <= 32
    && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
    && b
      .iter()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A tailnet IP, or a plain hostname. No spaces, quotes or shell characters.
fn is_host(s: &str) -> bool {
  !s.is_empty()
    && s.len() <= 64
    && s
      .bytes()
      .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b'_')
}

/// An http(s) address with nothing that could read as a second argument: the
/// page sends `new URL(...).href`, which is already percent-encoded ASCII.
fn is_web_url(s: &str) -> bool {
  s.len() <= 4096
    && (s.starts_with("https://") || s.starts_with("http://"))
    && s.bytes().all(|c| c.is_ascii_graphic() && c != b'"')
}

/// Open an http(s) address in the system's default browser.
///
/// The webview opens no new window by itself: wry gives every window.open and
/// target="_blank" link to the app's on_new_window handler and, with none set,
/// marks the request handled and opens nothing. src/lib/external.ts sends
/// those addresses here instead. Hand-written like the commands below rather
/// than tauri-plugin-opener: it opens one web address and nothing else.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
  if !is_web_url(&url) {
    return Err("not an http(s) address".into());
  }

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // url.dll's FileProtocolHandler hands the address to the default browser
    // with no shell in between, so an & in a query string stays in the address.
    std::process::Command::new("rundll32.exe")
      .args(["url.dll,FileProtocolHandler", &url])
      .creation_flags(CREATE_NO_WINDOW)
      .spawn()
      .map(|_| ())
      .map_err(|e| format!("could not open the browser: {e}"))
  }

  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(&url)
      .spawn()
      .map(|_| ())
      .map_err(|e| format!("could not open the browser: {e}"))
  }

  #[cfg(target_os = "linux")]
  {
    std::process::Command::new("xdg-open")
      .arg(&url)
      .spawn()
      .map(|_| ())
      .map_err(|e| format!("could not open the browser: {e}"))
  }

  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  {
    let _ = url;
    Err("opening the system browser is only wired up for the desktop app".into())
  }
}

/// A Windows Terminal window name, which is what makes tabs land in one window
/// per group instead of scattering. Rejects wt's own reserved names: a bare
/// number means "that window id", and `new` and `last` are keywords, so a group
/// called any of those would quietly target the wrong window. Anything that
/// fails here just means no grouping, never an error: a tab Brendon has to drag
/// beats a session that would not open.
#[cfg(target_os = "windows")]
fn is_group(s: &str) -> bool {
  !s.is_empty()
    && s.len() <= 32
    && s
      .bytes()
      .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    && !s.bytes().all(|c| c.is_ascii_digit())
    && !matches!(s.to_ascii_lowercase().as_str(), "new" | "last")
}

/// Open a terminal HERE, running one command over SSH on `host`.
///
/// Prefer Windows Terminal for the tab, but never depend on it. wt.exe is a
/// Store app-execution alias: on mimir it resolves into a different user's
/// WindowsApps folder and launching it produced no window at all, the same way
/// it silently failed from a service on thor. So try it, and if the spawn
/// errors fall back to conhost, which is always present at a fixed path.
///
/// `-w <group>` is what puts work and personal in their own windows. Without it
/// every session opened detached and had to be dragged together by hand, which
/// the launcher on thor had solved years earlier and this path had simply never
/// been told about. It has to come from the caller: the window is created HERE,
/// before any SSH runs, so the host that owns the rules cannot be consulted.
/// `-w` must precede the subcommand.
#[cfg(target_os = "windows")]
fn open_terminal(host: &str, title: &str, command: &str, group: Option<String>) -> Result<(), String> {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

  let remote = format!("brendon@{host}");
  let window = group.as_deref().map(str::trim).filter(|g| is_group(g));
  let mut args: Vec<&str> = Vec::new();
  if let Some(w) = window {
    args.push("-w");
    args.push(w);
  }
  args.extend_from_slice(&["new-tab", "--title", title, "ssh", "-t", &remote, command]);

  let wt = std::process::Command::new("wt.exe")
    .args(&args)
    .creation_flags(CREATE_NO_WINDOW)
    .spawn();

  if wt.is_ok() {
    return Ok(());
  }

  // ssh.exe lives in System32\OpenSSH on every supported build. Spawned with
  // its own console so there is a visible window to type into, and -t forces
  // the pty the TUI needs.
  let ssh = std::path::Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
    .join("System32")
    .join("OpenSSH")
    .join("ssh.exe");
  let exe = if ssh.exists() {
    ssh.to_string_lossy().into_owned()
  } else {
    "ssh.exe".into()
  };

  std::process::Command::new(exe)
    .args(["-t", &remote, command])
    .creation_flags(CREATE_NEW_CONSOLE)
    .spawn()
    .map(|_| ())
    .map_err(|e| format!("could not open a terminal: {e}"))
}

/// Resume a Claude session in a terminal on THIS machine, over SSH to the host
/// that owns it.
///
/// Deliberately a hand-written command rather than tauri-plugin-shell. The
/// plugin would give the webview a general "run a program" capability that then
/// has to be fenced off with scope rules; this can do exactly one thing, and
/// every input is validated against a fixed shape.
#[tauri::command]
fn open_session_ssh(session_id: String, host: String, group: Option<String>) -> Result<(), String> {
  if !is_uuid(&session_id) {
    return Err("session id is not a uuid".into());
  }
  if !is_host(&host) {
    return Err("host is not a plain hostname or address".into());
  }

  #[cfg(target_os = "windows")]
  {
    // NOT a bare `claude -r`. An SSH login starts in the home directory, so that
    // resumed the session in the wrong place: it prompted to trust the folder,
    // relative paths resolved somewhere unexpected, and the session's registry
    // entry began reporting the home directory as its cwd, which the desk
    // capture then recorded and a later restore would have made real.
    // Resume.ps1 runs on the far end and works out the right directory there,
    // so no path ever crosses the wire.
    const RESUME_PS1: &str = r"C:\Thor\tools\session-board\Resume.ps1";
    let resume = format!(
      "powershell -NoProfile -ExecutionPolicy Bypass -File {RESUME_PS1} -SessionId {session_id}"
    );
    let title = format!("{host} \u{b7} claude");
    open_terminal(&host, &title, &resume, group)
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = (session_id, host, group);
    Err("opening a local terminal is only wired up for Windows".into())
  }
}

/// Start a NEW Claude session in a terminal on THIS machine, in one of thor's
/// launch targets.
///
/// The counterpart to open_session_ssh, and the one thing the board could not
/// do from another machine: "new session" always posted to the host's own
/// launcher agent, which opens the tab on THAT host's screen. Pressed at mimir,
/// the row appeared in the list and the window appeared on thor.
///
/// A KEY crosses the wire, never a path. Remote-Session.ps1 resolves it on thor
/// out of thor's own launch-targets.json, the same rule the launcher agent
/// follows, so this cannot open a session anywhere Brendon has not listed.
#[tauri::command]
fn open_new_ssh(target: String, host: String, group: Option<String>) -> Result<(), String> {
  if !is_target(&target) {
    return Err("target is not a launch-target key".into());
  }
  if !is_host(&host) {
    return Err("host is not a plain hostname or address".into());
  }

  #[cfg(target_os = "windows")]
  {
    const REMOTE_PS1: &str = r"C:\Thor\tools\session-board\Remote-Session.ps1";
    let start = format!(
      "powershell -NoProfile -ExecutionPolicy Bypass -File {REMOTE_PS1} -Mode new -Target {target}"
    );
    let title = format!("{host} \u{b7} {target}");
    open_terminal(&host, &title, &start, group)
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = (target, host, group);
    Err("opening a local terminal is only wired up for Windows".into())
  }
}

// ------------------------------------------------------------ Raven widget ---
//
// A small Raven button with a compact chat that sits on the desktop (the page
// is /m/w/raven, src/v2/screens/RavenWidget.tsx). Rust owns whether it is on
// screen: it is on by default, Settings turns it off (the choice is a marker
// file in the app's config folder), and after five minutes with no mouse or
// keyboard input anywhere on the machine it is hidden completely, so an OLED
// panel has no lit pixels under it. The first input brings it back. Idle is
// the system's own count (GetLastInputInfo), so it hides even while Brendon
// works in another app and wakes on input in any app.
//
// It is never on top of anything but the desktop: behind every app window and
// fullscreen game, out of the taskbar and out of Alt-Tab. On Windows that is
// a tool window (WS_EX_TOOLWINDOW, no WS_EX_APPWINDOW) that sits directly
// above the desktop's own window (the one holding the icons): every z-order
// change goes through widget_win::z_target (a subclass on
// WM_WINDOWPOSCHANGING), and the 250 ms loop puts it back there if something
// else moved. The desktop is normally the bottom of the stack, so the widget
// is under every app; when Win+D or Show desktop brings the desktop forward,
// the widget comes with it. A click or its own setFocus activates it without
// raising it. On Linux it is keep-below with the skip-taskbar and skip-pager hints.
//
// On Windows the show and hide are plain ShowWindow calls with
// SW_SHOWNOACTIVATE: a widget that comes back on a key press must never take
// the keyboard from the app he is typing in. Tauri's own show() activates the
// window, so the widget never goes through it, here or in the page.

#[cfg(desktop)]
const WIDGET: &str = "raven-widget";
#[cfg(desktop)]
const WIDGET_IDLE_MS: u64 = 5 * 60 * 1000;

#[cfg(desktop)]
#[derive(Default)]
struct RavenWidget {
  enabled: std::sync::atomic::AtomicBool,
  /// the page has placed the window and asked to be shown
  ready: std::sync::atomic::AtomicBool,
  shown: std::sync::atomic::AtomicBool,
}

/// Milliseconds since the last mouse or keyboard input on this machine; None
/// where the system does not say (then the widget never hides for idle).
#[cfg(target_os = "windows")]
fn system_idle_ms() -> Option<u64> {
  #[repr(C)]
  struct LastInputInfo {
    cb_size: u32,
    dw_time: u32,
  }
  #[link(name = "user32")]
  extern "system" {
    fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
  }
  #[link(name = "kernel32")]
  extern "system" {
    fn GetTickCount() -> u32;
  }
  let mut info = LastInputInfo { cb_size: std::mem::size_of::<LastInputInfo>() as u32, dw_time: 0 };
  // SAFETY: a plain out-parameter struct of the documented size
  let ok = unsafe { GetLastInputInfo(&mut info) } != 0;
  if !ok {
    return None;
  }
  // both are 32-bit tick counts that wrap every 49.7 days; the wrapping difference stays right
  let now = unsafe { GetTickCount() };
  Some(now.wrapping_sub(info.dw_time) as u64)
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn system_idle_ms() -> Option<u64> {
  None
}

/// The widget's place among the windows on Windows: a tool window (no taskbar
/// button, no Alt-Tab entry) kept directly above the desktop's own window.
#[cfg(target_os = "windows")]
mod widget_win {
  #[repr(C)]
  struct WindowPos {
    hwnd: isize,
    hwnd_insert_after: isize,
    x: i32,
    y: i32,
    cx: i32,
    cy: i32,
    flags: u32,
  }

  type SubclassProc = unsafe extern "system" fn(isize, u32, usize, isize, usize, usize) -> isize;

  #[link(name = "user32")]
  extern "system" {
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
    fn SetWindowLongW(hwnd: isize, index: i32, value: i32) -> i32;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetWindow(hwnd: isize, cmd: u32) -> isize;
    fn FindWindowExW(parent: isize, after: isize, class: *const u16, title: *const u16) -> isize;
  }
  #[link(name = "comctl32")]
  extern "system" {
    fn SetWindowSubclass(hwnd: isize, proc_: SubclassProc, id: usize, data: usize) -> i32;
    fn RemoveWindowSubclass(hwnd: isize, proc_: SubclassProc, id: usize) -> i32;
    fn DefSubclassProc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
  }

  const SW_HIDE: i32 = 0;
  const SW_SHOWNOACTIVATE: i32 = 4;
  const GWL_EXSTYLE: i32 = -20;
  const WS_EX_TOPMOST: u32 = 0x0000_0008;
  const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
  const WS_EX_APPWINDOW: u32 = 0x0004_0000;
  const HWND_TOP: isize = 0;
  const HWND_BOTTOM: isize = 1;
  const GW_HWNDPREV: u32 = 3;
  const SWP_NOSIZE: u32 = 0x0001;
  const SWP_NOMOVE: u32 = 0x0002;
  const SWP_NOZORDER: u32 = 0x0004;
  const SWP_NOACTIVATE: u32 = 0x0010;
  const SWP_FRAMECHANGED: u32 = 0x0020;
  const SWP_NOOWNERZORDER: u32 = 0x0200;
  const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
  const WM_WINDOWPOSCHANGING: u32 = 0x0046;
  const WM_NCDESTROY: u32 = 0x0082;
  const SUBCLASS_ID: usize = 0x5241_5645; // "RAVE"

  fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
  }

  /// The desktop's own top-level window: the one holding SHELLDLL_DefView
  /// (the icons), Progman on current Windows 11, a WorkerW where a wallpaper
  /// app or an older build moved the icons. 0 when Explorer is not running.
  unsafe fn desktop_host() -> isize {
    let defview = wide("SHELLDLL_DefView");
    let progman = FindWindowExW(0, 0, wide("Progman").as_ptr(), std::ptr::null());
    if progman != 0 && FindWindowExW(progman, 0, defview.as_ptr(), std::ptr::null()) != 0 {
      return progman;
    }
    let worker = wide("WorkerW");
    let mut w = 0;
    loop {
      w = FindWindowExW(0, w, worker.as_ptr(), std::ptr::null());
      if w == 0 {
        return progman;
      }
      if FindWindowExW(w, 0, defview.as_ptr(), std::ptr::null()) != 0 {
        return w;
      }
    }
  }

  /// Where the widget goes in the stack: directly above the desktop's window
  /// (as the window to sit under, or HWND_TOP when nothing non-topmost is above
  /// it), or None when it is there already.
  unsafe fn z_target(me: isize) -> Option<isize> {
    let host = desktop_host();
    if host == 0 {
      return Some(HWND_BOTTOM);
    }
    let above = GetWindow(host, GW_HWNDPREV);
    if above == me {
      return None;
    }
    if above == 0 || GetWindowLongW(above, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST != 0 {
      return Some(HWND_TOP);
    }
    Some(above)
  }

  /// Every z-order change of the widget, from Windows, tao or this file, lands on z_target.
  unsafe extern "system" fn subclass(hwnd: isize, msg: u32, wparam: usize, lparam: isize, _id: usize, _data: usize) -> isize {
    if msg == WM_WINDOWPOSCHANGING && lparam != 0 {
      let pos = &mut *(lparam as *mut WindowPos);
      if pos.flags & SWP_NOZORDER == 0 {
        match z_target(hwnd) {
          Some(after) => pos.hwnd_insert_after = after,
          None => pos.flags |= SWP_NOZORDER,
        }
      }
    } else if msg == WM_NCDESTROY {
      RemoveWindowSubclass(hwnd, subclass, SUBCLASS_ID);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
  }

  /// A tool window without WS_EX_APPWINDOW: no taskbar button and no Alt-Tab
  /// entry. tao rewrites the extended style when its own window flags change,
  /// so this runs again on every show and every tick (it costs one read when nothing changed).
  pub fn keep_tool_window(me: isize) {
    // SAFETY: the widget's own handle; style reads and writes on a window of this process
    unsafe {
      let ex = GetWindowLongW(me, GWL_EXSTYLE) as u32;
      let want = (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
      if want != ex {
        SetWindowLongW(me, GWL_EXSTYLE, want as i32);
        SetWindowPos(
          me,
          0,
          0,
          0,
          0,
          0,
          SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_ASYNCWINDOWPOS,
        );
      }
    }
  }

  /// Put the widget where z_target says. The 250 ms loop calls it too: a click
  /// on the desktop or another window's move can come between the two without
  /// the widget's own z-order changing. It costs a few lookups when nothing moved.
  pub fn restack(me: isize) {
    // SAFETY: the widget's own handle; a z-order move that never activates it
    unsafe {
      if let Some(after) = z_target(me) {
        SetWindowPos(me, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS);
      }
    }
  }

  /// Hook the widget's z-order. Must run on the thread that owns the window (the main thread).
  pub fn install(me: isize) {
    // SAFETY: the widget's own handle, on its own thread; the subclass removes itself on WM_NCDESTROY
    if unsafe { SetWindowSubclass(me, subclass, SUBCLASS_ID, 0) } == 0 {
      log::warn!("raven widget: could not hook the window's z-order");
    }
  }

  pub fn set_shown(me: isize, show: bool) {
    // SAFETY: the window's own handle, a show command with no other effect
    unsafe { ShowWindow(me, if show { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
  }
}

#[cfg(target_os = "windows")]
fn widget_hwnd(win: &tauri::WebviewWindow) -> Option<isize> {
  win.hwnd().ok().map(|h| h.0 as isize)
}

/// Show or hide the widget without ever activating it, and keep it out of the
/// taskbar and Alt-Tab and below every app after each change.
#[cfg(desktop)]
fn widget_set_shown(win: &tauri::WebviewWindow, show: bool) {
  #[cfg(target_os = "windows")]
  {
    if let Some(me) = widget_hwnd(win) {
      widget_win::keep_tool_window(me);
      widget_win::set_shown(me, show);
      if show {
        widget_win::keep_tool_window(me);
        widget_win::restack(me);
      }
    }
  }
  #[cfg(not(target_os = "windows"))]
  {
    let _ = if show { win.show() } else { win.hide() };
    if show {
      let _ = win.set_skip_taskbar(true);
      let _ = win.set_always_on_bottom(true);
    }
  }
}

#[cfg(desktop)]
fn widget_flag_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
  app.path().app_config_dir().ok().map(|d| d.join("raven-widget-off"))
}

/// On unless Brendon turned it off (a marker file, so a fresh install is on).
#[cfg(desktop)]
fn widget_saved_enabled(app: &tauri::AppHandle) -> bool {
  widget_flag_path(app).map(|p| !p.exists()).unwrap_or(true)
}

#[cfg(desktop)]
fn widget_save_enabled(app: &tauri::AppHandle, on: bool) {
  let Some(p) = widget_flag_path(app) else { return };
  if on {
    let _ = std::fs::remove_file(&p);
  } else {
    if let Some(dir) = p.parent() {
      let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, b"off\n");
  }
}

/// Bring the widget's visibility in line with: on, placed, and not idle.
#[cfg(desktop)]
fn widget_sync(app: &tauri::AppHandle) {
  use std::sync::atomic::Ordering::SeqCst;
  let st = app.state::<RavenWidget>();
  let Some(win) = app.get_webview_window(WIDGET) else { return };
  let idle = system_idle_ms().map(|ms| ms >= WIDGET_IDLE_MS).unwrap_or(false);
  let want = st.enabled.load(SeqCst) && st.ready.load(SeqCst) && !idle;
  if st.shown.swap(want, SeqCst) != want {
    widget_set_shown(&win, want);
  }
  // back directly above the desktop if anything moved in between (Win+D, a click on the desktop)
  #[cfg(target_os = "windows")]
  if let Some(me) = widget_hwnd(&win) {
    widget_win::keep_tool_window(me);
    if want {
      widget_win::restack(me);
    }
  }
}

#[cfg(desktop)]
fn widget_create(app: &tauri::AppHandle) {
  if app.get_webview_window(WIDGET).is_some() {
    return;
  }
  // tiny, hidden, unfocused; the page sizes and places it, then asks to be shown (raven_widget_ready)
  let built = tauri::WebviewWindowBuilder::new(app, WIDGET, tauri::WebviewUrl::App("m/w/raven".into()))
    .title("Raven")
    .inner_size(64.0, 64.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    // never on top of an app; on Windows the z-order hook in widget_win keeps it there instead
    .always_on_bottom(cfg!(not(target_os = "windows")))
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .disable_drag_drop_handler()
    .build();
  match built {
    Ok(win) => {
      // a tool window with its z-order hooked before it is ever shown
      #[cfg(target_os = "windows")]
      if let Some(me) = widget_hwnd(&win) {
        widget_win::keep_tool_window(me);
        let _ = win.run_on_main_thread(move || widget_win::install(me));
      }
      // a failed first load (the same WebView2 cold start as the main window) gets one retry
      std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(4000));
        let ready = win.app_handle().state::<RavenWidget>().ready.load(std::sync::atomic::Ordering::SeqCst);
        if !ready {
          let _ = win.eval("location.reload()");
        }
      });
    }
    Err(e) => log::warn!("raven widget: could not open the window: {e}"),
  }
}

/// The widget page is placed and wants to be on screen (when on and not idle).
#[cfg(desktop)]
#[tauri::command]
fn raven_widget_ready(app: tauri::AppHandle) {
  app.state::<RavenWidget>().ready.store(true, std::sync::atomic::Ordering::SeqCst);
  widget_sync(&app);
}

#[cfg(desktop)]
#[tauri::command]
fn raven_widget_enabled(app: tauri::AppHandle) -> bool {
  app.state::<RavenWidget>().enabled.load(std::sync::atomic::Ordering::SeqCst)
}

/// Settings' switch. Every window hears `raven-widget:changed` with the new value.
#[cfg(desktop)]
#[tauri::command]
fn set_raven_widget_enabled(app: tauri::AppHandle, enabled: bool) {
  use tauri::Emitter;
  app.state::<RavenWidget>().enabled.store(enabled, std::sync::atomic::Ordering::SeqCst);
  widget_save_enabled(&app, enabled);
  if enabled {
    widget_create(&app);
  }
  widget_sync(&app);
  let _ = app.emit("raven-widget:changed", enabled);
}

/// The widget's "Open in Valkyrie", and any link in it: the main window comes
/// forward and goes to `path`, one of its own pages. Only an app path crosses, never a URL.
#[cfg(desktop)]
#[tauri::command]
fn raven_widget_open_main(app: tauri::AppHandle, path: String) -> Result<(), String> {
  use tauri::Emitter;
  let ok = path.len() <= 512
    && path.starts_with('/')
    && !path.starts_with("//")
    && !path.starts_with("/m/w/")
    && path.bytes().all(|c| c.is_ascii_graphic());
  if !ok {
    return Err("not a Valkyrie page".into());
  }
  let Some(main) = app.get_webview_window("main") else { return Err("the main window is closed".into()) };
  let _ = main.unminimize();
  let _ = main.show();
  let _ = main.set_focus();
  app.emit_to("main", "raven-widget:navigate", path).map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn widget_setup(app: &tauri::AppHandle) {
  use std::sync::atomic::Ordering::SeqCst;
  app.manage(RavenWidget::default());
  let on = widget_saved_enabled(app);
  app.state::<RavenWidget>().enabled.store(on, SeqCst);
  if on {
    widget_create(app);
  }
  // a quarter second: a mouse move brings it back at once, and the check costs nothing
  let handle = app.clone();
  std::thread::spawn(move || loop {
    std::thread::sleep(std::time::Duration::from_millis(250));
    widget_sync(&handle);
  });
}

// Everything about window geometry, visibility and cold-start recovery below is
// desktop only. On Android (the phone, and the Steam Frame's Android runtime)
// the activity is the window: there is nothing to remember, hide, or reveal,
// and the window-state crate is not even a dependency for that target.
#[cfg(desktop)]
fn desktop_window_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
  // Remember window size/position/maximized across launches — but NOT
  // visibility. The window starts hidden (see tauri.conf.json) and is
  // revealed only when the React app actually mounts (main.tsx calls
  // window.show()). The WebView2 cold-start navigation to tauri.localhost can
  // fail with ERR_FAILED ("can't reach this page") on the first try; because
  // the window is hidden and we only reveal on a real mount, that error is
  // never seen — and the retry in desktop_setup recovers it off-screen.
  // Pop-out windows (session-<name>, project-<id>) share one remembered
  // geometry per kind, so the state file does not grow a row per session.
  builder.plugin(
    tauri_plugin_window_state::Builder::default()
      .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
      // the Raven widget places itself from its own remembered corner (RavenWidget.tsx)
      .with_denylist(&[WIDGET])
      .map_label(|label| {
        if label.starts_with("session-") {
          "session"
        } else if label.starts_with("project-") {
          "project"
        } else {
          label
        }
      })
      .build(),
  )
}

#[cfg(not(desktop))]
fn desktop_window_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
  builder
}

#[cfg(desktop)]
fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
  tauri::generate_handler![
    open_session_ssh,
    open_new_ssh,
    local_hostname,
    open_external,
    raven_widget_ready,
    raven_widget_enabled,
    set_raven_widget_enabled,
    raven_widget_open_main
  ]
}

#[cfg(not(desktop))]
fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
  tauri::generate_handler![open_session_ssh, open_new_ssh, local_hostname, open_external]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  desktop_window_plugins(tauri::Builder::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Desktop auto-update: the frontend checks for and installs updates on
      // launch (see lib/updater.ts). Process plugin enables relaunch after.
      #[cfg(desktop)]
      {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;
      }

      #[cfg(desktop)]
      {
      if let Some(win) = app.get_webview_window("main") {
        // Recover a failed cold-start navigation without showing the error.
        // The window stays hidden until the app mounts and calls show(); if it
        // hasn't shown after 1.8s the first navigation likely ERR_FAILED, so
        // reload once (WebView2's custom-protocol handler is ready by then).
        // A last-resort reveal at ~4s guarantees the window can never stay
        // hidden, even if every load fails.
        let w = win.clone();
        std::thread::spawn(move || {
          std::thread::sleep(std::time::Duration::from_millis(1800));
          if !w.is_visible().unwrap_or(false) {
            let _ = w.eval("location.reload()");
          }
          std::thread::sleep(std::time::Duration::from_millis(2200));
          if !w.is_visible().unwrap_or(false) {
            let _ = w.show();
          }
        });

        // the main window closing closes the widget too, so the app quits as it always did
        let handle = app.handle().clone();
        win.on_window_event(move |e| {
          if let tauri::WindowEvent::Destroyed = e {
            if let Some(w) = handle.get_webview_window(WIDGET) {
              let _ = w.destroy();
            }
          }
        });

        // Self-heal the stale-service-worker trap from older app builds (which
        // shipped a PWA service worker; new builds ship none — see
        // vite.config.ts). Unregister any leftover SW and clear caches so the
        // next load isn't intercepted. No reload here: the retry above owns
        // recovery, and localStorage (auth/theme) is preserved.
        let _ = win.eval(
          r#"(async () => {
            try {
              if (navigator.serviceWorker) {
                for (const r of await navigator.serviceWorker.getRegistrations()) { await r.unregister(); }
              }
              if (window.caches) {
                for (const k of await caches.keys()) { await caches.delete(k); }
              }
            } catch (e) {}
          })();"#,
        );
      }
      widget_setup(app.handle());
      }
      Ok(())
    })
    .invoke_handler(invoke_handler())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
