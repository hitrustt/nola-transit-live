import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    proxy: {
      '/api/vehicles': {
        target: 'https://bustime.norta.com',
        changeOrigin: true,
        rewrite: () => '/bustime/map/getBusesForRouteAll.jsp',
      },
    },
  },
});
