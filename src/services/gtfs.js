const NETWORK_URL = `${import.meta.env.BASE_URL}data/norta-network.json`;

let networkPromise;

function cloneRoute(route) {
  const patterns = route.patterns.map((pattern) => pattern.map(([lat, lng]) => [lat, lng]));

  return {
    ...route,
    patterns,
    shape: patterns[0] ?? [],
    stopIds: [...route.stopIds],
    terminals: [...(route.terminals ?? [])],
  };
}

function cloneStop(stop) {
  return {
    ...stop,
    routes: [...stop.routes],
  };
}

async function loadNetwork() {
  if (!networkPromise) {
    networkPromise = fetch(NETWORK_URL, {
      cache: 'force-cache',
      headers: {
        Accept: 'application/json',
      },
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load NORTA static feed data (${response.status})`);
      }

      return response.json();
    });
  }

  return networkPromise;
}

export async function getTransitFeed() {
  const network = await loadNetwork();

  return {
    routes: network.routes.map(cloneRoute),
    stops: network.stops.map(cloneStop),
  };
}

export async function getRoutes() {
  const network = await loadNetwork();
  return network.routes.map(cloneRoute);
}

export async function getStops() {
  const network = await loadNetwork();
  return network.stops.map(cloneStop);
}
