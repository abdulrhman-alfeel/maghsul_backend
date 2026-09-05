import GeoService from './geo.service.js';
import { ok } from '../../helpers/apiResponse.js';

class GeoController {
  /**
   * GET /api/geo/riyadh-neighborhoods
   * Serves optimized display geometry for 165 Riyadh neighborhoods.
   * Supports HTTP caching with ETag and Cache-Control headers.
   */
  getRiyadhNeighborhoods(req, res) {
    const { catalog, etag } = GeoService.getDisplayCatalog();

    // Check client ETag for 304 Not Modified
    const clientETag = req.headers['if-none-match'];
    if (clientETag && clientETag === etag) {
      return res.status(304).end();
    }

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    return ok(res, catalog, 'Riyadh neighborhoods display catalog');
  }

  /**
   * GET /api/geo/neighborhoods?city=riyadh
   * Generic city neighborhood catalog dispatcher.
   */
  getNeighborhoodsByCity(req, res) {
    const city = String(req.query.city || 'riyadh').toLowerCase();
    if (city === 'riyadh') {
      return this.getRiyadhNeighborhoods(req, res);
    }
    return res.status(404).json({
      ok: false,
      message: `City '${city}' is not currently supported for neighborhood coverage`,
    });
  }
}

export default new GeoController();
