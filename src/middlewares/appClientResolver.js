import { ApplicationRegistryService } from '../config/application.registry.js';
import ApiError from '../helpers/apiError.js';

/**
 * AppClient Resolver Middleware
 *
 * Unified Dynamic Resolution Strategy:
 * 1. X-App-Client-Key header → DB AppClient / cache lookup (returns { appClientId, washerId, isActive })
 * 2. X-Application-Id header → DB AppClient / cache lookup (returns { appClientId, appKey, washerId, isActive })
 *
 * Security:
 * - appKey / applicationId are NOT security secrets; they identify the client application.
 * - washerId MUST only come from AppClient/ApplicationRegistry, never from request body/query.
 */
export default async function appClientResolver(req, res, next) {
  try {
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
