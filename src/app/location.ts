/**
 * The rider's location, only after they ask for it. Never requested on load:
 * a permission prompt before the rider has done anything gets denied, and
 * denial is hard to undo.
 */

import type { LatLng } from '../../shared/polyline.ts';
import { createStore, useStore } from './store.ts';

export type LocationState =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'ready'; position: LatLng; accuracy: number; timestamp: number }
  | { status: 'denied' }
  | { status: 'unavailable'; message: string };

export const locationStore = createStore<LocationState>({ status: 'idle' });

let watchId: number | null = null;

export function requestLocation() {
  if (!('geolocation' in navigator)) {
    locationStore.set({ status: 'unavailable', message: 'This browser cannot share your location.' });
    return;
  }

  if (watchId !== null) return;
  if (locationStore.get().status !== 'ready') locationStore.set({ status: 'locating' });

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      locationStore.set({
        status: 'ready',
        position: [position.coords.latitude, position.coords.longitude],
        accuracy: position.coords.accuracy,
        timestamp: position.timestamp,
      });
    },
    (error) => {
      stopLocation();
      if (error.code === error.PERMISSION_DENIED) {
        locationStore.set({ status: 'denied' });
      } else {
        locationStore.set({ status: 'unavailable', message: 'Your location could not be found. Try again outdoors or check location settings.' });
      }
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
  );
}

export function stopLocation() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

export function useLocation(): LocationState {
  return useStore(locationStore);
}

// Resume quietly on later visits if permission was already granted.
if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((status) => {
      if (status.state === 'granted') requestLocation();
    })
    .catch(() => undefined);
}
