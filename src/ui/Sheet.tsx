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

  const onPointerDown = (event: React.PointerEvent) => {
    // Let buttons and inputs in the header work normally.
    if ((event.target as HTMLElement).closest('input, a, button:not(.sheet__handle)')) return;
    drag.current = { startY: event.clientY, startOffset: offset, lastY: event.clientY, lastT: event.timeStamp, velocity: 0, offset: null };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const dy = event.clientY - state.startY;
    if (Math.abs(dy) < 4 && state.offset === null) return;
    const dt = Math.max(1, event.timeStamp - state.lastT);
    state.velocity = (event.clientY - state.lastY) / dt;
    state.lastY = event.clientY;
    state.lastT = event.timeStamp;
    state.offset = Math.min(height - PEEK_PX + 24, Math.max(-8, state.startOffset + dy));
    setDragOffset(state.offset);
  };

  /**
   * Ends a drag from pointerup, pointercancel or lost capture. Reads the drag
   * from the ref, not render state: a cancel can arrive before React has
   * re-rendered with the first move, and a stale "not dragging" there left the
   * sheet stuck mid-drag.
   */
  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.offset === null) return;

    // Project where a flick would come to rest, then pick the nearest snap.
    const projected = state.offset + state.velocity * 180;
    const candidates: Snap[] = ['full', 'half', 'peek'];
    const best = candidates.reduce((closest, candidate) =>
      Math.abs(height - visibleFor(candidate) - projected) < Math.abs(height - visibleFor(closest) - projected) ? candidate : closest,
    );
    setDragOffset(null);
    onSnapChange(best);
  };

  const cycle = () => onSnapChange(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'half');

  return (
    <aside
      ref={ref}
      className={`sheet sheet--${snap}${dragOffset !== null ? ' is-dragging' : ''}`}
      style={{ height, transform: `translate3d(0, ${offset}px, 0)` }}
      aria-label="Transit information"
    >
      <div
        className="sheet__grab"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // If the pointer leaves the window mid-drag the browser may never send
        // pointerup; losing capture still ends the drag so the sheet settles.
        onLostPointerCapture={onPointerUp}
      >
        <button
          type="button"
          className="sheet__handle"
          onClick={cycle}
          aria-label={snap === 'full' ? 'Show more map' : 'Expand panel'}
        />
        <div className="panel__header">{header}</div>
      </div>
      <div className="panel__body" style={{ paddingBottom: Math.max(0, offset) + 16 }}>
        {children}
        {/* Off-screen space below the sheet would hide a pinned footer; it scrolls with content instead. */}
        {footer && <div className="panel__footer panel__footer--inline">{footer}</div>}
      </div>
    </aside>
  );
}
