const BUSTIME_URL =
  'https://bustime.norta.com/bustime/map/getBusesForRouteAll.jsp';

export async function onRequestGet() {
  try {
    const upstream = await fetch(BUSTIME_URL, {
      headers: {
        Accept: 'text/xml,application/xml,text/plain,*/*',
        'User-Agent': 'nola-transit-live/1.0',
      },
      cf: {
        cacheTtl: 5,
        cacheEverything: false,
      },
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Upstream vehicle request failed with status ${upstream.status}` },
        { status: upstream.status },
      );
    }

    return new Response(await upstream.text(), {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=5',
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: 'Failed to fetch live vehicle data',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
