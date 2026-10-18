import type { Route } from '../lib/network.ts';

/**
 * Route number in its colour. Streetcars get a rounded "car" shape and
 * ferries a hull-like base so mode reads before the number does — riders
 * scanning a list look for "the streetcar", not "route 12".
 */
export function RouteBadge({ route, size = 'md' }: { route: Route; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={`badge badge--${size} badge--${route.mode}`}
      style={{ '--route-color': route.color, '--route-text': route.textColor } as React.CSSProperties}
      aria-label={`Route ${route.shortName}`}
    >
      {route.shortName}
    </span>
  );
}
