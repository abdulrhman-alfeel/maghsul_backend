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

export const SYSTEM_SCOPES = {
  'com.staff': {
    applicationId: 'com.staff',
    appKey: 'com.staff',
    appType: 'dashboard',
    isActive: true,
    platform: 'web',
    appName: 'Staff Dashboard'
  },
  'com.disabled': {
    applicationId: 'com.disabled',
    appKey: 'com.disabled',
    appType: 'customer',
    isActive: false,
    platform: 'test',
    appName: 'Disabled Test App'
  }
};

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
   * Dynamically resolves an application/washer identity solely using Washer/AppClient records or built-in system scopes.
   */
  async resolveApplication(appId) {
    if (!appId || typeof appId !== 'string') return null;
    const trimmedId = appId.trim();

    // 1. Built-in system scope (e.g. staff dashboard)
    if (SYSTEM_SCOPES[trimmedId]) {
      return { ...SYSTEM_SCOPES[trimmedId] };
    }

    // 2. Direct Lookup in Washer table
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

    // 3. Query AppClient table if mapped
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

    return null;
  },

  /**
   * Validates application scope against the Washer database or built-in system scopes.
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
