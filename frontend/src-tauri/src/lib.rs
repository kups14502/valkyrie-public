use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Remember window size/position/maximized across launches — but NOT
    // visibility. The window starts hidden (see tauri.conf.json) and we reveal
    // it only once content has loaded, so the WebView2 cold-start navigation to
    // tauri.localhost can't flash its "can't reach this page" error at the user.
    .plugin(
      tauri_plugin_window_state::Builder::default()
        .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
        .build(),
    )
    // Fast path: reveal the window the moment a page finishes loading.
    .on_page_load(|webview, payload| {
      if payload.event() == tauri::webview::PageLoadEvent::Finished {
        let _ = webview.window().show();
      }
    })
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
      // Self-heal the stale-service-worker trap. Older app builds registered a
      // PWA service worker that precached the frontend. It lives in the webview
      // data dir, survives binary auto-updates, and keeps serving the OLD UI —
      // so the updated app shows stale screens and the JS-side unregister never
      // runs (the cached page is served instead of the fresh bundle). We can't
      // fix this from JS that never loads, so do it natively: unregister any SW
      // and delete CacheStorage, then reload to pull the fresh assets from the
      // Tauri protocol. A no-op (no reload) once clean, so it's safe every
      // launch; localStorage (auth/theme/unread state) is preserved.
      // Safety net: reveal the window after a short delay no matter what, so a
      // failed or slow first load can never leave it hidden forever. Showing an
      // already-visible window is a no-op.
      if let Some(win) = app.get_webview_window("main") {
        let w = win.clone();
        std::thread::spawn(move || {
          std::thread::sleep(std::time::Duration::from_millis(1500));
          let _ = w.show();
        });
      }
      if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(
          r#"(async () => {
            try {
              let purged = false;
              if (navigator.serviceWorker) {
                for (const r of await navigator.serviceWorker.getRegistrations()) { await r.unregister(); purged = true; }
              }
              if (window.caches) {
                const keys = await caches.keys();
                for (const k of keys) { await caches.delete(k); }
                if (keys.length) purged = true;
              }
              if (purged) location.reload();
            } catch (e) {}
          })();"#,
        );
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
