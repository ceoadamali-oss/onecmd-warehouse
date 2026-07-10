/** ~300m — mobile GPS indoors often drifts beyond 100m of storefront coords */
export const GEOFENCE_RADIUS_KM = 0.3;

export const STORE_LOCATIONS = [
  { id: 'moncton', name: 'Tire King Moncton', lat: 46.1389, lng: -64.8488 },
  { id: 'oromocto', name: 'Tire King Oromocto', lat: 45.8398, lng: -66.4767 },
  { id: 'fredericton', name: 'Tire King Fredericton', lat: 45.9389, lng: -66.6656 },
  { id: 'saint-john', name: 'Tire King Saint John', lat: 45.2889, lng: -66.0547 },
  { id: 'otown', name: "Tire King O'Town Auto", lat: 45.8312, lng: -66.4923 },
] as const;

export type StoreId = (typeof STORE_LOCATIONS)[number]['id'];

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function getPremisesStatus(lat: number, lng: number, preferredStoreId?: string | null) {
  if (preferredStoreId) {
    const selected = STORE_LOCATIONS.find((s) => s.id === preferredStoreId);
    if (selected) {
      const selectedDist = distanceKm(lat, lng, selected.lat, selected.lng);
      return {
        isOnPremises: selectedDist <= GEOFENCE_RADIUS_KM,
        nearestStore: selected,
        distanceKm: selectedDist,
      };
    }
  }

  let nearest: (typeof STORE_LOCATIONS)[number] = STORE_LOCATIONS[0];
  let nearestDist = distanceKm(lat, lng, nearest.lat, nearest.lng);

  for (const store of STORE_LOCATIONS) {
    const dist = distanceKm(lat, lng, store.lat, store.lng);
    if (dist < nearestDist) {
      nearest = store;
      nearestDist = dist;
    }
  }

  return {
    isOnPremises: nearestDist <= GEOFENCE_RADIUS_KM,
    nearestStore: nearest,
    distanceKm: nearestDist,
  };
}

export function isCatalogImageMissing(image: string | null | undefined): boolean {
  if (!image) return true;
  const trimmed = image.trim();
  return trimmed === '' || trimmed === 'null' || trimmed === 'undefined';
}
