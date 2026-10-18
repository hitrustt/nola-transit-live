import '@fontsource-variable/atkinson-hyperlegible-next';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';
import { startRouter } from './app/router.ts';
import './styles/app.css';

startRouter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Offline support: cache the app shell and timetable so it opens without a
// connection and still shows scheduled times.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
