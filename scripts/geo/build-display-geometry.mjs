/**
 * scripts/geo/build-display-geometry.mjs
 *
 * Phase GEO-2A — Display Geometry Builder & Benchmarking
 *
 * Generates an optimized, simplified GeoJSON dataset tailored for mobile map rendering (React Native Maps)
 * from the canonical Riyadh City neighborhood boundaries (data/geo/riyadh_neighborhoods.geojson).
 *
 * Usage:
 *   node scripts/geo/build-display-geometry.mjs [--tolerance=10]
 */

import { readFileSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CANONICAL_PATH = join(__dirname, '../../data/geo/riyadh_neighborhoods.geojson');
const DISPLAY_OUT_PATH = join(__dirname, '../../data/geo/riyadh_neighborhoods_display.json');
const DISPLAY_META_PATH = join(__dirname, '../../data/geo/riyadh_neighborhoods_display.meta.json');

// Parse CLI tolerance argument (meters)
const args = process.argv.slice(2);
let toleranceMeters = 10;
for (const arg of args) {
  if (arg.startsWith('--tolerance=')) {
    toleranceMeters = parseFloat(arg.split('=')[1]) || 10;
  }
}

// ── Douglas-Peucker Simplification ──────────────────────────────────────────

function sqDistance(p1, p2) {
  const dx = p1[0] - p2[0];
  const dy = p1[1] - p2[1];
  return dx * dx + dy * dy;
}

function getSqSegDist(p, p1, p2) {
  let x = p1[0], y = p1[1];
  let dx = p2[0] - x, dy = p2[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = p2[0];
      y = p2[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplifyDPStep(points, first, last, sqTolerance, simplified) {
  let maxSqDist = sqTolerance;
  let index = -1;
  for (let i = first + 1; i < last; i++) {
    const sqDist = getSqSegDist(points[i], points[first], points[last]);
    if (sqDist > maxSqDist) {
      index = i;
      maxSqDist = sqDist;
    }
  }
  if (maxSqDist > sqTolerance) {
    if (index - first > 1) simplifyDPStep(points, first, index, sqTolerance, simplified);
    simplified.push(points[index]);
    if (last - index > 1) simplifyDPStep(points, index, last, sqTolerance, simplified);
  }
}

function simplifyRing(points, sqTolerance) {
  if (points.length <= 4) return points;
  const isClosed = points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
  const pts = isClosed ? points.slice(0, -1) : points;

  // Split ring at farthest point to handle closed loops properly
  let maxD = 0;
  let splitIdx = 1;
  for (let i = 1; i < pts.length; i++) {
    const d = sqDistance(pts[0], pts[i]);
    if (d > maxD) {
      maxD = d;
      splitIdx = i;
    }
  }

  const half1 = [pts[0]];
  simplifyDPStep(pts, 0, splitIdx, sqTolerance, half1);
  half1.push(pts[splitIdx]);

  const half2 = [];
  simplifyDPStep(pts, splitIdx, pts.length - 1, sqTolerance, half2);
  half2.push(pts[pts.length - 1]);

  let res = half1.concat(half2);
  if (isClosed) res.push(res[0]);

  // Ensure closed ring has at least 4 coordinate pairs (GeoJSON standard)
  if (res.length < 4) return points;
  return res;
}

// ── Bounding Box and Centroid Calculation ───────────────────────────────────

function computeBBox(coordinates) {
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;

  for (const ring of coordinates) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}

function computeCentroid(outerRing) {
  // Polygon centroid using Shoelace formula
  let area = 0;
  let cx = 0;
  let cy = 0;
  const n = outerRing.length;

  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = outerRing[i];
    const [x1, y1] = outerRing[i + 1];
    const a = x0 * y1 - x1 * y0;
    area += a;
    cx += (x0 + x1) * a;
    cy += (y0 + y1) * a;
  }
  area = area * 0.5;
  if (Math.abs(area) < 1e-12) {
    // Fallback to bounding box center
    return {
      lng: (outerRing[0][0] + outerRing[Math.floor(n / 2)][0]) / 2,
      lat: (outerRing[0][1] + outerRing[Math.floor(n / 2)][1]) / 2,
    };
  }
  cx = cx / (6 * area);
  cy = cy / (6 * area);
  return { lng: parseFloat(cx.toFixed(6)), lat: parseFloat(cy.toFixed(6)) };
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

function run() {
  console.log(`Loading canonical GeoJSON from ${CANONICAL_PATH}...`);
  const rawCanonical = JSON.parse(readFileSync(CANONICAL_PATH, 'utf-8'));
  const features = rawCanonical.features || [];
  console.log(`Loaded ${features.length} canonical features.`);

  const canonicalPoints = features.reduce((sum, f) => {
    return sum + (f.geometry?.coordinates || []).reduce((rSum, ring) => rSum + ring.length, 0);
  }, 0);

  // Conversion of meters to degree squared at Riyadh latitude (~24.7° N)
  // 1 deg lat ~ 110,800m
  const metersToDegSq = (meters) => {
    const deg = meters / 111000;
    return deg * deg;
  };

  const sqTol = metersToDegSq(toleranceMeters);
  console.log(`Simplifying using tolerance: ${toleranceMeters}m (sqDeg: ${sqTol.toExponential(3)})...`);

  let simplifiedPoints = 0;
  const displayFeatures = [];

  for (const f of features) {
    const coords = f.geometry.coordinates;
    const simplifiedCoords = coords.map((ring) => simplifyRing(ring, sqTol));
    const featurePts = simplifiedCoords.reduce((sum, r) => sum + r.length, 0);
    simplifiedPoints += featurePts;

    const bbox = computeBBox(simplifiedCoords);
    const center = computeCentroid(simplifiedCoords[0]);

    displayFeatures.push({
      type: 'Feature',
      id: f.properties.districtCode,
      properties: {
        districtCode: String(f.properties.districtCode),
        nameAr: f.properties.nameAr,
        nameEn: f.properties.nameEn,
        municipalityNameAr: f.properties.municipalityNameAr,
        center,
        bbox,
        pointCount: featurePts,
      },
      geometry: {
        type: 'Polygon',
        coordinates: simplifiedCoords,
      },
    });
  }

  const displayCollection = {
    type: 'FeatureCollection',
    name: 'riyadh_neighborhoods_display',
    cityCode: 'riyadh',
    cityAr: 'الرياض',
    toleranceMeters,
    featureCount: displayFeatures.length,
    features: displayFeatures,
  };

  const displayJSON = JSON.stringify(displayCollection);
  writeFileSync(DISPLAY_OUT_PATH, displayJSON, 'utf-8');

  const canonicalSize = statSync(CANONICAL_PATH).size;
  const displaySize = statSync(DISPLAY_OUT_PATH).size;
  const reductionPts = (((canonicalPoints - simplifiedPoints) / canonicalPoints) * 100).toFixed(1);
  const reductionBytes = (((canonicalSize - displaySize) / canonicalSize) * 100).toFixed(1);

  const hash = createHash('sha256').update(displayJSON).digest('hex');

  const metadata = {
    dataset: 'riyadh_neighborhoods_display',
    canonicalSource: 'data/geo/riyadh_neighborhoods.geojson',
    toleranceMeters,
    featureCount: displayFeatures.length,
    canonicalPoints,
    simplifiedPoints,
    pointReductionPercent: `${reductionPts}%`,
    canonicalSizeBytes: canonicalSize,
    displaySizeBytes: displaySize,
    sizeReductionPercent: `${reductionBytes}%`,
    sha256: hash,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(DISPLAY_META_PATH, JSON.stringify(metadata, null, 2), 'utf-8');

  console.log(`\n✅ Successfully generated display dataset:`);
  console.log(`   - Output: ${DISPLAY_OUT_PATH}`);
  console.log(`   - Features: ${displayFeatures.length}`);
  console.log(`   - Canonical Points: ${canonicalPoints} -> Simplified Points: ${simplifiedPoints} (${reductionPts}% reduction)`);
  console.log(`   - Canonical Size: ${(canonicalSize / 1024 / 1024).toFixed(2)} MB -> Display Size: ${(displaySize / 1024).toFixed(1)} KB (${reductionBytes}% reduction)`);
  console.log(`   - SHA256: ${hash}`);
}

run();
