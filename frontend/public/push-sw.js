// Push handlers for the Valkyrie service worker.
//
// This file is NOT the service worker. vite-plugin-pwa runs in generateSW
// mode, so Workbox writes sw.js and owns precaching, the navigate fallback and
// the "reload to update" prompt. Taking that over (injectManifest) to add two
// event listeners would put all of it in hand-written code for no gain, so
// vite.config.ts lists this file in workbox.importScripts instead and Workbox
// pulls it into the top of the worker it generates.
//
// The import is cache-busted with a hash of this file's contents (see
// pushSwRev in vite.config.ts). Without that, editing this file leaves sw.js
// byte-identical, the browser sees no update, and the change never ships.
//
// Plain ES5-ish JS on purpose: it is served as-is, with no build step.

self.addEventListener('push', function (event) {
  var data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    // A payload that isn't JSON still deserves to be seen.
    data = { body: event.data ? event.data.text() : '' }
  }

  var title = data.title || 'Valkyrie'
  var options = {
    body: data.body || '',
    // A tag collapses repeats: a second alert for the same session replaces
    // the first rather than stacking on the lock screen.
    tag: data.tag || 'valkyrie',
    renotify: true,
    icon: '/pwa-192.png',
    badge: '/pwa-192.png',
    data: { url: data.url || '/sessions' },
  }

  // iOS revokes push permission from a PWA that receives a push and shows
  // nothing, so this must always resolve to a visible notification.
  event.waitUntil(self.registration.showNotification(title, options))
})

// The v2 screen (/m/*) an alert belongs on. The server names classic pages
// (backend/src/alerts.ts, routes/push.ts, routes/mcp.ts) and the tag says what
// the alert is about; a worker cannot see which UI the device uses, so the tap
// carries both: the classic URL, plus ?v2=<this>. The page decides before its
// router starts (src/main.tsx): a device in v2 opens the v2 screen, a device in
// the classic UI drops the hint. null: the app's own mapping of the classic URL
// is right (lib/deviceMode classicToV2), or v2 has no screen for it (the Vault).
function v2Target(url, tag, body) {
  var path = ''
  try { path = new URL(url, self.location.origin).pathname } catch (e) { return null }
  // "Session waiting" / "Session complete": the body is the session's name on
  // the board, never its tmux pane, so v2 looks the pane up (/m/ai/open)
  if (/^session-/.test(tag) && body) return '/m/ai/open?label=' + encodeURIComponent(body)
  // the AI quota and a dead or restored sign-in: AI > Usage holds every account
  if (tag === 'claude-quota' || /^claude-signin-/.test(tag)) return '/m/ai/usage'
  // odin's disk: System > Hosts shows each machine's disk
  if (tag === 'disk') return '/m/system/hosts'
  // a project alert: AI > Projects opens that project's detail
  var proj = /^\/projects\/([a-z0-9][a-z0-9-]{0,31})$/.exec(path)
  if (proj) return '/m/ai/projects?p=' + proj[1]
  return null
}

function withV2(url, v2) {
  if (!v2) return url
  return url + (url.indexOf('?') === -1 ? '?' : '&') + 'v2=' + encodeURIComponent(v2)
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var data = event.notification.data || {}
  var url = data.url || '/sessions'
  var target = withV2(url, v2Target(url, event.notification.tag || '', event.notification.body || ''))

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i += 1) {
        var client = clients[i]
        if (new URL(client.url).origin !== self.location.origin) continue
        // Focus first: on iOS a navigate() on an unfocused client can be
        // ignored, and landing anywhere in the app beats landing nowhere.
        return client.focus().then(function (focused) {
          if (focused && 'navigate' in focused) {
            return focused.navigate(target).catch(function () {})
          }
        })
      }
      return self.clients.openWindow(target)
    }),
  )
})
