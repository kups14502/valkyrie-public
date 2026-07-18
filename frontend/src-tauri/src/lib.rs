use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Remember window size/position/maximized across launches — but NOT
    // visibility. The window starts hidden (see tauri.conf.json) and is
    // revealed only when the React app actually mounts (main.tsx calls
    // window.show()). The WebView2 cold-start navigation to tauri.localhost can
    // fail with ERR_FAILED ("can't reach this page") on the first try; because
    // the window is hidden and we only reveal on a real mount, that error is
    // never seen — and the retry below recovers it off-screen.
    .plugin(
      tauri_plugin_window_state::Builder::default()
        .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
        .build(),
    )
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
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
