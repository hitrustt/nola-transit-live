/**
 * Vehicle markers as real <button>s positioned by MapLibre, so they can be
 * focused, read by screen readers and styled with CSS.
 *
 * When a new snapshot arrives each marker glides from where it is drawn now
 * to its new position along the route shape over ANIMATION_MS. Between
 * snapshots markers stay put: extrapolating would show riders a position
 * nobody reported.
 */

import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibre } from 'maplibre-gl';
import { modeNoun } from '../lib/format.ts';
import { interpolate, STALE_POSITION_MS, type TrackedVehicle } from '../lib/vehicles.ts';

const ANIMATION_MS = 1400;

interface MarkerState {
  marker: maplibregl.Marker;
  /** MapLibre positions this wrapper with `transform`; it must never be scaled. */
  wrapper: HTMLDivElement;
  element: HTMLButtonElement;
  arrow: HTMLSpanElement;
  /** What is drawn right now (mid-animation positions included). */
  drawn: TrackedVehicle;
  target: TrackedVehicle;
}

export interface VehicleMarkerOptions {
  onSelect: (vehicleId: string) => void;
}

export class VehicleMarkers {
  private markers = new Map<string, MarkerState>();
  private frame = 0;
  private animationStart = 0;
  private focusRouteId: string | null = null;
  private selectedId: string | null = null;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private map: MapLibre;
  private options: VehicleMarkerOptions;

  constructor(map: MapLibre, options: VehicleMarkerOptions) {
    this.map = map;
    this.options = options;
  }

  update(vehicles: ReadonlyMap<string, TrackedVehicle>, now: number) {
    for (const [id, state] of this.markers) {
      if (!vehicles.has(id)) {
        state.marker.remove();
        this.markers.delete(id);
      }
    }

    for (const vehicle of vehicles.values()) {
      const existing = this.markers.get(vehicle.id);
      if (existing) {
        // Start from what is on screen, so a mid-flight update never jumps.
        existing.drawn = { ...existing.target, ...this.positionAt(existing, this.progress()) };
        existing.target = vehicle;
        this.describe(existing, now);
      } else {
        this.markers.set(vehicle.id, this.create(vehicle, now));
      }
    }

    this.animationStart = performance.now();
    this.restyle();
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Refresh "updated N sec ago" labels and staleness without moving anything. */
  refreshLabels(now: number) {
    for (const state of this.markers.values()) this.describe(state, now);
  }

  setFocus(routeId: string | null, selectedVehicleId: string | null) {
    this.focusRouteId = routeId;
    this.selectedId = selectedVehicleId;
    this.restyle();
  }

  getPosition(vehicleId: string): [number, number] | null {
    const state = this.markers.get(vehicleId);
    if (!state) return null;
    return this.positionAt(state, this.progress()).position;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    for (const state of this.markers.values()) state.marker.remove();
    this.markers.clear();
  }

  // -------------------------------------------------------------------------

  private progress(): number {
    if (this.reducedMotion.matches) return 1;
    const t = Math.min(1, (performance.now() - this.animationStart) / ANIMATION_MS);
    return 1 - (1 - t) ** 3; // ease-out
  }

  private positionAt(state: MarkerState, t: number) {
    return interpolate(state.drawn, state.target, t);
  }

  private tick = () => {
    const t = this.progress();
    const bearing = this.map.getBearing();

    for (const state of this.markers.values()) {
      const { position, heading } = this.positionAt(state, t);
      state.marker.setLngLat([position[1], position[0]]);
      state.arrow.style.transform = `rotate(${heading - bearing}deg)`;
    }

    if (t < 1) this.frame = requestAnimationFrame(this.tick);
  };

  private create(vehicle: TrackedVehicle, now: number): MarkerState {
    // The wrapper takes MapLibre's positioning transform. Size and emphasis
    // changes go on the inner button: scaling the positioned element would
    // scale its translation too and throw it across the map.
    const wrapper = document.createElement('div');
    wrapper.className = 'vehicle-marker';
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'vehicle';
    wrapper.append(element);
    const arrow = document.createElement('span');
    arrow.className = 'vehicle__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'vehicle__label';
    element.append(arrow, label);
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      this.options.onSelect(vehicle.id);
    });

    const marker = new maplibregl.Marker({ element: wrapper, anchor: 'center' })
      .setLngLat([vehicle.position[1], vehicle.position[0]])
      .addTo(this.map);

    const state: MarkerState = { marker, wrapper, element, arrow, drawn: vehicle, target: vehicle };
    this.describe(state, now);
    return state;
  }

  private describe(state: MarkerState, now: number) {
    const vehicle = state.target;
    const { route } = vehicle;
    const label = state.element.lastElementChild as HTMLSpanElement;
    label.textContent = route.shortName;
    state.element.style.setProperty('--route-color', route.color);
    state.element.style.setProperty('--route-text', route.textColor);
    state.element.dataset.mode = route.mode;
    state.element.dataset.route = route.id;

    const age = Math.max(0, now - vehicle.timestamp);
    const stale = age > STALE_POSITION_MS;
    state.element.classList.toggle('is-stale', stale);
    const seconds = Math.round(age / 1000);
    const when = seconds < 60 ? `${seconds} seconds ago` : `${Math.round(seconds / 60)} minutes ago`;
    state.element.setAttribute(
      'aria-label',
      `Route ${route.shortName} ${modeNoun(route.mode)} to ${vehicle.headsign}, position from ${when}`,
    );
  }

  private restyle() {
    for (const [id, state] of this.markers) {
      const dimmed = this.focusRouteId !== null && state.target.route.id !== this.focusRouteId;
      state.element.classList.toggle('is-dimmed', dimmed);
      state.element.classList.toggle('is-focus', this.focusRouteId !== null && !dimmed);
      state.element.classList.toggle('is-selected', id === this.selectedId);
      state.element.tabIndex = dimmed ? -1 : 0;
      // Keep the selected and focused-route markers above the rest.
      state.wrapper.style.zIndex = id === this.selectedId ? '3' : dimmed ? '1' : '2';
    }
  }
}
