import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import ApiError from '../../helpers/apiError.js';
import { getCityConfig } from './city.registry.js';

class GeoService {
  constructor() {
    this._displayCatalogs = new Map(); // cityCode -> { catalog, etag }
    this._canonicalIndices = new Map(); // cityCode -> Map<districtCode, Feature>
  }

  /**
   * Resolves valid city config or throws 404.
   * @param {string} cityCode
   * @returns {object}
   */
  _resolveCityConfig(cityCode = 'riyadh') {
    const config = getCityConfig(cityCode);
    if (!config) {
      throw new ApiError(404, 'city_not_supported', `City "${cityCode}" is not supported`);
    }
    return config;
  }

  /**
   * Lazy-loads display catalog in memory for a given city.
   * @param {string} cityCode
   */
  getDisplayCatalog(cityCode = 'riyadh') {
    const config = this._resolveCityConfig(cityCode);
    const key = config.cityCode;

    if (!this._displayCatalogs.has(key)) {
      if (!existsSync(config.displayPath)) {
        throw new ApiError(500, 'GEO_CATALOG_UNAVAILABLE', `Display geometry catalog for "${key}" has not been generated`);
      }
      const raw = readFileSync(config.displayPath, 'utf-8');
      const catalog = JSON.parse(raw);
      const hash = createHash('sha256').update(raw).digest('hex');
      const etag = `"${hash.slice(0, 16)}"`;
      this._displayCatalogs.set(key, { catalog, etag });
    }
    return this._displayCatalogs.get(key);
  }

  /**
   * Lazy-loads and indexes canonical neighborhoods for fast O(1) lookups.
   * @param {string} cityCode
   */
  getCanonicalIndex(cityCode = 'riyadh') {
    const config = this._resolveCityConfig(cityCode);
    const key = config.cityCode;

    if (!this._canonicalIndices.has(key)) {
      if (!existsSync(config.canonicalPath)) {
        throw new ApiError(500, 'CANONICAL_GEO_UNAVAILABLE', `Authoritative canonical GeoJSON for "${key}" is missing`);
      }
      const raw = JSON.parse(readFileSync(config.canonicalPath, 'utf-8'));
      const index = new Map();
      for (const feature of raw.features || []) {
        const code = String(feature.properties?.districtCode || feature.id);
        index.set(code, feature);
      }
      this._canonicalIndices.set(key, index);
    }
    return this._canonicalIndices.get(key);
  }

  /**
   * Validates and fetches exact canonical features for a list of district codes.
   * Supports both signatures:
   *   getCanonicalFeaturesByDistrictCodes(districtCodes) [defaults to riyadh]
   *   getCanonicalFeaturesByDistrictCodes(cityCode, districtCodes)
   * Throws 400 if any districtCode is invalid or unknown.
   */
  getCanonicalFeaturesByDistrictCodes(arg1, arg2) {
    let cityCode = 'riyadh';
    let districtCodes;

    if (Array.isArray(arg1)) {
      districtCodes = arg1;
    } else {
      cityCode = arg1;
      districtCodes = arg2;
    }

    if (!Array.isArray(districtCodes) || districtCodes.length === 0) {
      throw new ApiError(400, 'invalid_district_codes', 'districtCodes must be a non-empty array of strings');
    }

    const index = this.getCanonicalIndex(cityCode);
    const validatedFeatures = [];
    const invalidCodes = [];

    // Deduplicate district codes while preserving order
    const uniqueCodes = Array.from(new Set(districtCodes.map((c) => String(c).trim())));

    for (const code of uniqueCodes) {
      const feature = index.get(code);
      if (!feature) {
        invalidCodes.push(code);
      } else {
        validatedFeatures.push(feature);
      }
    }

    if (invalidCodes.length > 0) {
      throw new ApiError(
        400,
        'invalid_district_code',
        `The following district codes are not recognized in city "${cityCode}": ${invalidCodes.join(', ')}`
      );
    }

    return validatedFeatures;
  }

  /**
   * Computes the bounding box for a GeoJSON geometry's coordinates.
   * @param {Array} coordinates
   * @returns {{ bbMinLat: number, bbMaxLat: number, bbMinLng: number, bbMaxLng: number }}
   */
  computeBoundingBox(coordinates) {
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
    return {
      bbMinLng: minLng,
      bbMaxLng: maxLng,
      bbMinLat: minLat,
      bbMaxLat: maxLat,
    };
  }
}

export default new GeoService();
