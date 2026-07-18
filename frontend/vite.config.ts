import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Single source of truth for the app version: the Tauri config (also used for
// desktop builds / auto-update). Injected as a global so the UI can show it.
const appVersion = JSON.parse(
  readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
).version as string

// Build id for the web/PWA so deploy freshness is visible in the header (the
// web version string is always the static config version, so the short SHA is
// the real "did it actually update?" signal). Cloudflare Pages exposes the
// commit as CF_PAGES_COMMIT_SHA; fall back to an explicit VITE_BUILD_ID or dev.
const buildId = process.env.VITE_BUILD_ID || process.env.CF_PAGES_COMMIT_SHA || 'dev'

// The PWA service worker is for the web/PWA deployment only. Inside the Tauri
// desktop app it's pure liability: it intercepts the cold-start navigation to
// tauri.localhost and fails (the "can't reach this page" flash), and it caused
// the stale-UI trap the native purge in lib.rs cleans up. Tauri sets
// TAURI_ENV_PLATFORM during beforeBuildCommand, so disable the SW for that
// build (virtual:pwa-register still resolves to a no-op, keeping imports valid).
const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM || process.env.VITE_TAURI === '1'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // No service worker in the desktop app build (see isTauriBuild above).
      disable: isTauriBuild,
      // Prompt mode (not autoUpdate): a freshly deployed build waits until the
      // user clicks "reload to update" in the header alarm. autoUpdate's silent
      // swap is unreliable on iOS Safari / home-screen PWAs and gave no way to
      // force the latest build.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-icon.svg'],
      manifest: {
        name: 'Valkyrie',
        short_name: 'Valkyrie',
        description: 'VALKYRIE//SYS — central dashboard',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'portrait',
        scope: '/',
        start_url: '/dashboard',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Don't auto-skip-waiting: the new SW stays in "waiting" until the user
        // accepts the update (updateServiceWorker(true) posts SKIP_WAITING).
        skipWaiting: false,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
