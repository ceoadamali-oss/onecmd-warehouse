const STORES = [
  { id: 'moncton', lat: 46.1389, lng: -64.8488 },
  { id: 'oromocto', lat: 45.8398, lng: -66.4767 },
  { id: 'fredericton', lat: 45.9389, lng: -66.6656 },
  { id: 'saint-john', lat: 45.2889, lng: -66.0547 },
  { id: 'otown', lat: 45.8312, lng: -66.4923 },
];

const RADIUS_KM = 0.3;

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function assertOnPremises(lat, lng, { skip = false } = {}) {
  if (skip) {
    return { ok: true, storeId: 'moncton', skipped: true };
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: 'Location verification is required for this action.' };
  }

  let nearest = STORES[0];
  let nearestDist = distanceKm(latitude, longitude, nearest.lat, nearest.lng);
  for (const store of STORES) {
    const dist = distanceKm(latitude, longitude, store.lat, store.lng);
    if (dist < nearestDist) {
      nearest = store;
      nearestDist = dist;
    }
  }

  if (nearestDist > RADIUS_KM) {
    return { ok: false, error: 'This action is only available at authorized shop locations.' };
  }

  return { ok: true, storeId: nearest.id };
}
