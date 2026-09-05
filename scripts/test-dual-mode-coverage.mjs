import assert from 'assert';
import CoverageService from '../src/modules/washers/coverage.service.js';
import GeoService from '../src/modules/geo/geo.service.js';
import { washerSchemas } from '../src/utils/schemas.js';

console.log('🚀 Running Dual-Mode Geographic Coverage Verification Suite...\n');

// ── Test 1: Schema Validation ──────────────────────────────────────────────
console.log('1. Testing washerSchemas.neighborhoodCoverageBody...');
{
  const valid = { cityCode: 'riyadh', districtCodes: ['3802', '3401'] };
  const res1 = washerSchemas.neighborhoodCoverageBody(valid);
  assert.strictEqual(res1.error, null, 'Valid payload should not produce error');
  assert.deepStrictEqual(res1.value, valid);

  const res2 = washerSchemas.neighborhoodCoverageBody({ cityCode: 'dammam', districtCodes: ['123'] });
  assert.strictEqual(res2.error, 'cityCode must be riyadh');

  const res3 = washerSchemas.neighborhoodCoverageBody({ cityCode: 'riyadh', districtCodes: [] });
  assert.strictEqual(res3.error, 'districtCodes must be a non-empty array of strings');

  const res4 = washerSchemas.neighborhoodCoverageBody({ cityCode: 'riyadh', districtCodes: [''] });
  assert.strictEqual(res4.error, 'all districtCodes must be non-empty strings');
}
console.log('   ✅ Schema validation passed.');

// ── Test 2: GeoService ─────────────────────────────────────────────────────
console.log('2. Testing GeoService (Display catalog & Canonical lookup)...');
{
  const { catalog, etag } = GeoService.getDisplayCatalog();
  assert.strictEqual(catalog.features.length, 165, 'Must contain 165 Riyadh features');
  assert.ok(etag && etag.startsWith('"'), 'Must have valid ETag');
  assert.strictEqual(catalog.cityCode, 'riyadh');

  const sample = catalog.features[0];
  assert.ok(sample.properties.districtCode, 'Must have districtCode');
  assert.ok(sample.properties.center.lat > 24 && sample.properties.center.lng > 46, 'Valid center coordinates');
  assert.strictEqual(sample.properties.bbox.length, 4, 'BBox has 4 elements');

  const canonical = GeoService.getCanonicalFeaturesByDistrictCodes(['3802', '3401']);
  assert.strictEqual(canonical.length, 2, 'Canonical lookup should return 2 features');
  assert.strictEqual(String(canonical[0].properties.districtCode), '3802');
  assert.strictEqual(String(canonical[1].properties.districtCode), '3401');

  assert.throws(
    () => GeoService.getCanonicalFeaturesByDistrictCodes(['99999']),
    /not recognized in Riyadh City/,
    'Should throw 400 for unknown district'
  );
}
console.log('   ✅ GeoService catalog & canonical lookups passed.');

// ── Test 3: CoverageService (Dual Mode Evaluation) ─────────────────────────
console.log('3. Testing CoverageService (Dual Mode Evaluation)...');
{
  const branch = {
    id: 'branch-test-1',
    status: 'active',
    isOpen: true,
    acceptingOrders: true,
    lat: 24.7136,
    lng: 46.6753,
  };

  // Test 3A: Mode 1 — Circle evaluation
  const circleZone = {
    id: 'zone-c-1',
    branchId: branch.id,
    name: 'Circle Zone',
    zoneType: 'inclusion',
    coverageType: 'circle',
    centerLat: 24.7136,
    centerLng: 46.6753,
    radiusMeters: 2000,
    isActive: true,
    priority: 10,
  };

  const pickupNear = { lat: 24.7150, lng: 46.6760 }; // ~200m away
  const evalNear = CoverageService.evaluateBranchCoverage(branch, [circleZone], pickupNear, null);
  assert.strictEqual(evalNear.isCovered, true, 'Point within radius should be covered');

  const pickupFar = { lat: 24.8500, lng: 46.8500 }; // >10km away
  const evalFar = CoverageService.evaluateBranchCoverage(branch, [circleZone], pickupFar, null);
  assert.strictEqual(evalFar.isCovered, false, 'Point outside radius should not be covered');

  // Test 3B: Mode 2 — Neighborhood Polygon evaluation
  const feature3802 = GeoService.getCanonicalIndex().get('3802');
  const bbox = GeoService.computeBoundingBox(feature3802.geometry.coordinates);
  const neighborhoodZone = {
    id: 'zone-poly-3802',
    branchId: branch.id,
    name: feature3802.properties.nameAr,
    zoneType: 'inclusion',
    coverageType: 'polygon',
    bbMinLat: bbox.bbMinLat,
    bbMaxLat: bbox.bbMaxLat,
    bbMinLng: bbox.bbMinLng,
    bbMaxLng: bbox.bbMaxLng,
    geoJson: feature3802.geometry,
    isActive: true,
    priority: 10,
  };

  const firstCoord = feature3802.geometry.coordinates[0][0]; // [lng, lat]
  const pickupInKhuzama = { lat: firstCoord[1], lng: firstCoord[0] };
  const evalKhuzama = CoverageService.evaluateBranchCoverage(branch, [neighborhoodZone], pickupInKhuzama, null);
  assert.strictEqual(evalKhuzama.isCovered, true, 'Point in Al Khuzama polygon should be covered');

  const pickupOlaya = { lat: 24.7136, lng: 46.6753 }; // Olaya center (outside Khuzama)
  const evalOlaya = CoverageService.evaluateBranchCoverage(branch, [neighborhoodZone], pickupOlaya, null);
  assert.strictEqual(evalOlaya.isCovered, false, 'Point outside Al Khuzama polygon should not be covered');

  // Test 3C: FAIL_CLOSED Guarantee
  const inactiveZone = { ...circleZone, isActive: false };
  const evalFailClosed = CoverageService.evaluateBranchCoverage(branch, [inactiveZone], pickupNear, null);
  assert.strictEqual(evalFailClosed.isCovered, false, 'Zero active zones must fail closed');
  assert.strictEqual(evalFailClosed.matchedZonePriority, -1);

  // Test 3D: Exclusion Precedence Guarantee
  const exclusionZone = {
    id: 'zone-ex-1',
    branchId: branch.id,
    zoneType: 'exclusion',
    coverageType: 'circle',
    centerLat: 24.7150,
    centerLng: 46.6760,
    radiusMeters: 500,
    isActive: true,
  };
  const evalExclusion = CoverageService.evaluateBranchCoverage(branch, [circleZone, exclusionZone], pickupNear, null);
  assert.strictEqual(evalExclusion.isCovered, false, 'Exclusion zone must override inclusion');
}
console.log('   ✅ CoverageService dual-mode evaluation passed.');

// ── Test 4: GeoController Response & ETag ──────────────────────────────────
console.log('4. Testing GeoController...');
{
  const { default: GeoController } = await import('../src/modules/geo/geo.controller.js');
  const mockRes = {
    _status: 200,
    _headers: {},
    status(s) { this._status = s; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    json(body) { this._body = body; return this; },
    end() { this._ended = true; return this; },
  };

  GeoController.getRiyadhNeighborhoods({ headers: {} }, mockRes);
  assert.strictEqual(mockRes._status, 200);
  assert.strictEqual(mockRes._body.ok, true);
  assert.strictEqual(mockRes._body.data.features.length, 165);
  assert.ok(mockRes._headers['ETag']);

  // Test 304 conditional request
  const mockRes304 = {
    _status: 200,
    _headers: {},
    status(s) { this._status = s; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
  GeoController.getRiyadhNeighborhoods({ headers: { 'if-none-match': mockRes._headers['ETag'] } }, mockRes304);
  assert.strictEqual(mockRes304._status, 304);
  assert.strictEqual(mockRes304._ended, true);
}
console.log('   ✅ GeoController 200 and 304 responses passed.');

console.log('\n🎉 ALL DUAL-MODE GEOGRAPHIC TESTS PASSED SUCCESSFULLY!\n');
