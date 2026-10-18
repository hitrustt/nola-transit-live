/**
 * Icons drawn on a 20px grid with 1.75px strokes, to sit with Atkinson
 * Hyperlegible's stroke weight. Decorative by default; pass `label` when an
 * icon is the only content of a control.
 */

const PATHS = {
  back: 'M12.5 4.5 7 10l5.5 5.5',
  close: 'M5.5 5.5l9 9m0-9-9 9',
  search: 'M8.75 14.5a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5Zm4.15-1.6L17 17',
  plus: 'M10 4.5v11M4.5 10h11',
  minus: 'M4.5 10h11',
  locate: 'M10 2.5v2.5m0 10v2.5M2.5 10H5m10 0h2.5M10 14.25a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Z',
  star: 'm10 3 2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.8l-4.3 2.3.9-4.8L3.1 8l4.8-.6L10 3Z',
  share: 'M10 12.5V3m0 0L6.75 6.25M10 3l3.25 3.25M5 9.5H4.5v7h11v-7H15',
  alert: 'M10 3.5 17.5 16.5h-15L10 3.5Zm0 5v3.5m0 2.25v.25',
  detour: 'M4 16V9.5a3 3 0 0 1 3-3h6m0 0-2.5-2.5M13 6.5 10.5 9M16 4v12',
  moon: 'M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1Z',
  sun: 'M10 13.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM10 2.5v1.75m0 11.5v1.75M2.5 10h1.75m11.5 0h1.75M4.7 4.7l1.25 1.25m8.1 8.1 1.25 1.25m0-10.6-1.25 1.25m-8.1 8.1L4.7 15.3',
  info: 'M10 17.25a7.25 7.25 0 1 0 0-14.5 7.25 7.25 0 0 0 0 14.5ZM10 9v4.75M10 6.25v.25',
  chevron: 'm7.5 4.5 5.5 5.5-5.5 5.5',
  swap: 'M5.5 7.5h10m0 0-3-3m3 3-3 3M14.5 12.5h-10m0 0 3 3m-3-3 3-3',
  refresh: 'M15.75 9.5a5.75 5.75 0 1 1-1.7-4.1M15.75 3.75V7.5H12',
  offline: 'M3 3l14 14M7.3 12.6a3.8 3.8 0 0 1 5.4 0M4.6 9.8a7.6 7.6 0 0 1 3-1.8m4.7.1a7.6 7.6 0 0 1 3.1 1.7M2 7a11.4 11.4 0 0 1 3-2m4.2-1a11.4 11.4 0 0 1 8.8 3M10 16v.25',
  walk: 'M10.5 4.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5ZM8 18l1.5-5.5L12 15v3M7 9.5l2-3.5h2.5l1.5 3 2 1M9.5 12.5 8.5 9',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, label, size = 20, className }: { name: IconName; label?: string; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * The realtime mark: two arcs radiating from a dot. Shown next to a time
 * that comes from a vehicle's reported position rather than the timetable.
 */
export function LiveMark({ title = 'Live prediction' }: { title?: string }) {
  return (
    <svg className="live-mark" width="12" height="12" viewBox="0 0 12 12" role="img" aria-label={title}>
      <circle cx="2.5" cy="9.5" r="1.5" fill="currentColor" />
      <path className="live-mark__inner" d="M2.5 5.75a3.75 3.75 0 0 1 3.75 3.75" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path className="live-mark__outer" d="M2.5 2a7.5 7.5 0 0 1 7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
