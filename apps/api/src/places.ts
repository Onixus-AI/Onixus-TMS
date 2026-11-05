import zipcodes from "zipcodes";
import { greatCircleMiles, ROAD_FACTOR } from "@onixus/core";

// Turns what a rate request says ("Ashland, VA 23005", "Greensboro, NC", "23703") into a point,
// using the bundled US ZIP code centroids. No network call and no API key. A place that cannot
// be placed returns null and the quote says so; nothing is guessed.

export type Place = { zip: string; city: string; state: string; lat: number; lng: number };

const STATES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"]);

type Z = { zip: string; latitude: number; longitude: number; city: string; state: string; country: string };
const asPlace = (z: Z | undefined | null): Place | null =>
  z && z.country === "US" && Number.isFinite(z.latitude) && Number.isFinite(z.longitude) ? { zip: z.zip, city: z.city, state: z.state, lat: z.latitude, lng: z.longitude } : null;

export function placeOf(text: string): Place | null {
  const t = text.trim();
  if (!t || t.length > 300) return null;
  // A US ZIP is the most precise thing a request carries. Street numbers are five digits too, so
  // prefer the ZIP right after a state code ("VA 23005"), then the last five-digit number.
  const afterState = [...t.matchAll(/\b([A-Za-z]{2})[,.\s]+(\d{5})(?:-\d{4})?\b/g)].filter((m) => STATES.has(m[1].toUpperCase())).map((m) => m[2]);
  const anyZip = [...t.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].map((m) => m[1]);
  for (const zip of [...afterState.reverse(), ...anyZip.reverse()]) { const p = asPlace(zipcodes.lookup(zip) as Z); if (p) return p; }
  // "City, ST" (or "City ST"): the first ZIP the city has.
  const m = /([A-Za-z][A-Za-z .'-]{1,60}?)[,\s]+([A-Za-z]{2})\b/.exec(t);
  if (m && STATES.has(m[2].toUpperCase())) {
    const found = zipcodes.lookupByName(m[1].trim(), m[2].toUpperCase()) as Z[];
    const p = asPlace(found?.[0]);
    if (p) return p;
  }
  return null;
}

/** Estimated road miles between two places (straight line × the planning road factor). */
export function estimatedMiles(a: Place, b: Place): number {
  return Math.round(greatCircleMiles(a, b) * ROAD_FACTOR);
}
