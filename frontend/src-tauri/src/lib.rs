use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
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
