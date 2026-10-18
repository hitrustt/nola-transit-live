import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type Snap = 'peek' | 'half' | 'full';

interface SheetProps {
  compact: boolean;
  snap: Snap;
  onSnapChange: (snap: Snap) => void;
  /** Visible height in px, so the map can keep its centre above the sheet. */
  onVisibleHeight: (height: number) => void;
  header: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

const PEEK_PX = 132;
const TOP_GAP_PX = 64;

/**
 * Desktop: a fixed side panel. Phone: a bottom sheet with three resting
 * heights. It is dragged by its header, and the handle is also a button
 * (tap to cycle, or use the keyboard) so it never requires a gesture.
 */
export function Sheet({ compact, snap, onSnapChange, onVisibleHeight, header, children, footer }: SheetProps) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{
    startY: number;
    startOffset: number;
    lastY: number;
    lastT: number;
    velocity: number;
    /** Current dragged offset, or null until the pointer has moved enough to count as a drag. */
    offset: number | null;
  } | null>(null);
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  const [dragOffset, setDragOffset] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setViewport(window.visualViewport?.height ?? window.innerHeight);
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  const height = viewport - TOP_GAP_PX;
  const visibleFor = useCallback(
    (value: Snap) => (value === 'peek' ? PEEK_PX : value === 'half' ? Math.round(viewport * 0.5) : height),
    [viewport, height],
  );
  const restingOffset = height - visibleFor(snap);
  const offset = dragOffset ?? restingOffset;
  const latest = useRef({ height, visibleFor, onSnapChange });
  latest.current = { height, visibleFor, onSnapChange };
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    onVisibleHeight(compact ? Math.min(visibleFor(snap), Math.round(viewport * 0.5)) : 0);
  }, [compact, snap, viewport, visibleFor, onVisibleHeight]);

  if (!compact) {
    return (
      <aside ref={ref} className="panel" aria-label="Transit information">
        <div className="panel__header">{header}</div>
        <div className="panel__body">{children}</div>
        {footer && <div className="panel__footer">{footer}</div>}
      </aside>
    );
  }

  // The gesture is followed on the window, not the header: a quick flick
  // leaves the header on its first move, and pointer capture (the usual fix)
  // retargets clicks so the handle button stops working with a mouse.
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // Let buttons and inputs in the header work normally.
    if ((event.target as HTMLElement).closest('input, a, button:not(.sheet__handle)')) return;
    drag.current = { startY: event.clientY, startOffset: offset, lastY: event.clientY, lastT: event.timeStamp, velocity: 0, offset: null };

    const move = (moveEvent: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const dy = moveEvent.clientY - state.startY;
      if (Math.abs(dy) < 4 && state.offset === null) return;
      const dt = Math.max(1, moveEvent.timeStamp - state.lastT);
      state.velocity = (moveEvent.clientY - state.lastY) / dt;
      state.lastY = moveEvent.clientY;
      state.lastT = moveEvent.timeStamp;
      const { height: currentHeight } = latest.current;
      state.offset = Math.min(currentHeight - PEEK_PX + 24, Math.max(-8, state.startOffset + dy));
      setDragOffset(state.offset);
    };

    // Ends the drag. Reads it from the ref, not render state: a cancel can
    // arrive before React re-renders with the first move.
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const state = drag.current;
      drag.current = null;
      if (!state || state.offset === null) return;

      // The click that may follow this pointerup fires before the timeout.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      const { height: currentHeight, visibleFor: visible, onSnapChange: change } = latest.current;
      // Project where a flick would come to rest, then pick the nearest snap.
      const projected = state.offset + state.velocity * 180;
      const candidates: Snap[] = ['full', 'half', 'peek'];
      const best = candidates.reduce((closest, candidate) =>
        Math.abs(currentHeight - visible(candidate) - projected) < Math.abs(currentHeight - visible(closest) - projected)
          ? candidate
          : closest,
      );
      setDragOffset(null);
      change(best);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  // Keyboard focus can move into the part of the sheet that is below the
  // screen; open the sheet fully so the focused control is visible.
  const revealFocused = (event: React.FocusEvent) => {
    if (snap === 'full') return;
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    if (rect.bottom > (window.visualViewport?.height ?? window.innerHeight)) onSnapChange('full');
  };

  const cycle = () => {
    // A drag that ends over the handle also produces a click; ignore it.
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onSnapChange(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'half');
  };

  return (
    <aside
      ref={ref}
      className={`sheet sheet--${snap}${dragOffset !== null ? ' is-dragging' : ''}`}
      style={{ height, transform: `translate3d(0, ${offset}px, 0)` }}
      aria-label="Transit information"
    >
      <div className="sheet__grab" onPointerDown={onPointerDown}>
        <button
          type="button"
          className="sheet__handle"
          onClick={cycle}
          aria-label={snap === 'full' ? 'Show more map' : 'Expand panel'}
        />
        <div className="panel__header">{header}</div>
      </div>
      <div className="panel__body" style={{ paddingBottom: Math.max(0, offset) + 16 }} onFocus={revealFocused}>
        {children}
        {/* Off-screen space below the sheet would hide a pinned footer; it scrolls with content instead. */}
        {footer && <div className="panel__footer panel__footer--inline">{footer}</div>}
      </div>
    </aside>
  );
}
