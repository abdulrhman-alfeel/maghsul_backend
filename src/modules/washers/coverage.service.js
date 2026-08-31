import ApiError from '../../helpers/apiError.js';

const EARTH_RADIUS_METERS = 6371000;

export function haversineDistance(lat1, lng1, lat2, lng2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export function isPointInBoundingBox(lat, lng, bbMinLat, bbMaxLat, bbMinLng, bbMaxLng) {
  if (bbMinLat === null || bbMinLat === undefined || bbMaxLat === null || bbMaxLat === undefined) return true;
  if (bbMinLng === null || bbMinLng === undefined || bbMaxLng === null || bbMaxLng === undefined) return true;
  return lat >= bbMinLat && lat <= bbMaxLat && lng >= bbMinLng && lng <= bbMaxLng;
}

/**
 * Checks if a point is on a line segment (edge/vertex check)
 */
function isPointOnSegment(lat, lng, p1, p2) {
  const [x1, y1] = [p1[0], p1[1]]; // lng, lat
  const [x2, y2] = [p2[0], p2[1]]; // lng, lat

  // Exact vertex match
  if ((lng === x1 && lat === y1) || (lng === x2 && lat === y2)) return true;

  // Cross product to check collinearity
  const crossProduct = (lat - y1) * (x2 - x1) - (lng - x1) * (y2 - y1);
  if (Math.abs(crossProduct) > 1e-9) return false;

  // Dot product to check bounds
  const dotProduct = (lng - x1) * (x2 - x1) + (lat - y1) * (y2 - y1);
  if (dotProduct < 0) return false;

  const squaredLength = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (dotProduct > squaredLength) return false;

  return true;
}

/**
 * Ray-casting algorithm for a single polygon ring (with edge & vertex detection)
 */
function isPointInSingleRing(lat, lng, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p1 = ring[i];
    const p2 = ring[j];

    // Edge and Vertex check: if point is on edge, it is INSIDE
    if (isPointOnSegment(lat, lng, p1, p2)) return true;

    const xi = Number(p1[0]); // lng
    const yi = Number(p1[1]); // lat
    const xj = Number(p2[0]); // lng
    const yj = Number(p2[1]); // lat

    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Validates point in GeoJSON Polygon (supporting outer boundary and inner hole rings)
 */
function isPointInPolygonRings(lat, lng, rings) {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  const outerRing = rings[0];
  const isInsideOuter = isPointInSingleRing(lat, lng, outerRing);
  if (!isInsideOuter) return false;

  // Check inner hole rings: if inside ANY hole ring, the point is OUTSIDE
  for (let h = 1; h < rings.length; h++) {
    if (isPointInSingleRing(lat, lng, rings[h])) {
      return false; // Point falls inside a hole
    }
  }
  return true;
}

export function isPointInPolygon(lat, lng, geoJson) {
  if (!geoJson) return false;
  const raw = typeof geoJson === 'string' ? JSON.parse(geoJson) : geoJson;
  const type = raw.type || 'Polygon';
  const coords = raw.coordinates || raw;

  if (type === 'MultiPolygon') {
    for (const polyRings of coords) {
      if (isPointInPolygonRings(lat, lng, polyRings)) {
        return true;
      }
    }
    return false;
  }

  return isPointInPolygonRings(lat, lng, coords);
}

export function isPointInZone(lat, lng, zone) {
  if (!zone || zone.isActive === false) return false;

  // Bounding box pre-filter
  if (!isPointInBoundingBox(lat, lng, zone.bbMinLat, zone.bbMaxLat, zone.bbMinLng, zone.bbMaxLng)) {
    return false;
  }

  if (zone.coverageType === 'circle') {
    if (zone.centerLat === null || zone.centerLat === undefined || zone.centerLng === null || zone.centerLng === undefined) {
      return false;
    }
    const dist = haversineDistance(lat, lng, zone.centerLat, zone.centerLng);
    return dist <= (zone.radiusMeters ?? 1500);
  }

  if (zone.coverageType === 'polygon' || zone.coverageType === 'multi_polygon') {
    return isPointInPolygon(lat, lng, zone.geoJson);
  }

  return false;
}

export function validateCoordinates(lat, lng, label = 'Coordinates') {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    throw new ApiError(400, 'invalid_coordinates', `${label} coordinates are required`);
  }
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (Number.isNaN(numLat) || Number.isNaN(numLng) || numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
    throw new ApiError(400, 'invalid_coordinates', `${label} coordinates are out of range`);
  }
  return { lat: numLat, lng: numLng };
}

const SUPPORTED_SERVICE_TYPES = new Set(['piece', 'quantity']);

export function mapRequiredCoordinatesByServiceType(serviceType, pickup, delivery) {
  const st = String(serviceType || '').trim().toLowerCase();

  if (!st || !SUPPORTED_SERVICE_TYPES.has(st)) {
    throw new ApiError(400, 'invalid_service_type', `Unsupported service type: ${serviceType}`);
  }

  if (st === 'piece') {
    if (!pickup) throw new ApiError(400, 'invalid_coordinates', 'Pickup coordinates are required for piece service');
    if (!delivery) throw new ApiError(400, 'invalid_coordinates', 'Delivery coordinates are required for piece service');
    const p = validateCoordinates(pickup.lat, pickup.lng, 'Pickup');
    const d = validateCoordinates(delivery.lat, delivery.lng, 'Delivery');
    return { pickup: p, delivery: d };
  }

  if (st === 'quantity') {
    if (!pickup) throw new ApiError(400, 'invalid_coordinates', 'Pickup coordinates are required for quantity service');
    const p = validateCoordinates(pickup.lat, pickup.lng, 'Pickup');
    const d = delivery && delivery.lat !== undefined && delivery.lng !== undefined
      ? validateCoordinates(delivery.lat, delivery.lng, 'Delivery')
      : null;
    return { pickup: p, delivery: d };
  }

  throw new ApiError(400, 'invalid_service_type', `Unsupported service type: ${serviceType}`);
}

export function validateWasherCoverage(washer, pickup, delivery) {
  if (!washer || !pickup) return;
  const hasLocation = washer.serviceLat !== null && washer.serviceLat !== undefined && washer.serviceLng !== null && washer.serviceLng !== undefined;
  if (!hasLocation) {
    // Unconfigured washer service location fallback: proceed to branch coverage check
    return;
  }

  const radius = washer.serviceRadiusMeters ?? 1500;
  const pickupDist = haversineDistance(pickup.lat, pickup.lng, washer.serviceLat, washer.serviceLng);

  if (pickupDist > radius) {
    throw new ApiError(422, 'WASHER_OUT_OF_COVERAGE', 'Order location is outside washer service area');
  }

  if (delivery && delivery.lat !== undefined && delivery.lng !== undefined) {
    const deliveryDist = haversineDistance(delivery.lat, delivery.lng, washer.serviceLat, washer.serviceLng);
    if (deliveryDist > radius) {
      throw new ApiError(422, 'WASHER_OUT_OF_COVERAGE', 'Order location is outside washer service area');
    }
  }
}

export function evaluateBranchCoverage(branch, zones, pickup, delivery) {
  if (!branch || branch.status !== 'active' || !branch.isOpen || !branch.acceptingOrders) {
    return { isCovered: false, matchedZonePriority: -1, pickupDistance: Infinity };
  }

  const activeZones = (zones || []).filter((z) => z.isActive !== false);
  const inclusionZones = activeZones.filter((z) => z.zoneType === 'inclusion');
  const exclusionZones = activeZones.filter((z) => z.zoneType === 'exclusion');

  // Exclusion Precedence Guarantee: If point falls inside ANY active exclusion zone, branch is rejected immediately
  for (const exZone of exclusionZones) {
    const pEx = isPointInZone(pickup.lat, pickup.lng, exZone);
    const dEx = delivery ? isPointInZone(delivery.lat, delivery.lng, exZone) : false;
    if (pEx || dEx) {
      return { isCovered: false, matchedZonePriority: -1, pickupDistance: Infinity };
    }
  }

  let isCovered = false;
  let matchedZonePriority = 0;
  let zoneCenterLat = branch.lat;
  let zoneCenterLng = branch.lng;

  if (inclusionZones.length > 0) {
    let pickupCovered = false;
    let deliveryCovered = delivery ? false : true;

    for (const incZone of inclusionZones) {
      const pIn = isPointInZone(pickup.lat, pickup.lng, incZone);
      const dIn = delivery ? isPointInZone(delivery.lat, delivery.lng, incZone) : true;

      if (pIn && dIn) {
        pickupCovered = true;
        deliveryCovered = true;
        if ((incZone.priority ?? 0) >= matchedZonePriority) {
          matchedZonePriority = incZone.priority ?? 0;
          if (incZone.centerLat !== null && incZone.centerLat !== undefined) {
            zoneCenterLat = incZone.centerLat;
            zoneCenterLng = incZone.centerLng;
          }
        }
      } else {
        if (pIn) pickupCovered = true;
        if (dIn) deliveryCovered = true;
        matchedZonePriority = Math.max(matchedZonePriority, incZone.priority ?? 0);
      }
    }
    isCovered = pickupCovered && deliveryCovered;
  } else {
    // FAIL_CLOSED Policy: If no explicit inclusion zones are configured, the branch covers NOTHING.
    isCovered = false;
    matchedZonePriority = -1;
  }

  if (!isCovered) {
    return { isCovered: false, matchedZonePriority: -1, pickupDistance: Infinity };
  }

  const refLat = zoneCenterLat ?? pickup.lat;
  const refLng = zoneCenterLng ?? pickup.lng;
  const pickupDistance = haversineDistance(pickup.lat, pickup.lng, refLat, refLng);

  return { isCovered: true, matchedZonePriority, pickupDistance };
}

export function selectBestBranch(branchCandidates, pickupLat, pickupLng) {
  if (!Array.isArray(branchCandidates) || branchCandidates.length === 0) {
    return null;
  }

  const validCandidates = branchCandidates.filter((c) => c.evalResult.isCovered);
  if (validCandidates.length === 0) return null;

  validCandidates.sort((a, b) => {
    // 1. matchedZonePriority DESC
    if (b.evalResult.matchedZonePriority !== a.evalResult.matchedZonePriority) {
      return b.evalResult.matchedZonePriority - a.evalResult.matchedZonePriority;
    }
    // 2. pickupDistance ASC
    if (a.evalResult.pickupDistance !== b.evalResult.pickupDistance) {
      return a.evalResult.pickupDistance - b.evalResult.pickupDistance;
    }
    // 3. branch.sortOrder ASC
    const sA = a.branch.sortOrder ?? 0;
    const sB = b.branch.sortOrder ?? 0;
    if (sA !== sB) {
      return sA - sB;
    }
    // 4. branch.id ASC (Deterministic Tie-Breaker)
    return String(a.branch.id).localeCompare(String(b.branch.id));
  });

  return validCandidates[0].branch;
}

const CoverageService = {
  haversineDistance,
  isPointInBoundingBox,
  isPointInPolygon,
  isPointInZone,
  validateCoordinates,
  mapRequiredCoordinatesByServiceType,
  validateWasherCoverage,
  evaluateBranchCoverage,
  selectBestBranch
};

export default CoverageService;
