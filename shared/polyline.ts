/**
 * Google encoded-polyline format (precision 5, ~1 m). Pattern shapes ship in
 * this form because it is roughly a quarter the size of a JSON number array
 * and decodes in a single pass.
 */

export type LatLng = [lat: number, lng: number];

export function encodePolyline(points: readonly LatLng[], precision = 5): string {
  const factor = 10 ** precision;
  let output = '';
  let previousLat = 0;
  let previousLng = 0;

  for (const [lat, lng] of points) {
    const scaledLat = Math.round(lat * factor);
    const scaledLng = Math.round(lng * factor);
    output += encodeValue(scaledLat - previousLat) + encodeValue(scaledLng - previousLng);
    previousLat = scaledLat;
    previousLng = scaledLng;
  }

  return output;
}

function encodeValue(value: number): string {
  let shifted = value < 0 ? ~(value << 1) : value << 1;
  let output = '';

  while (shifted >= 0x20) {
    output += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
    shifted >>= 5;
  }

  return output + String.fromCharCode(shifted + 63);
}

export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    for (let axis = 0; axis < 2; axis += 1) {
      let result = 0;
      let shift = 0;
      let byte: number;

      do {
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);

      const delta = result & 1 ? ~(result >> 1) : result >> 1;

      if (axis === 0) {
        lat += delta;
      } else {
        lng += delta;
      }
    }

    points.push([lat / factor, lng / factor]);
  }

  return points;
}
