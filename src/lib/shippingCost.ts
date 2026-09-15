// Estimated FedEx Standard Overnight shipping cost, by destination state,
// from each production location — used by the Growth & Distribution tab to
// show what it would cost (in shipping alone) to move a state's orders from
// one location to the other, alongside that location's CPO difference.
//
// There's no carrier API in this codebase (no EasyPost/ShipStation/etc), so
// this is a formula-based estimate, not a live rate lookup:
//   1. Straight-line ("great-circle") distance from the shipping origin ZIP
//      to the destination state's geographic centroid.
//   2. That distance mapped to a FedEx zone via the standard published
//      distance bands. NOTE: this is an approximation — FedEx's real zone
//      chart is keyed off 3-digit ZIP-code-prefix pairs, not pure radial
//      distance, so a given state can straddle zones depending on exactly
//      where in it the package lands. Close enough for planning; not a
//      substitute for an actual invoice.
//   3. Zone -> published Standard Overnight list rate at a fixed 15 lb DIM
//      weight (Sarah's number for a typical shipped order).
//   4. Her negotiated 78.44% discount off list.
//
// The rate table below is a best-effort snapshot, not pulled from a live
// FedEx rate card — spot-check it against an actual invoice and adjust the
// constants here if it drifts from reality.

export const PACKAGE_WEIGHT_LB = 15;
export const FEDEX_DISCOUNT = 0.7844;

// Ship-from origins (see Sarah's answer: UT 84057, GA 30318).
export const UT_ORIGIN = { lat: 40.30, lon: -111.72 };
export const GA_ORIGIN = { lat: 33.80, lon: -84.42 };

// Approximate geographic centroid (lat, lon) for each US state + DC.
export const STATE_CENTROIDS: Record<string, { lat: number; lon: number }> = {
  AL: { lat: 32.7,  lon: -86.8  },
  AK: { lat: 64.0,  lon: -149.4 },
  AZ: { lat: 34.2,  lon: -111.9 },
  AR: { lat: 34.9,  lon: -92.4  },
  CA: { lat: 37.2,  lon: -119.7 },
  CO: { lat: 39.0,  lon: -105.5 },
  CT: { lat: 41.6,  lon: -72.7  },
  DE: { lat: 39.0,  lon: -75.5  },
  FL: { lat: 28.6,  lon: -82.4  },
  GA: { lat: 32.6,  lon: -83.4  },
  HI: { lat: 20.3,  lon: -156.3 },
  ID: { lat: 44.4,  lon: -114.6 },
  IL: { lat: 40.0,  lon: -89.2  },
  IN: { lat: 39.9,  lon: -86.3  },
  IA: { lat: 42.0,  lon: -93.5  },
  KS: { lat: 38.5,  lon: -98.4  },
  KY: { lat: 37.5,  lon: -85.3  },
  LA: { lat: 31.0,  lon: -92.0  },
  ME: { lat: 45.4,  lon: -69.2  },
  MD: { lat: 39.0,  lon: -76.7  },
  MA: { lat: 42.3,  lon: -71.8  },
  MI: { lat: 44.3,  lon: -85.4  },
  MN: { lat: 46.3,  lon: -94.3  },
  MS: { lat: 32.7,  lon: -89.7  },
  MO: { lat: 38.4,  lon: -92.5  },
  MT: { lat: 47.0,  lon: -109.6 },
  NE: { lat: 41.5,  lon: -99.8  },
  NV: { lat: 39.3,  lon: -116.6 },
  NH: { lat: 43.7,  lon: -71.6  },
  NJ: { lat: 40.2,  lon: -74.7  },
  NM: { lat: 34.4,  lon: -106.1 },
  NY: { lat: 42.9,  lon: -75.5  },
  NC: { lat: 35.5,  lon: -79.4  },
  ND: { lat: 47.5,  lon: -100.5 },
  OH: { lat: 40.3,  lon: -82.8  },
  OK: { lat: 35.6,  lon: -97.5  },
  OR: { lat: 44.0,  lon: -120.6 },
  PA: { lat: 40.9,  lon: -77.7  },
  RI: { lat: 41.7,  lon: -71.5  },
  SC: { lat: 33.9,  lon: -80.9  },
  SD: { lat: 44.4,  lon: -100.3 },
  TN: { lat: 35.9,  lon: -86.3  },
  TX: { lat: 31.5,  lon: -99.3  },
  UT: { lat: 39.3,  lon: -111.7 },
  VT: { lat: 44.0,  lon: -72.7  },
  VA: { lat: 37.5,  lon: -78.8  },
  WA: { lat: 47.4,  lon: -120.7 },
  WV: { lat: 38.6,  lon: -80.6  },
  WI: { lat: 44.6,  lon: -89.9  },
  WY: { lat: 43.0,  lon: -107.5 },
  DC: { lat: 38.9,  lon: -77.0  },
};

// Standard published FedEx distance-to-zone bands (approximation — see
// header comment).
const ZONE_DISTANCE_BANDS: { maxMiles: number; zone: number }[] = [
  { maxMiles: 150,  zone: 2 },
  { maxMiles: 300,  zone: 3 },
  { maxMiles: 600,  zone: 4 },
  { maxMiles: 1000, zone: 5 },
  { maxMiles: 1400, zone: 6 },
  { maxMiles: 1800, zone: 7 },
  { maxMiles: Infinity, zone: 8 },
];

// Best-effort FedEx Standard Overnight LIST rate by zone at 15 lb DIM weight.
// Not sourced from a live rate feed — verify against a current rate card.
const LIST_RATE_BY_ZONE_15LB: Record<number, number> = {
  2: 105,
  3: 111,
  4: 121,
  5: 136,
  6: 151,
  7: 167,
  8: 182,
};

function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function zoneFromDistance(miles: number): number {
  return ZONE_DISTANCE_BANDS.find(b => miles <= b.maxMiles)!.zone;
}

export function netRateForZone(zone: number): number {
  return LIST_RATE_BY_ZONE_15LB[zone] * (1 - FEDEX_DISCOUNT);
}

export interface StateShippingEstimate {
  stateCode:     string;
  distanceUtMi:  number;
  distanceGaMi:  number;
  zoneUt:        number;
  zoneGa:        number;
  costUt:        number; // net $ to ship from Utah to this state
  costGa:        number; // net $ to ship from Georgia to this state
  delta:         number; // costUt - costGa; positive = more expensive to ship from Utah
}

// Returns null for an unrecognized state code.
export function estimateShippingCost(stateCode: string): StateShippingEstimate | null {
  const centroid = STATE_CENTROIDS[stateCode];
  if (!centroid) return null;

  const distanceUtMi = haversineMiles(UT_ORIGIN, centroid);
  const distanceGaMi = haversineMiles(GA_ORIGIN, centroid);
  const zoneUt = zoneFromDistance(distanceUtMi);
  const zoneGa = zoneFromDistance(distanceGaMi);
  const costUt = netRateForZone(zoneUt);
  const costGa = netRateForZone(zoneGa);

  return {
    stateCode, distanceUtMi, distanceGaMi, zoneUt, zoneGa, costUt, costGa,
    delta: costUt - costGa,
  };
}
