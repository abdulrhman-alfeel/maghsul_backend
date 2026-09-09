/**
 * scripts/geo/add-outer-riyadh-regions.mjs
 *
 * Adds outer Riyadh regions (Al-Jubaylah, Al-Uyaynah, Ad Diriyah, Al-Ammariyah,
 * Sudus, Salbukh, Malham, Huraymila) to the canonical GeoJSON dataset and
 * triggers display geometry optimization.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CANONICAL_PATH = join(__dirname, '../../data/geo/riyadh_neighborhoods.geojson');
const META_PATH = join(__dirname, '../../data/geo/riyadh_neighborhoods.meta.json');

function crossProduct(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points) {
  points.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper);
  hull.push(hull[0]); // Ensure closed ring
  return hull;
}

async function fetchOsmBboxHull([minLng, minLat, maxLng, maxLat]) {
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${minLng},${minLat},${maxLng},${maxLat}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'LaundryAppLocationResolver/1.0' } });
  if (!res.ok) {
    throw new Error(`OSM HTTP ${res.status}`);
  }
  const data = await res.json();
  const pts = data.elements
    .filter((e) => e.type === 'node' && e.lat && e.lon)
    .map((e) => [parseFloat(Number(e.lon).toFixed(6)), parseFloat(Number(e.lat).toFixed(6))])
    .filter(([lon, lat]) => lon >= minLng && lon <= maxLng && lat >= minLat && lat <= maxLat);

  if (pts.length < 3) {
    throw new Error(`Insufficient points in bbox: ${pts.length}`);
  }
  return convexHull(pts);
}

const REGION_DEFINITIONS = [
  {
    districtCode: '9901',
    nameAr: 'الدرعية',
    nameEn: 'AD DIRIYAH',
    municipalityCode: '99',
    municipalityNameAr: 'الدرعية',
    zone: 'WEST',
    bbox: [46.53, 24.72, 46.59, 24.78],
  },
  {
    districtCode: '9902',
    nameAr: 'الجبيلة',
    nameEn: 'AL JUBAYLAH',
    municipalityCode: '99',
    municipalityNameAr: 'الدرعية',
    zone: 'NORTH_WEST',
    bbox: [46.418, 24.885, 46.475, 24.945],
  },
  {
    districtCode: '9903',
    nameAr: 'العيينة',
    nameEn: 'AL UYAYNAH',
    municipalityCode: '99',
    municipalityNameAr: 'الدرعية',
    zone: 'NORTH_WEST',
    bbox: [46.365, 24.885, 46.418, 24.935],
  },
  {
    districtCode: '9904',
    nameAr: 'العمارية',
    nameEn: 'AL AMMARIYAH',
    municipalityCode: '99',
    municipalityNameAr: 'الدرعية',
    zone: 'NORTH_WEST',
    bbox: [46.39, 24.77, 46.45, 24.825],
  },
  {
    districtCode: '9905',
    nameAr: 'سدوس',
    nameEn: 'SUDUS',
    municipalityCode: '99',
    municipalityNameAr: 'الدرعية',
    zone: 'NORTH_WEST',
    bbox: [46.185, 24.97, 46.235, 25.015],
  },
  {
    districtCode: '9801',
    nameAr: 'صلبوخ',
    nameEn: 'SALBUKH',
    municipalityCode: '98',
    municipalityNameAr: 'حريملاء',
    zone: 'NORTH',
    bbox: [46.325, 25.06, 46.365, 25.1],
  },
  {
    districtCode: '9802',
    nameAr: 'ملهم',
    nameEn: 'MALHAM',
    municipalityCode: '98',
    municipalityNameAr: 'حريملاء',
    zone: 'NORTH',
    bbox: [46.31, 25.145, 46.36, 25.195],
  },
  {
    districtCode: '9803',
    nameAr: 'حريملاء',
    nameEn: 'HURAYMILA',
    municipalityCode: '98',
    municipalityNameAr: 'حريملاء',
    zone: 'NORTH',
    bbox: [46.1, 25.105, 46.15, 25.15],
  },
];

async function main() {
  console.log('[ADD-REGIONS] Reading canonical GeoJSON:', CANONICAL_PATH);
  const raw = JSON.parse(readFileSync(CANONICAL_PATH, 'utf-8'));
  const existingCodes = new Set(raw.features.map((f) => String(f.properties?.districtCode || f.id)));

  let addedCount = 0;
  for (const def of REGION_DEFINITIONS) {
    if (existingCodes.has(def.districtCode)) {
      console.log(`[ADD-REGIONS] Region ${def.nameAr} (${def.districtCode}) already exists, skipping.`);
      continue;
    }

    console.log(`[ADD-REGIONS] Fetching boundary points for ${def.nameAr} (${def.nameEn})...`);
    let ring;
    try {
      ring = await fetchOsmBboxHull(def.bbox);
    } catch (err) {
      console.warn(`[ADD-REGIONS] OSM fetch failed for ${def.nameAr}:`, err.message);
      // Fallback to geometric bounding rectangle if network fails
      const [minLng, minLat, maxLng, maxLat] = def.bbox;
      ring = [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ];
    }

    const feature = {
      type: 'Feature',
      id: def.districtCode,
      properties: {
        districtCode: def.districtCode,
        nameAr: def.nameAr,
        nameEn: def.nameEn,
        municipalityCode: def.municipalityCode,
        municipalityNameAr: def.municipalityNameAr,
        zone: def.zone,
        sourceObjectId: parseInt(def.districtCode, 10),
        entryDate: Date.now(),
        updateDate: Date.now(),
        updateGeoDate: Date.now(),
      },
      geometry: {
        type: 'Polygon',
        coordinates: [ring],
      },
    };

    raw.features.push(feature);
    addedCount++;
    console.log(`[ADD-REGIONS] Added ${def.nameAr} with ${ring.length} boundary points.`);
  }

  if (addedCount > 0) {
    writeFileSync(CANONICAL_PATH, JSON.stringify(raw, null, 2), 'utf-8');
    console.log(`[ADD-REGIONS] Updated canonical GeoJSON saved. Total features: ${raw.features.length}`);

    // Update metadata
    if (existsSync(META_PATH)) {
      const meta = JSON.parse(readFileSync(META_PATH, 'utf-8'));
      meta.featureCount = raw.features.length;
      meta.selectableFeatureCount = raw.features.length;
      meta.sha256 = createHash('sha256').update(readFileSync(CANONICAL_PATH)).digest('hex');
      writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf-8');
      console.log('[ADD-REGIONS] Metadata updated.');
    }

    // Run display geometry builder
    console.log('[ADD-REGIONS] Running build-display-geometry.mjs...');
    execSync('node scripts/geo/build-display-geometry.mjs', {
      cwd: join(__dirname, '../..'),
      stdio: 'inherit',
    });
    console.log('[ADD-REGIONS] All pipelines completed successfully!');
  } else {
    console.log('[ADD-REGIONS] No new regions needed to be added.');
  }
}

main().catch((err) => {
  console.error('[ADD-REGIONS] Error:', err);
  process.exit(1);
});
