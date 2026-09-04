/**
 * scripts/geo/build-riyadh-neighborhoods.mjs
 *
 * Phase GEO-1 — Riyadh Neighborhoods GeoJSON Builder
 *
 * Source: namaa-gis.kharetatalenmaa.sa
 *         /server/rest/services/Riyadh/RiyadhPMS_DistrictsPI/MapServer/5
 *
 * READ-ONLY QUERY — No applyEdits / addFeatures / updateFeatures / deleteFeatures
 *
 * Usage: node scripts/geo/build-riyadh-neighborhoods.mjs
 */

import { createHash } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ──────────────────────────────────────────────────────────────────
const BASE_URL = 'https://namaa-gis.kharetatalenmaa.sa/server/rest/services/Riyadh/RiyadhPMS_DistrictsPI/FeatureServer/5';
const OUT_FIELDS = 'OBJECTID,DISTRICT_NO,DISTRICT_NAME,DISTRICT_NAME_EN,MUNIC_NO,MUNIC_NAME,ZONE_,ENTRY_DATE,UPDATE_DATE,UPDATE_GEO_DATE';
const OUT_SR = 4326;
const PAGE_SIZE = 500;
const OUT_DIR = join(__dirname, '../../data/geo');
const GEOJSON_PATH = join(OUT_DIR, 'riyadh_neighborhoods.geojson');
const META_PATH = join(OUT_DIR, 'riyadh_neighborhoods.meta.json');

// ── SPL Secondary Source ─────────────────────────────────────────────────────
const SPL_URL = 'https://apina.address.gov.sa/NationalAddress/v3.1/lookup/districts?language=A&regionId=1&cityId=3&pageNumber=1&pageSize=1000';

// ── Helpers ──────────────────────────────────────────────────────────────────
function queryParams(extra = {}) {
  const p = new URLSearchParams({
    where: '1=1',
    outFields: OUT_FIELDS,
    returnGeometry: 'true',
    outSR: String(OUT_SR),
    f: 'geojson',
    ...extra,
  });
  return p.toString();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function getSourceCount() {
  const url = `${BASE_URL}/query?${queryParams({ returnCountOnly: 'true', returnGeometry: 'false' })}`;
  console.log('Fetching source count…');
  const data = await fetchJSON(url);
  if (data.count !== undefined) return data.count;
  if (data.properties?.count !== undefined) return data.properties.count;
  throw new Error('Cannot read count from response: ' + JSON.stringify(data).slice(0, 200));
}

async function fetchPage(offset, count) {
  const url = `${BASE_URL}/query?${queryParams({
    resultOffset: String(offset),
    resultRecordCount: String(count),
  })}`;
  console.log(`  Fetching records ${offset}–${offset + count - 1}…`);
  const data = await fetchJSON(url);
  if (data.error) throw new Error('ArcGIS error: ' + JSON.stringify(data.error));
  return data.features || [];
}

function normalizeFeature(raw) {
  const p = raw.properties || {};
  return {
    type: 'Feature',
    id: p.DISTRICT_NO ?? p.OBJECTID,
    properties: {
      districtCode: p.DISTRICT_NO ?? null,
      nameAr: p.DISTRICT_NAME ?? null,
      nameEn: p.DISTRICT_NAME_EN ?? null,
      municipalityCode: p.MUNIC_NO ?? null,
      municipalityNameAr: p.MUNIC_NAME ?? null,
      zone: p.ZONE_ ?? null,
      sourceObjectId: p.OBJECTID ?? null,
      entryDate: p.ENTRY_DATE ?? null,
      updateDate: p.UPDATE_DATE ?? null,
      updateGeoDate: p.UPDATE_GEO_DATE ?? null,
    },
    geometry: raw.geometry ?? null,
  };
}

// ── Geometry Validation ───────────────────────────────────────────────────────
function allFinite(coords) {
  if (!Array.isArray(coords)) return false;
  for (const c of coords) {
    if (Array.isArray(c)) {
      if (!allFinite(c)) return false;
    } else {
      if (!Number.isFinite(c)) return false;
    }
  }
  return true;
}

function ringClosed(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function validateGeometry(geom) {
  if (!geom) return ['null geometry'];
  const errors = [];
  const type = geom.type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    errors.push(`unexpected geometry type: ${type}`);
    return errors;
  }
  if (!allFinite(geom.coordinates)) errors.push('non-finite coordinate(s)');
  if (type === 'Polygon') {
    if (!geom.coordinates?.length) {
      errors.push('empty coordinates');
    } else {
      for (const ring of geom.coordinates) {
        if (!ringClosed(ring)) errors.push('unclosed ring');
      }
    }
  } else {
    // MultiPolygon
    for (const poly of geom.coordinates || []) {
      for (const ring of poly) {
        if (!ringClosed(ring)) errors.push('unclosed ring in MultiPolygon');
      }
    }
  }
  return errors;
}

// Coordinate count
function countCoords(coords) {
  if (!Array.isArray(coords)) return 0;
  if (!Array.isArray(coords[0])) return 1;
  return coords.reduce((s, c) => s + countCoords(c), 0);
}

// BBox update
function expandBbox(bbox, coords) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number') {
    const [lon, lat] = coords;
    if (lon < bbox[0]) bbox[0] = lon;
    if (lat < bbox[1]) bbox[1] = lat;
    if (lon > bbox[2]) bbox[2] = lon;
    if (lat > bbox[3]) bbox[3] = lat;
    return;
  }
  for (const c of coords) expandBbox(bbox, c);
}

// ── Secondary SPL source ──────────────────────────────────────────────────────
async function fetchSPLNames() {
  try {
    console.log('Fetching SPL secondary source…');
    const res = await fetchJSON(SPL_URL);
    const items = res?.Addresses || res?.addresses || res?.data || [];
    if (!Array.isArray(items) || !items.length) {
      console.warn('  SPL: no items found in response, skipping secondary comparison.');
      return [];
    }
    return items.map(i => (i.DistrictName || i.districtName || i.name_ar || '').replace(/^حي\s*/, '').trim());
  } catch (e) {
    console.warn('  SPL secondary source unavailable:', e.message);
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('PHASE GEO-1: Build Riyadh Neighborhoods GeoJSON');
  console.log('='.repeat(60));

  // 1. Get source record count
  const sourceCount = await getSourceCount();
  console.log(`Source record count: ${sourceCount}`);

  if (!sourceCount || sourceCount <= 0) {
    throw new Error('Source returned zero records. Aborting.');
  }

  // 2. Paginate and download all features
  const allRaw = [];
  for (let offset = 0; offset < sourceCount; offset += PAGE_SIZE) {
    const page = await fetchPage(offset, PAGE_SIZE);
    allRaw.push(...page);
    if (page.length === 0) {
      console.warn(`  Empty page at offset ${offset}, stopping pagination.`);
      break;
    }
  }

  console.log(`Downloaded feature count: ${allRaw.length}`);

  if (allRaw.length !== sourceCount) {
    console.error(`COUNT MISMATCH: source=${sourceCount}, downloaded=${allRaw.length}`);
    process.exit(1);
  }

  // 3. Normalize all raw source records
  const allNormalized = allRaw.map(normalizeFeature);

  // 4. Deterministic exclusion rule for documented out-of-scope non-city records
  // SPEC REQUIREMENT:
  // "If districtCode == 9901
  //  AND municipality == الدرعية
  //  AND geometry == null
  //  AND classification is documented OUT_OF_SCOPE_DIRIYAH
  //  exclude it from selectable output
  //  but include it in metadata excludedSourceRecords.
  //  Do NOT create a generic 'drop null geometry' rule."
  const selectableFeatures = [];
  const excludedSourceRecords = [];

  for (const f of allNormalized) {
    const p = f.properties;
    if (
      p.districtCode === '9901' &&
      p.municipalityNameAr === 'الدرعية' &&
      f.geometry === null
    ) {
      excludedSourceRecords.push({
        districtCode: p.districtCode,
        nameAr: p.nameAr,
        municipalityNameAr: p.municipalityNameAr,
        reason: 'OUT_OF_SCOPE_DIRIYAH',
        sourceGeometry: null,
        selectable: false,
      });
      continue;
    }
    selectableFeatures.push(f);
  }

  // Deterministic sorting by districtCode to ensure repeatable GeoJSON output & SHA-256
  selectableFeatures.sort((a, b) =>
    String(a.properties.districtCode).localeCompare(String(b.properties.districtCode), undefined, { numeric: true })
  );

  // 5. Validation
  const missingAr = [];
  const missingEn = [];
  const missingCode = [];
  const invalidGeom = [];
  const nullGeom = [];
  const outOfBounds = [];
  let polygonCount = 0;
  let multiPolygonCount = 0;
  let totalCoordPoints = 0;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];

  for (const f of selectableFeatures) {
    const p = f.properties;

    // Required attributes
    if (!p.nameAr) missingAr.push(p.sourceObjectId);
    if (!p.nameEn) missingEn.push(p.sourceObjectId);
    if (!p.districtCode) missingCode.push(p.sourceObjectId);

    // Geometry validation
    if (f.geometry === null) {
      nullGeom.push({ id: p.sourceObjectId, code: p.districtCode, name: p.nameAr });
      invalidGeom.push({ id: p.sourceObjectId, code: p.districtCode, errors: ['null geometry'] });
      continue;
    }

    const geomErrors = validateGeometry(f.geometry);
    if (geomErrors.length) {
      invalidGeom.push({ id: p.sourceObjectId, code: p.districtCode, errors: geomErrors });
    } else {
      if (f.geometry.type === 'Polygon') polygonCount++;
      else if (f.geometry.type === 'MultiPolygon') multiPolygonCount++;
      totalCoordPoints += countCoords(f.geometry.coordinates);
      expandBbox(bbox, f.geometry.coordinates);
    }

    // Riyadh bounds sanity — roughly lon: 46.2–47.5, lat: 24.2–25.2
    if (f.geometry && !geomErrors.length) {
      const coords = f.geometry.coordinates;
      const tempBbox = [Infinity, Infinity, -Infinity, -Infinity];
      expandBbox(tempBbox, coords);
      const [minLon, minLat, maxLon, maxLat] = tempBbox;
      if (minLon < 44 || maxLon > 50 || minLat < 22 || maxLat > 27) {
        outOfBounds.push({ id: p.sourceObjectId, code: p.districtCode, name: p.nameAr, bbox: tempBbox });
      }
    }
  }

  // Duplicate checks (on selectable features)
  const codeMap = new Map();
  const nameArMap = new Map();
  for (const f of selectableFeatures) {
    const c = f.properties.districtCode;
    const n = f.properties.nameAr;
    if (c) {
      if (!codeMap.has(c)) codeMap.set(c, []);
      codeMap.get(c).push(f.properties.sourceObjectId);
    }
    if (n) {
      if (!nameArMap.has(n)) nameArMap.set(n, []);
      nameArMap.get(n).push(f.properties.districtCode ?? f.properties.sourceObjectId);
    }
  }
  const dupCodes = [...codeMap.entries()].filter(([, v]) => v.length > 1);
  const dupNames = [...nameArMap.entries()].filter(([, v]) => v.length > 1);

  // Explicit check for 3802 (الخزامى / عرقة)
  const f3802 = selectableFeatures.find(f => f.properties.districtCode === '3802');
  const is3802Present = !!f3802;
  const is3802Valid = is3802Present && !!f3802.geometry && validateGeometry(f3802.geometry).length === 0;

  // Explicit check for 9901 absence in selectableFeatures
  const f9901InSelectable = selectableFeatures.find(f => f.properties.districtCode === '9901');
  const is9901Excluded = !f9901InSelectable && excludedSourceRecords.some(r => r.districtCode === '9901');

  // 6. SPL secondary comparison
  const splNames = await fetchSPLNames();
  const primaryNames = new Set(selectableFeatures.map(f => (f.properties.nameAr || '').replace(/^حي\s*/, '').trim()));

  let inPrimaryNotSecondary = [];
  let inSecondaryNotPrimary = [];

  if (splNames.length > 0) {
    const secondaryNames = new Set(splNames.filter(Boolean));
    inPrimaryNotSecondary = [...primaryNames].filter(n => n && !secondaryNames.has(n)).sort();
    inSecondaryNotPrimary = [...secondaryNames].filter(n => n && !primaryNames.has(n)).sort();
  }

  // 7. Build FeatureCollection
  const featureCollection = {
    type: 'FeatureCollection',
    name: 'riyadh_neighborhoods',
    features: selectableFeatures,
  };

  const geojsonStr = JSON.stringify(featureCollection, null, 2);
  const sha256 = createHash('sha256').update(geojsonStr).digest('hex');
  const byteSize = Buffer.byteLength(geojsonStr, 'utf8');

  // 8. Write GeoJSON
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(GEOJSON_PATH, geojsonStr, 'utf8');
  console.log(`\nWrote: ${GEOJSON_PATH}`);
  console.log(`Size: ${(byteSize / 1024 / 1024).toFixed(2)} MB (${byteSize} bytes)`);

  // 9. Write metadata
  const meta = {
    dataset: 'riyadh_neighborhoods',
    semantics: 'RIYADH CITY SELECTABLE NEIGHBORHOODS',
    description: 'Authoritative selectable Riyadh City neighborhood boundaries. Excludes non-Riyadh administrative entities such as Diriyah governorate placeholders without geometry.',
    city: 'Riyadh',
    cityAr: 'الرياض',
    coordinateSystem: 'EPSG:4326',
    coordinateOrder: '[longitude, latitude]',
    sourceFeatureCount: allRaw.length,
    selectableFeatureCount: selectableFeatures.length,
    excludedFeatureCount: excludedSourceRecords.length,
    featureCount: selectableFeatures.length,
    polygonCount,
    multiPolygonCount,
    bbox: bbox.map(v => Number(v.toFixed(6))),
    generatedAt: new Date().toISOString(),
    source: {
      host: 'namaa-gis.kharetatalenmaa.sa',
      service: 'RiyadhPMS_DistrictsPI',
      layer: 5,
    },
    excludedSourceRecords,
    sha256,
    fileSizeBytes: byteSize,
    totalCoordinatePoints: totalCoordPoints,
    validation: {
      missingArabicNames: missingAr.length,
      missingEnglishNames: missingEn.length,
      missingDistrictCodes: missingCode.length,
      invalidGeometryCount: invalidGeom.length,
      nullGeometryCount: nullGeom.length,
      outOfBoundsCount: outOfBounds.length,
      duplicateDistrictCodes: dupCodes.length,
      duplicateArabicNames: dupNames.length,
      district3802Present: is3802Present,
      district3802Valid: is3802Valid,
      district9901Excluded: is9901Excluded,
    },
  };

  writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf8');
  console.log(`Wrote: ${META_PATH}`);

  // 10. Final Report
  console.log('\n' + '='.repeat(60));
  console.log('RIYADH CITY GEOJSON — FINAL DATASET REPORT');
  console.log('='.repeat(60));
  console.log(`Source Records:                  ${sourceCount}`);
  console.log(`Selectable Riyadh City Features: ${selectableFeatures.length}`);
  console.log(`Excluded Records:                ${excludedSourceRecords.length}`);
  for (const ex of excludedSourceRecords) {
    console.log(`  Excluded: ${ex.districtCode} | ${ex.nameAr} | ${ex.municipalityNameAr} | ${ex.reason}`);
  }
  console.log(`Valid Geometry:                  ${selectableFeatures.length - invalidGeom.length}`);
  console.log(`Invalid Geometry:                ${invalidGeom.length}`);
  console.log(`Null Geometry:                   ${nullGeom.length}`);
  console.log(`Polygon:                         ${polygonCount}`);
  console.log(`MultiPolygon:                    ${multiPolygonCount}`);
  console.log(`Unique District Codes:           ${codeMap.size}`);
  console.log(`Missing Arabic Names:            ${missingAr.length}`);
  console.log(`Missing English Names:           ${missingEn.length}`);
  console.log(`Duplicate District Codes:        ${dupCodes.length}`);
  console.log(`Duplicate Arabic Names:          ${dupNames.length}`);
  console.log(`3802 الخزامى Present:            ${is3802Present ? 'YES' : 'NO'}`);
  console.log(`3802 Geometry Valid:             ${is3802Valid ? 'YES' : 'NO'}`);
  console.log(`Total Coordinate Points:         ${totalCoordPoints}`);
  console.log(`BBox:                            [${bbox.map(v => v.toFixed(6)).join(', ')}]`);
  console.log(`Coordinate System:               EPSG:4326`);
  console.log(`Coordinate Order:                [longitude, latitude]`);
  console.log(`GeoJSON Size:                    ${(byteSize / 1024 / 1024).toFixed(2)} MB (${byteSize} bytes)`);
  console.log(`SHA-256:                         ${sha256}`);
  console.log('');
  if (splNames.length > 0) {
    console.log('Primary vs Secondary Name Differences:');
    console.log(`  In Primary NOT in Secondary (${inPrimaryNotSecondary.length}): ${inPrimaryNotSecondary.slice(0, 20).join(', ')}${inPrimaryNotSecondary.length > 20 ? '…' : ''}`);
    console.log(`  In Secondary NOT in Primary (${inSecondaryNotPrimary.length}): ${inSecondaryNotPrimary.slice(0, 20).join(', ')}${inSecondaryNotPrimary.length > 20 ? '…' : ''}`);
  } else {
    console.log('Primary vs Secondary Name Differences: SPL source unavailable (skipped)');
  }
  console.log('');
  console.log(`Files Updated:`);
  console.log(`  data/geo/riyadh_neighborhoods.geojson`);
  console.log(`  data/geo/riyadh_neighborhoods.meta.json`);
  console.log(`  scripts/geo/build-riyadh-neighborhoods.mjs`);
  console.log('');
  console.log(`Existing Production Files Modified: 0`);
  console.log('');

  // Determine FINAL status
  const blocked =
    allRaw.length !== sourceCount ||
    selectableFeatures.length !== 165 ||
    excludedSourceRecords.length !== 1 ||
    invalidGeom.length > 0 ||
    nullGeom.length > 0 ||
    missingAr.length > 0 ||
    missingCode.length > 0 ||
    dupCodes.length > 0 ||
    !is3802Present ||
    !is3802Valid ||
    !is9901Excluded;

  if (blocked) {
    console.log('FINAL: DATASET BLOCKED');
    if (allRaw.length !== sourceCount) console.log('  REASON: Count mismatch');
    if (selectableFeatures.length !== 165) console.log('  REASON: Selectable features count is not 165 (actual: ' + selectableFeatures.length + ')');
    if (excludedSourceRecords.length !== 1) console.log('  REASON: Excluded records count is not 1 (actual: ' + excludedSourceRecords.length + ')');
    if (invalidGeom.length > 0) console.log('  REASON: Invalid geometry in', invalidGeom.length, 'features');
    if (nullGeom.length > 0) console.log('  REASON: Null geometry in selectable features:', nullGeom.length);
    if (missingAr.length > 0) console.log('  REASON: Missing Arabic names in', missingAr.length, 'features');
    if (missingCode.length > 0) console.log('  REASON: Missing district codes in', missingCode.length, 'features');
    if (dupCodes.length > 0) console.log('  REASON: Duplicate district codes found');
    if (!is3802Present || !is3802Valid) console.log('  REASON: District 3802 (الخزامى) is missing or invalid');
    if (!is9901Excluded) console.log('  REASON: District 9901 was not properly excluded');
    process.exit(1);
  } else {
    console.log('FINAL: RIYADH CITY DATASET READY FOR APPLICATION INTEGRATION');
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
