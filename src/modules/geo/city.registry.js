/**
 * src/modules/geo/city.registry.js
 *
 * Generic City Registry for geographic neighborhood catalog.
 * Supports extensible multi-city deployment (Riyadh, Jeddah, Dammam, etc.)
 * without code changes per city.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../../data/geo');

export const CITY_REGISTRY = {
  riyadh: {
    cityCode: 'riyadh',
    nameAr: 'الرياض',
    nameEn: 'Riyadh',
    center: { lat: 24.7136, lng: 46.6753 },
    canonicalPath: path.join(DATA_DIR, 'riyadh_neighborhoods.geojson'),
    displayPath: path.join(DATA_DIR, 'riyadh_neighborhoods_display.json'),
    metaPath: path.join(DATA_DIR, 'riyadh_neighborhoods_display.meta.json'),
    cacheKey: 'geo:catalog:riyadh',
    version: '1.0'
  }
};

/**
 * Resolves city configuration by code (case-insensitive)
 * @param {string} cityCode
 * @returns {object|null}
 */
export function getCityConfig(cityCode) {
  if (!cityCode || typeof cityCode !== 'string') return null;
  const code = cityCode.trim().toLowerCase();
  return CITY_REGISTRY[code] || null;
}

/**
 * Returns list of supported city codes
 * @returns {string[]}
 */
export function getSupportedCityCodes() {
  return Object.keys(CITY_REGISTRY);
}
