import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { realtimeDevPlugin } from './dev/realtimePlugin.ts';

export default defineConfig({
  plugins: [
    react(),
    realtimeDevPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/*.svg', 'icons/*.png', 'theme.js'],
      manifest: {
        name: 'NOLA Transit Live',
        short_name: 'Transit Live',
        description: 'Live arrivals for New Orleans RTA buses, streetcars and ferries.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f6f7f5',
        theme_color: '#f6f7f5',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,svg,png}'],
        globIgnores: ['**/og.png'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/data\//],
        runtimeCaching: [
          {
            // The network and route lines: show the cached copy instantly, refresh behind.
            urlPattern: ({ url }) => url.pathname === '/data/network.json' || url.pathname === '/data/route-lines.json',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'network-data' },
          },
          {
            // Timetables, so a saved stop still shows scheduled times offline.
            urlPattern: ({ url }) => url.pathname.startsWith('/data/schedules/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'schedules', expiration: { maxEntries: 120, maxAgeSeconds: 14 * 86400 } },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://tiles.openfreemap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'basemap',
              expiration: { maxEntries: 800, maxAgeSeconds: 14 * 86400 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  // MapLibre's worker is an ES module.
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // MapLibre is large and changes rarely; keep it out of the app chunk so
        // app updates don't make riders re-download it.
        manualChunks: (id) => (id.includes('node_modules/maplibre-gl') ? 'maplibre' : undefined),
      },
    },
  },
});
