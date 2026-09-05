import GeoService from './geo.service.js';
import { ok } from '../../helpers/apiResponse.js';

class GeoController {
  /**
   * GET /api/geo/cities/:cityCode/neighborhoods
   * Serves optimized display geometry for neighborhoods in the requested city.
   * Supports HTTP caching with ETag and Cache-Control headers.
   */
  getCityNeighborhoods = (req, res) => {
    const cityCode = String(req.params.cityCode || 'riyadh').trim().toLowerCase();
    const { catalog, etag } = GeoService.getDisplayCatalog(cityCode);

    // Check client ETag for 304 Not Modified
    const clientETag = req.headers['if-none-match'];
    if (clientETag && clientETag === etag) {
      return res.status(304).end();
    }

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    return ok(res, catalog, `${cityCode} neighborhoods display catalog`);
  };

  /**
   * GET /api/geo/riyadh-neighborhoods
   * Temporary backward-compatible alias delegating directly to cityCode = 'riyadh'.
   */
  getRiyadhNeighborhoods = (req, res) => {
    req.params.cityCode = 'riyadh';
    return this.getCityNeighborhoods(req, res);
  };
}

export default new GeoController();
