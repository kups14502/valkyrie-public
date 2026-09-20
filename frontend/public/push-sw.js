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

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var target = (event.notification.data && event.notification.data.url) || '/sessions'

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
