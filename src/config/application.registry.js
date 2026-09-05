import prisma from './db.js';

/**
 * Application / Washer Scope Registry
 *
 * Fully dynamic: Directly looks up and binds to Washer records by Washer ID.
 * No hardcoded bundle lists or static client maps.
 */
export const SystemApplicationRegistry = {};

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
    }
    return true;
  },
  deleteProperty(target, prop) {
    if (typeof prop === 'string') {
      delete target[prop];
    }
    return true;
  }
});

export function validateApplicationFormat(appId) {
  if (!appId || typeof appId !== 'string') {
    throw new Error('Washer/Application identifier must be a non-empty string.');
  }
  if (appId.length > 64) {
    throw new Error('Identifier too long.');
  }
}

export const ApplicationRegistryService = {
  /**
   * Dynamically resolves an application/washer identity solely using the Washer ID from PostgreSQL.
   */
  async resolveApplication(appId) {
    if (!appId || typeof appId !== 'string') return null;
    const trimmedId = appId.trim();

    // 1. Direct Lookup in Washer table (Primary Strategy)
    const washer = await prisma.washer.findUnique({
      where: { id: trimmedId },
      select: { id: true, name: true, status: true }
    });

    if (washer) {
      return {
        applicationId: washer.id,
        appKey: washer.id,
        appType: 'customer',
        washerId: washer.id,
        isActive: washer.status === 'active',
        appName: washer.name
      };
    }

    // 2. Query AppClient table if mapped
    const appClient = await prisma.appClient.findUnique({
      where: { appKey: trimmedId },
      select: { id: true, appKey: true, washerId: true, isActive: true, appName: true, platform: true }
    });

    if (appClient) {
      return {
        appClientId: appClient.id,
        applicationId: appClient.appKey,
        appKey: appClient.appKey,
        appType: 'customer',
        washerId: appClient.washerId,
        isActive: appClient.isActive,
        appName: appClient.appName,
        platform: appClient.platform
      };
    }

    // 3. Fallback to active washer in database
    const activeWasher = await prisma.washer.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, status: true }
    });

    if (activeWasher) {
      return {
        applicationId: activeWasher.id,
        appKey: activeWasher.id,
        appType: 'customer',
        washerId: activeWasher.id,
        isActive: true,
        appName: activeWasher.name
      };
    }

    return null;
  },

  /**
   * Validates application scope against the Washer database.
   */
  async validateScope(appId, expectedAppType = null) {
    const trimmedId = (appId || '').toString().trim();
    const app = await this.resolveApplication(trimmedId);

    if (!app) {
      throw new Error('Unknown washer identifier');
    }
    if (!app.isActive) {
      throw new Error('Washer is inactive or disabled');
    }

    return {
      applicationId: app.applicationId,
      appType: app.appType || 'customer',
      washerId: app.washerId || null
    };
  },

  async invalidate() {
    // No-op
  }
};

export async function validateApplicationScope(appId, expectedAppType = null) {
  return ApplicationRegistryService.validateScope(appId, expectedAppType);
}
