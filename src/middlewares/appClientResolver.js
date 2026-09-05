import prisma from '../config/db.js';
import { ApplicationRegistryService } from '../config/application.registry.js';
import ApiError from '../helpers/apiError.js';

/**
 * AppClient Resolver Middleware
 *
 * Strategies:
 * 0. Direct Washer Identification (X-Washer-Id or Washer ID in X-Application-Id)
 * 1. X-App-Client-Key header
 * 2. X-Application-Id header
 */
export default async function appClientResolver(req, res, next) {
  try {
    // Strategy 0: Direct Washer ID Identification
    const candidateWasherId = (req.headers['x-washer-id'] || req.headers['x-application-id'] || '').toString().trim();
    if (candidateWasherId) {
      const directWasher = await prisma.washer.findUnique({
        where: { id: candidateWasherId },
        select: { id: true, name: true, status: true }
      });

      if (directWasher) {
        if (directWasher.status !== 'active') {
          throw new ApiError(403, 'WASHER_INACTIVE', 'المغسلة غير مفعلة حالياً');
        }

        req.appClient = {
          appClientId: directWasher.id,
          appKey: directWasher.id,
          washerId: directWasher.id,
          isActive: true,
          appName: directWasher.name
        };

        return next();
      }
    }

    // Strategy 1: X-App-Client-Key
    const appKey = req.headers['x-app-client-key'];
    if (appKey && typeof appKey === 'string' && appKey.trim()) {
      const app = await ApplicationRegistryService.resolveApplication(appKey.trim());

      if (!app) {
        throw new ApiError(401, 'APP_CLIENT_NOT_FOUND', 'Invalid application client key');
      }

      if (!app.isActive) {
        throw new ApiError(403, 'APP_CLIENT_INACTIVE', 'This application client is disabled');
      }

      req.appClient = {
        appClientId: app.appClientId || app.appKey,
        washerId: app.washerId,
        isActive: app.isActive
      };

      return next();
    }

    // Strategy 2: X-Application-Id
    const applicationId = req.headers['x-application-id'];
    if (applicationId && typeof applicationId === 'string' && applicationId.trim()) {
      const app = await ApplicationRegistryService.resolveApplication(applicationId.trim());

      if (!app) {
        throw new ApiError(401, 'APPLICATION_NOT_FOUND', 'Unknown application identifier');
      }

      if (!app.isActive) {
        throw new ApiError(403, 'APPLICATION_INACTIVE', 'This application is disabled');
      }

      req.appClient = {
        appClientId: app.appClientId || applicationId.trim(),
        appKey: applicationId.trim(),
        washerId: app.washerId || null,
        isActive: app.isActive
      };

      return next();
    }

    throw new ApiError(400, 'APP_CLIENT_KEY_MISSING', 'X-App-Client-Key or X-Application-Id header is required');
  } catch (err) {
    next(err);
  }
}
