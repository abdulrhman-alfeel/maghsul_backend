import prisma from './db.js';
import redis from './redis.js';

const CACHE_TTL_SECONDS = 900; // 15 minutes
const CACHE_PREFIX = 'app_client:';

// Built-in system scopes for dashboard/staff tools and standard default bundle fallback
export const SystemApplicationRegistry = {
  'com.laundry.customer': { appType: 'customer', isActive: true, platform: 'ios/android', washerId: null },
  'com.tenant.customer': { appType: 'customer', isActive: true, platform: 'ios/android', washerId: null },
  'com.staff': { appType: 'dashboard', isActive: true, platform: 'ios/android', washerId: null },
  'com.staff.secondary': { appType: 'dashboard', isActive: true, platform: 'ios/android', washerId: null },
  'dashboard-app': { appType: 'dashboard', isActive: true, platform: 'web', washerId: null },
  'customer-app': { appType: 'customer', isActive: true, platform: 'web', washerId: null },
  'com.disabled': { appType: 'customer', isActive: false, platform: 'web', washerId: null },
};

// Dynamic in-memory map supporting runtime inspection and test mocks
export const ApplicationRegistry = new Proxy(SystemApplicationRegistry, {
  get(target, prop) {
    if (typeof prop === 'string' && prop in target) {
      return target[prop];
    }
    return undefined;
  },
  set(target, prop, value) {
    if (typeof prop === 'string') {
      target[prop] = value;
      // Invalidate Redis cache if modified dynamically
      if (redis && typeof redis.del === 'function') {
        redis.del(`${CACHE_PREFIX}${prop}`).catch(() => {});
      }
    }
    return true;
  },
  deleteProperty(target, prop) {
    if (typeof prop === 'string') {
      delete target[prop];
      if (redis && typeof redis.del === 'function') {
        redis.del(`${CACHE_PREFIX}${prop}`).catch(() => {});
      }
    }
    return true;
  }
});

export function validateApplicationFormat(appId) {
  if (!appId || typeof appId !== 'string') {
    throw new Error('Application identifier must be a non-empty string.');
  }
  if (appId.length > 64) {
    throw new Error('Application identifier too long.');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(appId)) {
    throw new Error('Application identifier contains invalid characters.');
  }
}

export const ApplicationRegistryService = {
  /**
   * Dynamically resolves an application identity from cache, in-memory system scopes, or PostgreSQL DB.
   * @param {string} appId
   * @returns {Promise<{ applicationId: string, appKey: string, appType: string, washerId: string|null, isActive: boolean }|null>}
   */
  async resolveApplication(appId) {
    if (!appId || typeof appId !== 'string') return null;
    const trimmedId = appId.trim();
    validateApplicationFormat(trimmedId);

    // 1. Check in-memory/system override registry if explicit washer is mocked
    if (SystemApplicationRegistry[trimmedId] && SystemApplicationRegistry[trimmedId].washerId) {
      const entry = SystemApplicationRegistry[trimmedId];
      return {
        applicationId: trimmedId,
        appKey: trimmedId,
        appType: entry.appType,
        washerId: entry.washerId || null,
        isActive: entry.isActive
      };
    }

    // 2. Check Redis cache (in non-test environments)
    const isTest = process.env.NODE_ENV === 'test';
    const cacheKey = `${CACHE_PREFIX}${trimmedId}`;
    if (!isTest && redis && typeof redis.get === 'function') {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (err) {
        // Fallback to DB
      }
    }

    // 3. Query PostgreSQL AppClient table
    const appClient = await prisma.appClient.findUnique({
      where: { appKey: trimmedId },
      select: { id: true, appKey: true, washerId: true, isActive: true, appName: true, platform: true }
    });

    if (appClient) {
      const resolved = {
        appClientId: appClient.id,
        applicationId: appClient.appKey,
        appKey: appClient.appKey,
        appType: 'customer',
        washerId: appClient.washerId,
        isActive: appClient.isActive,
        appName: appClient.appName,
        platform: appClient.platform
      };

      // Cache in Redis
      if (!isTest && redis && typeof redis.setex === 'function') {
        try {
          await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(resolved));
        } catch (err) {
          // Ignore cache write failure
        }
      }

      return resolved;
    }

    // 4. Fallback to SystemApplicationRegistry without washerId
    if (SystemApplicationRegistry[trimmedId]) {
      const entry = SystemApplicationRegistry[trimmedId];
      return {
        applicationId: trimmedId,
        appKey: trimmedId,
        appType: entry.appType,
        washerId: entry.washerId || null,
        isActive: entry.isActive
      };
    }

    return null;
  },

  /**
   * Validates application scope and fails closed if unknown, disabled, or mismatched.
   */
  async validateScope(appId, expectedAppType = null) {
    validateApplicationFormat(appId);
    const trimmedId = appId.trim();
    const app = await this.resolveApplication(trimmedId);

    if (!app) {
      throw new Error('Unknown bundle identifier');
    }
    if (!app.isActive) {
      throw new Error('Disabled application identifier');
    }
    if (expectedAppType && app.appType !== expectedAppType) {
      throw new Error('Session application scope mismatch');
    }

    return {
      applicationId: app.applicationId,
      appType: app.appType,
      washerId: app.washerId || null
    };
  },

  /**
   * Invalidates cached application mapping across Redis.
   */
  async invalidate(appId) {
    if (!appId) return;
    const cacheKey = `${CACHE_PREFIX}${appId.trim()}`;
    if (redis && typeof redis.del === 'function') {
      try {
        await redis.del(cacheKey);
      } catch (err) {
        // Ignore
      }
    }
  }
};

export async function validateApplicationScope(appId, expectedAppType = null) {
  return ApplicationRegistryService.validateScope(appId, expectedAppType);
}
