import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadNetwork, networkStore } from './data.ts';
import { useVehicleSync } from './hooks.ts';
import { requestLocation, useLocation } from './location.ts';
import { setTheme, usePreferences } from './preferences.ts';
import { startRealtime } from './realtime.ts';
import { useView, type View } from './router.ts';
import { useStore } from './store.ts';
import type { Network } from '../lib/network.ts';
import { MapView, type MapHandle } from '../map/MapView.tsx';
import { LiveStatus } from '../ui/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Sheet, type Snap } from '../ui/Sheet.tsx';
import { HomeHeader, HomeView } from '../views/HomeView.tsx';
import { AboutHeader, AboutView, AlertsHeader, AlertsView } from '../views/InfoViews.tsx';
import { RouteHeader, RouteView } from '../views/RouteView.tsx';
import { StopHeader, StopView } from '../views/StopView.tsx';
import { VehicleHeader, VehicleView } from '../views/VehicleView.tsx';

const COMPACT_QUERY = '(max-width: 760px)';

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

function useResolvedTheme(): 'light' | 'dark' {
  const { theme } = usePreferences();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#121a17' : '#f6f7f5');
  }, [resolved]);

  return resolved;
}

export function App() {
  const state = useStore(networkStore);

  useEffect(() => {
    loadNetwork();
    startRealtime();
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="splash" role="status">
        <span className="tile tile--brand">NOLA</span>
        <p>Loading the route map…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="splash" role="alert">
        <span className="tile tile--brand">NOLA</span>
        <p>{state.message}</p>
        <button type="button" className="button" onClick={loadNetwork}>
          Try again
        </button>
      </div>
    );
  }

  return <Shell network={state.network} />;
}

function Shell({ network }: { network: Network }) {
  const view = useView();
  const compact = useMediaQuery(COMPACT_QUERY);
  const theme = useResolvedTheme();
  const location = useLocation();
  const mapRef = useRef<MapHandle>(null);
  const [query, setQuery] = useState('');
  const [snap, setSnap] = useState<Snap>(view.name === 'home' ? 'peek' : 'half');
  const [sheetHeight, setSheetHeight] = useState(0);

  useVehicleSync(network);

  // Opening a stop or route from the map should reveal its panel.
  const viewKey = JSON.stringify(view);
  useEffect(() => {
    if (view.name !== 'home') setSnap((current) => (current === 'peek' ? 'half' : current));
    document.title = titleFor(network, view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

  // Typing a search on a phone needs room for results.
  useEffect(() => {
    if (query && compact) setSnap('full');
  }, [query, compact]);

  const padding = useMemo(
    () => (compact ? { top: 16, right: 16, bottom: sheetHeight, left: 16 } : { top: 24, right: 72, bottom: 24, left: 432 }),
    [compact, sheetHeight],
  );

  const onVisibleHeight = useCallback((height: number) => setSheetHeight(height), []);

  const locate = () => {
    if (location.status === 'ready') mapRef.current?.showLocation();
    else requestLocation();
  };

  useEffect(() => {
    if (location.status === 'ready') mapRef.current?.showLocation();
    // Only the first fix after asking, not every movement.
  }, [location.status]);

  return (
    <div className={`app${compact ? ' app--compact' : ''}`}>
      <a className="skip-link" href="#panel-content">
        Skip to departures and routes
      </a>
      <MapView ref={mapRef} network={network} view={view} theme={theme} padding={padding} compact={compact} />

      <div className="map-controls" style={compact ? { bottom: Math.min(sheetHeight, window.innerHeight * 0.5) + 12 } : undefined}>
        {!compact && (
          <div className="map-controls__group">
            <button type="button" className="map-button" onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in">
              <Icon name="plus" />
            </button>
            <button type="button" className="map-button" onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out">
              <Icon name="minus" />
            </button>
          </div>
        )}
        <button
          type="button"
          className={`map-button${location.status === 'ready' ? ' is-on' : ''}`}
          onClick={locate}
          aria-label={location.status === 'ready' ? 'Center on my location' : 'Show my location'}
          disabled={location.status === 'locating'}
        >
          <Icon name="locate" />
        </button>
        <button
          type="button"
          className="map-button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? 'Use light map' : 'Use dark map'}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>

      <Sheet
        compact={compact}
        snap={snap}
        onSnapChange={setSnap}
        onVisibleHeight={onVisibleHeight}
        header={<Header network={network} view={view} query={query} onQuery={setQuery} />}
        footer={<LiveStatus network={network} />}
      >
        <div id="panel-content" tabIndex={-1}>
          <Body network={network} view={view} query={query} />
        </div>
      </Sheet>
    </div>
  );
}

function Header({ network, view, query, onQuery }: { network: Network; view: View; query: string; onQuery: (value: string) => void }) {
  switch (view.name) {
    case 'stop':
      return <StopHeader network={network} stop={network.stopsById.get(view.stopId)} />;
    case 'route':
      return <RouteHeader route={network.routesById.get(view.routeId)} />;
    case 'vehicle':
      return <VehicleHeader network={network} vehicleId={view.vehicleId} />;
    case 'alerts':
      return <AlertsHeader />;
    case 'about':
      return <AboutHeader />;
    default:
      return <HomeHeader query={query} onQuery={onQuery} />;
  }
}

function Body({ network, view, query }: { network: Network; view: View; query: string }) {
  switch (view.name) {
    case 'stop':
      return <StopView key={view.stopId} network={network} stopId={view.stopId} />;
    case 'route':
      return <RouteView network={network} routeId={view.routeId} directionId={view.directionId} />;
    case 'vehicle':
      return <VehicleView network={network} vehicleId={view.vehicleId} />;
    case 'alerts':
      return <AlertsView network={network} />;
    case 'about':
      return <AboutView network={network} />;
    default:
      return <HomeView network={network} query={query} />;
  }
}

function titleFor(network: Network, view: View): string {
  const suffix = 'NOLA Transit Live';
  switch (view.name) {
    case 'stop': {
      const stop = network.stopsById.get(view.stopId);
      return stop ? `${stop.name} departures | ${suffix}` : suffix;
    }
    case 'route': {
      const route = network.routesById.get(view.routeId);
      return route ? `${route.shortName} ${route.longName} | ${suffix}` : suffix;
    }
    case 'vehicle':
      return `Vehicle ${view.vehicleId} | ${suffix}`;
    case 'alerts':
      return `Service changes | ${suffix}`;
    case 'about':
      return `About | ${suffix}`;
    default:
      return `${suffix}: live New Orleans buses and streetcars`;
  }
}
