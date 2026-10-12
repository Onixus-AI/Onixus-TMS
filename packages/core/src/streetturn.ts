// Street turns: instead of hauling an import's empty back to the port and
// pulling a fresh empty for an export, reuse the import's container for a
// nearby export on the same steamship line. It saves two port trips and
// stops per diem. The line still has to approve each one.

export type GeoPoint = { lat: number; lng: number };

/** Great-circle distance in miles. */
export function milesBetween(a: GeoPoint, b: GeoPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

export type StreetTurnLoad = {
  id: string;
  equipment_type: string;
  direction?: string | null;
  status?: string | null;
  steamship_line_id?: string | null;
  container_number?: string | null;
  container_size?: string | null;
  container_type?: string | null;
  outgated_at?: string | null;
  empty_returned_at?: string | null;
  is_street_turn?: boolean | null;
  pickup_location_id?: string | null;
  delivery_location_id?: string | null;
};

export type StreetTurnMatch = { importLoadId: string; exportLoadId: string; containerNumber: string; miles: number };

/** An import whose container has been emptied at the consignee and is waiting to go back. */
export function isEmptyImport(l: StreetTurnLoad): boolean {
  return l.equipment_type === "CONTAINER" && l.direction === "IMPORT" && !!l.container_number && !!l.outgated_at && !l.empty_returned_at && !l.is_street_turn
    && ["AT_DELIVERY", "DELIVERED", "POD_RECEIVED", "INVOICED"].includes(l.status ?? "");
}

/** An export that still needs an empty container. */
export function needsEmpty(l: StreetTurnLoad): boolean {
  return l.equipment_type === "CONTAINER" && l.direction === "EXPORT" && !l.container_number && !l.is_street_turn && ["BOOKED", "PLANNED"].includes(l.status ?? "");
}

/**
 * Pair empty imports with exports that need an empty: same line, same size
 * and type, and the export's shipper (its pickup) within `radiusMiles` of
 * the import's consignee (its delivery). Closest pairs first; each load is
 * used at most once.
 */
export function streetTurnMatches(loads: StreetTurnLoad[], locations: Map<string, GeoPoint>, radiusMiles = 50): StreetTurnMatch[] {
  const imports = loads.filter(isEmptyImport);
  const exports = loads.filter(needsEmpty);
  const pairs: StreetTurnMatch[] = [];
  for (const imp of imports) {
    const from = imp.delivery_location_id ? locations.get(imp.delivery_location_id) : undefined;
    if (!from || !imp.steamship_line_id) continue;
    for (const exp of exports) {
      if (exp.steamship_line_id !== imp.steamship_line_id || exp.container_size !== imp.container_size) continue;
      if ((exp.container_type ?? "GP") !== (imp.container_type ?? "GP")) continue;
      const to = exp.pickup_location_id ? locations.get(exp.pickup_location_id) : undefined;
      if (!to) continue;
      const miles = milesBetween(from, to);
      if (miles <= radiusMiles) pairs.push({ importLoadId: imp.id, exportLoadId: exp.id, containerNumber: imp.container_number!, miles: Math.round(miles * 10) / 10 });
    }
  }
  pairs.sort((a, b) => a.miles - b.miles);
  const used = new Set<string>();
  return pairs.filter((p) => {
    if (used.has(p.importLoadId) || used.has(p.exportLoadId)) return false;
    used.add(p.importLoadId).add(p.exportLoadId);
    return true;
  });
}
