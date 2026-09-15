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

/// Open a Claude session in a terminal on THIS machine, over SSH to the host
/// that owns it.
///
/// Deliberately a hand-written command rather than tauri-plugin-shell. The
/// plugin would give the webview a general "run a program" capability that then
/// has to be fenced off with scope rules; this can do exactly one thing, and
/// both of its inputs are validated against a fixed shape. The session id must
/// be a uuid and the host must be a tailnet address or a bare hostname, so
/// nothing a page could say turns into extra arguments or a second command.
#[tauri::command]
fn open_session_ssh(session_id: String, host: String) -> Result<(), String> {
  fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
      && b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
      })
  }
  // A tailnet IP, or a plain hostname. No spaces, quotes or shell characters.
  fn is_host(s: &str) -> bool {
    !s.is_empty()
      && s.len() <= 64
      && s
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b'_')
  }

  if !is_uuid(&session_id) {
    return Err("session id is not a uuid".into());
  }
  if !is_host(&host) {
    return Err("host is not a plain hostname or address".into());
  }

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

    let remote = format!("brendon@{host}");
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

    // Prefer Windows Terminal for the tab, but never depend on it. wt.exe is a
    // Store app-execution alias: on mimir it resolves into a different user's
    // WindowsApps folder and launching it produced no window at all, the same
    // way it silently failed from a service on thor. So try it, and if the spawn
    // errors fall back to conhost, which is always present at a fixed path.
    let wt = std::process::Command::new("wt.exe")
      .args([
        "new-tab",
        "--title",
        &format!("{host} · claude"),
        "ssh",
        "-t",
        &remote,
        &resume,
      ])
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
      .args(["-t", &remote, &resume])
      .creation_flags(CREATE_NEW_CONSOLE)
      .spawn()
      .map(|_| ())
      .map_err(|e| format!("could not open a terminal: {e}"))
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = (session_id, host);
    Err("opening a local terminal is only wired up for Windows".into())
  }
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
  builder.plugin(
    tauri_plugin_window_state::Builder::default()
      .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
      .build(),
  )
}

#[cfg(not(desktop))]
fn desktop_window_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
  builder
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
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![open_session_ssh, local_hostname])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
