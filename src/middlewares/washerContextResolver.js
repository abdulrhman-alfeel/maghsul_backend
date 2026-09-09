import prisma from '../config/db.js';
import ApiError from '../helpers/apiError.js';

/**
 * Customer Washer Context Resolver Middleware
 *
 * Strict Canonical Strategy:
 * X-Washer-Id
 *   ↓ validate format
 *   ↓ prisma.washer.findUnique({ where: { id } })
 *   ↓ verify exists
 *   ↓ verify status === 'active'
 *   ↓ attach req.washerContext
 *   ↓ next()
 *
 * Fail Closed:
 * - Missing or invalid header → 400 WASHER_HEADER_REQUIRED
 * - Washer does not exist in DB → 404 WASHER_NOT_FOUND
 * - Washer status !== 'active' → 403 WASHER_INACTIVE
 *
 * Zero secondary strategy. Zero fallback to AppClient or ApplicationRegistry.
 */
export default async function washerContextResolver(req, res, next) {
  try {
    const rawHeader = req.headers['x-washer-id'];
    if (!rawHeader || typeof rawHeader !== 'string' || !rawHeader.trim()) {
      throw new ApiError(400, 'WASHER_HEADER_REQUIRED', 'X-Washer-Id header is required');
    }

    const washerId = rawHeader.trim();
    if (washerId.length > 64) {
      throw new ApiError(400, 'WASHER_HEADER_INVALID', 'X-Washer-Id header is too long');
    }

    const washer = await prisma.washer.findUnique({
      where: { id: washerId },
      select: { id: true, name: true, status: true }
    });

    if (!washer) {
      throw new ApiError(404, 'WASHER_NOT_FOUND', 'Washer not found');
    }

    if (washer.status !== 'active') {
      throw new ApiError(403, 'WASHER_INACTIVE', 'المغسلة غير مفعلة حالياً');
    }

    req.washerContext = Object.freeze({
      washerId: washer.id,
      washerName: washer.name
    });

    // Provide safe read-only appClient shim containing only the exact validated washer
    req.appClient = Object.freeze({
      appClientId: washer.id,
      appKey: washer.id,
      washerId: washer.id,
      isActive: true,
      appName: washer.name
    });

    return next();
  } catch (err) {
    next(err);
  }
}
