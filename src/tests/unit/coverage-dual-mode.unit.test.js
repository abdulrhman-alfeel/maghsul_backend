import CoverageService from '../../modules/washers/coverage.service.js';
import GeoService from '../../modules/geo/geo.service.js';
import { washerSchemas } from '../../utils/schemas.js';

describe('Dual-Mode Geographic Coverage Unit Tests (Pure Logic)', () => {
  // ── 1. Schema Validation Tests ────────────────────────────────────────────
  describe('washerSchemas.neighborhoodCoverageBody', () => {
    test('validates correct neighborhood payload', () => {
      const valid = {
        cityCode: 'riyadh',
        districtCodes: ['3802', '3401'],
      };
      const res = washerSchemas.neighborhoodCoverageBody(valid);
      expect(res.error).toBeNull();
      expect(res.value).toEqual(valid);
    });

    test('rejects missing or non-riyadh cityCode', () => {
      expect(washerSchemas.neighborhoodCoverageBody({ cityCode: 'jeddah', districtCodes: ['123'] }).error).toBe(
        'cityCode must be riyadh'
      );
      expect(washerSchemas.neighborhoodCoverageBody({ districtCodes: ['123'] }).error).toBe(
        'cityCode is required (string)'
      );
    });

    test('rejects empty or invalid districtCodes array', () => {
      expect(washerSchemas.neighborhoodCoverageBody({ cityCode: 'riyadh', districtCodes: [] }).error).toBe(
        'districtCodes must be a non-empty array of strings'
      );
      expect(washerSchemas.neighborhoodCoverageBody({ cityCode: 'riyadh', districtCodes: [''] }).error).toBe(
        'all districtCodes must be non-empty strings'
      );
    });
  });

  // ── 2. GeoService Tests ───────────────────────────────────────────────────
  describe('GeoService', () => {
    test('loads display catalog with 165 features and valid ETag', () => {
      const { catalog, etag } = GeoService.getDisplayCatalog();
      expect(catalog.features).toHaveLength(165);
      expect(etag).toMatch(/^"[a-f0-9]{16}"$/);
      expect(catalog.cityCode).toBe('riyadh');

      // Verify each feature has center and bbox
      const sample = catalog.features[0];
      expect(sample.properties.districtCode).toBeDefined();
      expect(sample.properties.center.lat).toBeGreaterThan(24);
      expect(sample.properties.center.lng).toBeGreaterThan(46);
      expect(sample.properties.bbox).toHaveLength(4);
    });

    test('fetches canonical features for valid districtCodes', () => {
      const canonical = GeoService.getCanonicalFeaturesByDistrictCodes(['3802', '3401']);
      expect(canonical).toHaveLength(2);
      expect(canonical.map((f) => String(f.properties.districtCode))).toEqual(['3802', '3401']);
    });

    test('throws 400 for unknown district code', () => {
      expect(() => GeoService.getCanonicalFeaturesByDistrictCodes(['999999'])).toThrow(
        /not recognized in Riyadh City/
      );
    });

    test('computes accurate bounding box', () => {
      const coords = [
        [
          [46.6, 24.7],
          [46.8, 24.7],
          [46.8, 24.9],
          [46.6, 24.9],
          [46.6, 24.7],
        ],
      ];
      const bbox = GeoService.computeBoundingBox(coords);
      expect(bbox).toEqual({
        bbMinLng: 46.6,
        bbMaxLng: 46.8,
        bbMinLat: 24.7,
        bbMaxLat: 24.9,
      });
    });
  });

  // ── 3. CoverageService Evaluation Tests ───────────────────────────────────
  describe('CoverageService.evaluateBranchCoverage (Dual Mode Evaluation)', () => {
    const branch = {
      id: 'branch-1',
      status: 'active',
      isOpen: true,
      acceptingOrders: true,
      lat: 24.7136,
      lng: 46.6753,
    };

    test('Mode 1 (Circle): evaluates point within radius as covered', () => {
      const circleZone = {
        id: 'zone-circle-1',
        branchId: 'branch-1',
        name: 'Circle Zone',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 2000,
        isActive: true,
        priority: 10,
      };

      // Point ~200m away
      const pickupInside = { lat: 24.7150, lng: 46.6760 };
      const evalInside = CoverageService.evaluateBranchCoverage(branch, [circleZone], pickupInside, null);
      expect(evalInside.isCovered).toBe(true);
      expect(evalInside.pickupDistance).toBeLessThan(2000);

      // Point ~10km away
      const pickupOutside = { lat: 24.8100, lng: 46.7800 };
      const evalOutside = CoverageService.evaluateBranchCoverage(branch, [circleZone], pickupOutside, null);
      expect(evalOutside.isCovered).toBe(false);
    });

    test('Mode 2 (Neighborhood Polygon): evaluates point inside canonical polygon as covered', () => {
      // Canonical Al Khuzama feature ('3802')
      const feature3802 = GeoService.getCanonicalIndex().get('3802');
      const bbox = GeoService.computeBoundingBox(feature3802.geometry.coordinates);

      const neighborhoodZone = {
        id: 'zone-poly-3802',
        branchId: 'branch-1',
        name: 'الخزامى',
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

      // Point on the first coordinate of Al Khuzama (on boundary/vertex -> inside)
      const firstCoord = feature3802.geometry.coordinates[0][0]; // [lng, lat]
      const pickupInside = { lat: firstCoord[1], lng: firstCoord[0] };

      const evalInside = CoverageService.evaluateBranchCoverage(branch, [neighborhoodZone], pickupInside, null);
      expect(evalInside.isCovered).toBe(true);

      // Point in Olaya center (outside Al Khuzama) -> NOT covered
      const pickupOlaya = { lat: 24.7136, lng: 46.6753 };
      const evalOutside = CoverageService.evaluateBranchCoverage(branch, [neighborhoodZone], pickupOlaya, null);
      expect(evalOutside.isCovered).toBe(false);
    });

    test('FAIL_CLOSED Guarantee: returns isCovered: false when zero inclusion zones are active', () => {
      const inactiveZone = {
        id: 'zone-inactive',
        branchId: 'branch-1',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 5000,
        isActive: false, // Inactive!
      };

      const pickup = { lat: 24.7136, lng: 46.6753 };
      const evalResult = CoverageService.evaluateBranchCoverage(branch, [inactiveZone], pickup, null);
      expect(evalResult.isCovered).toBe(false);
      expect(evalResult.matchedZonePriority).toBe(-1);
    });

    test('Exclusion Precedence Guarantee: point in exclusion zone is rejected even if in circle', () => {
      const circleZone = {
        id: 'zone-circle-1',
        branchId: 'branch-1',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 5000,
        isActive: true,
      };

      const exclusionZone = {
        id: 'zone-exclusion-1',
        branchId: 'branch-1',
        zoneType: 'exclusion',
        coverageType: 'circle',
        centerLat: 24.7150,
        centerLng: 46.6760,
        radiusMeters: 200,
        isActive: true,
      };

      // Point inside exclusion zone
      const pickup = { lat: 24.7150, lng: 46.6760 };
      const evalResult = CoverageService.evaluateBranchCoverage(branch, [circleZone, exclusionZone], pickup, null);
      expect(evalResult.isCovered).toBe(false);
    });
  });
});
