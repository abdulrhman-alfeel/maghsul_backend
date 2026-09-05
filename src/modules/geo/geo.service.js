import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import ApiError from '../../helpers/apiError.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CANONICAL_PATH = join(__dirname, '../../../data/geo/riyadh_neighborhoods.geojson');
const DISPLAY_PATH = join(__dirname, '../../../data/geo/riyadh_neighborhoods_display.json');

class GeoService {
  constructor() {
    this._displayCatalog = null;
    this._displayETag = null;
    this._canonicalIndex = null; // Map of districtCode -> canonical Feature
  }

  /**
   * Lazy-loads display catalog in memory.
   */
  getDisplayCatalog() {
    if (!this._displayCatalog) {
      if (!existsSync(DISPLAY_PATH)) {
        throw new ApiError(500, 'GEO_CATALOG_UNAVAILABLE', 'Display geometry catalog has not been generated');
      }
      const raw = readFileSync(DISPLAY_PATH, 'utf-8');
      this._displayCatalog = JSON.parse(raw);
      const hash = createHash('sha256').update(raw).digest('hex');
      this._displayETag = `"${hash.slice(0, 16)}"`;
    }
    return {
      catalog: this._displayCatalog,
      etag: this._displayETag,
    };
  }

  /**
   * Lazy-loads and indexes canonical Riyadh neighborhoods for fast O(1) lookups.
   */
  getCanonicalIndex() {
    if (!this._canonicalIndex) {
      if (!existsSync(CANONICAL_PATH)) {
        throw new ApiError(500, 'CANONICAL_GEO_UNAVAILABLE', 'Authoritative canonical GeoJSON is missing');
      }
      const raw = JSON.parse(readFileSync(CANONICAL_PATH, 'utf-8'));
      const index = new Map();
      for (const feature of raw.features || []) {
        const code = String(feature.properties?.districtCode || feature.id);
        index.set(code, feature);
      }
      this._canonicalIndex = index;
    }
    return this._canonicalIndex;
  }

  /**
   * Validates and fetches exact canonical features for a list of district codes.
   * Throws 400 if any districtCode is invalid or unknown.
   *
   * @param {string[]} districtCodes
   * @returns {Array<object>} Canonical GeoJSON features
   */
  getCanonicalFeaturesByDistrictCodes(districtCodes) {
    if (!Array.isArray(districtCodes) || districtCodes.length === 0) {
      throw new ApiError(400, 'invalid_district_codes', 'districtCodes must be a non-empty array of strings');
    }

    const index = this.getCanonicalIndex();
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
        `The following district codes are not recognized in Riyadh City: ${invalidCodes.join(', ')}`
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
