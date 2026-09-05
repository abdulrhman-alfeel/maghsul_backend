import CoverageService from '../../modules/washers/coverage.service.js';
import GeoService from '../../modules/geo/geo.service.js';
import { CITY_REGISTRY, getCityConfig, getSupportedCityCodes } from '../../modules/geo/city.registry.js';
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

  // ── 2. City Registry Tests ────────────────────────────────────────────────
  describe('City Registry', () => {
    test('contains riyadh configuration with required paths', () => {
      const config = getCityConfig('riyadh');
      expect(config).toBeDefined();
      expect(config.cityCode).toBe('riyadh');
      expect(config.nameAr).toBe('الرياض');
      expect(config.canonicalPath).toContain('riyadh_neighborhoods.geojson');
      expect(config.displayPath).toContain('riyadh_neighborhoods_display.json');
      expect(config.metaPath).toContain('riyadh_neighborhoods_display.meta.json');
    });

    test('case-insensitively resolves city', () => {
      expect(getCityConfig('RIYADH')).toEqual(getCityConfig('riyadh'));
      expect(getCityConfig('  Riyadh  ')).toEqual(getCityConfig('riyadh'));
    });

    test('returns null for unsupported cities without throwing', () => {
      expect(getCityConfig('jeddah')).toBeNull();
      expect(getCityConfig('dammam')).toBeNull();
      expect(getCityConfig('')).toBeNull();
      expect(getCityConfig(null)).toBeNull();
    });

    test('lists supported cities', () => {
      const cities = getSupportedCityCodes();
      expect(cities).toContain('riyadh');
    });
  });

  // ── 3. GeoService Tests ───────────────────────────────────────────────────
  describe('GeoService', () => {
    test('loads display catalog with 165 features and valid ETag for riyadh', () => {
      const { catalog, etag } = GeoService.getDisplayCatalog('riyadh');
      expect(catalog.features).toHaveLength(165);
      expect(etag).toMatch(/^"[a-f0-9]{16}"$/);
      expect(catalog.cityCode).toBe('riyadh');

      const sample = catalog.features[0];
      expect(sample.properties.districtCode).toBeDefined();
      expect(sample.properties.center.lat).toBeGreaterThan(24);
      expect(sample.properties.center.lng).toBeGreaterThan(46);
      expect(sample.properties.bbox).toHaveLength(4);
    });

    test('throws 404 for unsupported city in getDisplayCatalog', () => {
      expect(() => GeoService.getDisplayCatalog('jeddah')).toThrow(/City "jeddah" is not supported/);
    });

    test('fetches canonical features for valid districtCodes', () => {
      const canonical = GeoService.getCanonicalFeaturesByDistrictCodes('riyadh', ['3802', '3401']);
      expect(canonical).toHaveLength(2);
      expect(canonical.map((f) => String(f.properties.districtCode))).toEqual(['3802', '3401']);
    });

    test('backward compatibility: defaults to riyadh when single argument is array', () => {
      const canonical = GeoService.getCanonicalFeaturesByDistrictCodes(['3802', '3401']);
      expect(canonical).toHaveLength(2);
      expect(canonical.map((f) => String(f.properties.districtCode))).toEqual(['3802', '3401']);
    });

    test('throws 400 for unknown district code', () => {
      expect(() => GeoService.getCanonicalFeaturesByDistrictCodes('riyadh', ['999999'])).toThrow(
        /not recognized in city "riyadh"/
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

  // ── 4. CoverageService Dual-Mode Evaluation Tests ─────────────────────────
  describe('CoverageService.evaluateBranchCoverage (Deterministic Mode Invariants)', () => {
    const branch = {
      id: 'branch-1',
      status: 'active',
      isOpen: true,
      acceptingOrders: true,
      lat: 24.7136,
      lng: 46.6753,
    };

    const circleInclusionZone = {
      id: 'zone-circle-1',
      branchId: 'branch-1',
      name: 'Circle Inclusion Zone',
      zoneType: 'inclusion',
      coverageType: 'circle',
      centerLat: 24.7136,
      centerLng: 46.6753,
      radiusMeters: 2000,
      isActive: true,
      priority: 10,
    };

    const polygonInclusionZone = {
      id: 'zone-poly-1',
      branchId: 'branch-1',
      name: 'Olaya Polygon Inclusion',
      zoneType: 'inclusion',
      coverageType: 'polygon',
      geoJson: {
        type: 'Polygon',
        coordinates: [
          [
            [46.6600, 24.7000],
            [46.6900, 24.7000],
            [46.6900, 24.7300],
            [46.6600, 24.7300],
            [46.6600, 24.7000],
          ],
        ],
      },
      isActive: true,
      priority: 10,
    };

    const circleExclusionZone = {
      id: 'zone-circle-ex',
      branchId: 'branch-1',
      name: 'Restricted Circle Exclusion',
      zoneType: 'exclusion',
      coverageType: 'circle',
      centerLat: 24.7150,
      centerLng: 46.6750,
      radiusMeters: 300,
      isActive: true,
      priority: 99,
    };

    const polygonExclusionZone = {
      id: 'zone-poly-ex',
      branchId: 'branch-1',
      name: 'Restricted Polygon Exclusion',
      zoneType: 'exclusion',
      coverageType: 'polygon',
      geoJson: {
        type: 'Polygon',
        coordinates: [
          [
            [46.6700, 24.7100],
            [46.6800, 24.7100],
            [46.6800, 24.7200],
            [46.6700, 24.7200],
            [46.6700, 24.7100],
          ],
        ],
      },
      isActive: true,
      priority: 99,
    };

    test('Mode 1 (Circle Only): point inside is covered, point outside is not covered', () => {
      const pickupInside = { lat: 24.7150, lng: 46.6760 };
      const evalInside = CoverageService.evaluateBranchCoverage(branch, [circleInclusionZone], pickupInside, null);
      expect(evalInside.isCovered).toBe(true);

      const pickupOutside = { lat: 24.8500, lng: 46.8500 };
      const evalOutside = CoverageService.evaluateBranchCoverage(branch, [circleInclusionZone], pickupOutside, null);
      expect(evalOutside.isCovered).toBe(false);
    });

    test('Mode 2 (Neighborhood Polygon Only): point inside polygon is covered, outside is not covered', () => {
      const pickupInside = { lat: 24.7150, lng: 46.6750 };
      const evalInside = CoverageService.evaluateBranchCoverage(branch, [polygonInclusionZone], pickupInside, null);
      expect(evalInside.isCovered).toBe(true);

      const pickupOutside = { lat: 24.6500, lng: 46.6000 };
      const evalOutside = CoverageService.evaluateBranchCoverage(branch, [polygonInclusionZone], pickupOutside, null);
      expect(evalOutside.isCovered).toBe(false);
    });

    test('None: branch with no active inclusion zones fails closed (isCovered = false)', () => {
      const pickup = { lat: 24.7136, lng: 46.6753 };
      const res = CoverageService.evaluateBranchCoverage(branch, [], pickup, null);
      expect(res.isCovered).toBe(false);
    });

    test('Mixed Conflict (Active Circle Inclusion + Active Polygon Inclusion): FAILS CLOSED immediately', () => {
      // Point that is inside BOTH circle and polygon
      const pickupInsideBoth = { lat: 24.7136, lng: 46.6753 };
      const res = CoverageService.evaluateBranchCoverage(
        branch,
        [circleInclusionZone, polygonInclusionZone],
        pickupInsideBoth,
        null
      );

      // Must fail closed, not evaluate as union
      expect(res.isCovered).toBe(false);
      expect(res.isConflict).toBe(true);
    });

    test('Circle Inclusion + Polygon Exclusion: NOT mixed conflict (exclusion overrides inclusion)', () => {
      // Point falls inside circle inclusion AND inside polygon exclusion
      const pickupInsideExclusion = { lat: 24.7150, lng: 46.6750 };
      const resExcluded = CoverageService.evaluateBranchCoverage(
        branch,
        [circleInclusionZone, polygonExclusionZone],
        pickupInsideExclusion,
        null
      );
      expect(resExcluded.isCovered).toBe(false);
      expect(resExcluded.isConflict).toBeUndefined();

      // Point falls inside circle inclusion but OUTSIDE polygon exclusion
      const pickupInsideInclusionOnly = { lat: 24.7200, lng: 46.6650 };
      const resCovered = CoverageService.evaluateBranchCoverage(
        branch,
        [circleInclusionZone, polygonExclusionZone],
        pickupInsideInclusionOnly,
        null
      );
      expect(resCovered.isCovered).toBe(true);
    });

    test('Neighborhood Inclusion + Circle Exclusion: NOT mixed conflict (exclusion overrides inclusion)', () => {
      // Point falls inside polygon inclusion AND inside circle exclusion
      const pickupInsideExclusion = { lat: 24.7150, lng: 46.6750 };
      const resExcluded = CoverageService.evaluateBranchCoverage(
        branch,
        [polygonInclusionZone, circleExclusionZone],
        pickupInsideExclusion,
        null
      );
      expect(resExcluded.isCovered).toBe(false);
      expect(resExcluded.isConflict).toBeUndefined();

      // Point falls inside polygon inclusion but OUTSIDE circle exclusion
      const pickupInsideInclusionOnly = { lat: 24.7250, lng: 46.6850 };
      const resCovered = CoverageService.evaluateBranchCoverage(
        branch,
        [polygonInclusionZone, circleExclusionZone],
        pickupInsideInclusionOnly,
        null
      );
      expect(resCovered.isCovered).toBe(true);
    });
  });
});
