import { ApplicationRegistryService, validateApplicationScope, validateApplicationFormat, ApplicationRegistry } from '../../config/application.registry.js';
import prisma from '../../config/db.js';

describe('Dynamic Application Registry Service Unit Suite', () => {
  it('1. Rejects invalid application format', async () => {
    expect(() => validateApplicationFormat('')).toThrow('Application identifier must be a non-empty string.');
    expect(() => validateApplicationFormat(null)).toThrow('Application identifier must be a non-empty string.');
    expect(() => validateApplicationFormat('a'.repeat(65))).toThrow('Application identifier too long.');
    expect(() => validateApplicationFormat('app with spaces')).toThrow('Application identifier contains invalid characters.');
  });

  it('2. Resolves built-in system scopes', async () => {
    const staff = await ApplicationRegistryService.resolveApplication('com.staff');
    expect(staff).toBeDefined();
    expect(staff.appType).toBe('dashboard');
    expect(staff.isActive).toBe(true);

    const scope = await validateApplicationScope('com.staff', 'dashboard');
    expect(scope.applicationId).toBe('com.staff');
    expect(scope.appType).toBe('dashboard');
  });

  it('3. Rejects unknown bundle identifiers', async () => {
    await expect(validateApplicationScope('com.unknown.nonexistent')).rejects.toThrow('Unknown bundle identifier');
  });

  it('4. Rejects disabled application identifiers', async () => {
    await expect(validateApplicationScope('com.disabled')).rejects.toThrow('Disabled application identifier');
  });

  it('5. Rejects session application scope mismatch', async () => {
    await expect(validateApplicationScope('com.staff', 'customer')).rejects.toThrow('Session application scope mismatch');
  });

  it('6. Resolves dynamic database AppClient records', async () => {
    const testWasher = await prisma.washer.create({
      data: { name: 'Dynamic Registry Washer', status: 'active' }
    });

    const dynamicAppKey = `com.dynamic.${Date.now()}.customer`;
    await prisma.appClient.create({
      data: {
        washerId: testWasher.id,
        appKey: dynamicAppKey,
        appName: 'Dynamic App',
        platform: 'both',
        isActive: true
      }
    });

    const resolved = await ApplicationRegistryService.resolveApplication(dynamicAppKey);
    expect(resolved).toBeDefined();
    expect(resolved.applicationId).toBe(dynamicAppKey);
    expect(resolved.washerId).toBe(testWasher.id);
    expect(resolved.appType).toBe('customer');

    const scope = await validateApplicationScope(dynamicAppKey, 'customer');
    expect(scope.washerId).toBe(testWasher.id);

    // Invalidate cache
    await ApplicationRegistryService.invalidate(dynamicAppKey);
  });
});
