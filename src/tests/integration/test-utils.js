
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';

export async function setupTestDb() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRITICAL: Cannot run tests in production environment');
  }
  
  if (!process.env.DATABASE_URL_TEST) {
    throw new Error('DATABASE_URL_TEST is required for testing');
  }
  
  if (
    process.env.ORIGINAL_DATABASE_URL &&
    process.env.DATABASE_URL_TEST === process.env.ORIGINAL_DATABASE_URL
  ) {
    throw new Error('CRITICAL: Test database URL must not be identical to development/production DATABASE_URL');
  }

  if (process.env.DATABASE_URL !== process.env.DATABASE_URL_TEST) {
    throw new Error('CRITICAL: Prisma is not configured to use DATABASE_URL_TEST');
  }

  if (
    process.env.DATABASE_URL_TEST.includes('laundry_db') && 
    !process.env.DATABASE_URL_TEST.includes('test') &&
    !process.env.DATABASE_URL_TEST.includes('laundry_db_test')
  ) {
    throw new Error('CRITICAL: Test database URL must clearly point to a test database (e.g. containing "test")');
  }

  // Clean DB - Only if it's the test DB
  if (process.env.DATABASE_URL.includes('laundry_db_test')) {
    if (redis && typeof redis.flushdb === 'function') {
      try {
        await redis.flushdb();
      } catch (e) {}
    }
    await prisma.otpCode.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.branchPermissionOverride.deleteMany();
    await prisma.branchAccess.deleteMany();
    await prisma.notificationDelivery.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.notificationOutboxEvent.deleteMany();
    await prisma.realtimeOutboxEvent.deleteMany();
    await prisma.staffInvitation.deleteMany();
    await prisma.driverTask.deleteMany({});
    await prisma.orderItem.deleteMany({});
    await prisma.orderEvent.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.invoice.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.staffMembership.deleteMany();
    await prisma.customerMembershipAddress.deleteMany();
    await prisma.customerMembership.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.userDevice.deleteMany();
    await prisma.productOverride.deleteMany();
    await prisma.branchSchedule.deleteMany();
    await prisma.branchPaymentMethod.deleteMany();
    await prisma.coverageZone.deleteMany();
    await prisma.branch.deleteMany();
    await prisma.staffInvitation.deleteMany();
    await prisma.rolePermission.deleteMany();
    await prisma.branchPermissionOverride.deleteMany();
    await prisma.permission.deleteMany();
    await prisma.appClient.deleteMany();
    await prisma.washer.deleteMany();
    await prisma.identityAddress.deleteMany();
    await prisma.identity.deleteMany();
  }
}

export async function teardownTestDb() {
  await prisma.$disconnect();
  try {
    redis.disconnect();
  } catch (e) {
    // ignore
  }
}

/**
 * Creates a test Washer + AppClient for customer auth tests.
 */
export async function createTestWasher(overrides = {}) {
  const { appKey, isActive, ...washerOverrides } = overrides;
  const washer = await prisma.washer.create({
    data: {
      name: washerOverrides.name || 'Test Washer',
      status: washerOverrides.status || 'active',
      ...washerOverrides
    }
  });
  const appClient = await prisma.appClient.create({
    data: {
      washerId: washer.id,
      appKey: appKey || `test-key-${washer.id}`,
      isActive: isActive !== undefined ? isActive : true
    }
  });
  return { washer, appClient };
}

/**
 * Creates a test Branch for a washer.
 */
export async function createTestBranch(washerId, overrides = {}) {
  return prisma.branch.create({
    data: {
      washerId,
      name: overrides.name || 'Test Branch',
      status: overrides.status || 'active',
      ...overrides
    }
  });
}

/**
 * Creates a test Identity.
 */
export async function createTestIdentity(phone, overrides = {}) {
  return prisma.identity.upsert({
    where: { phone },
    update: {},
    create: { phone, ...overrides }
  });
}

/**
 * Creates a CustomerMembership.
 */
export async function createCustomerMembership(identityId, washerId, overrides = {}) {
  return prisma.customerMembership.upsert({
    where: { identityId_washerId: { identityId, washerId } },
    update: {},
    create: { identityId, washerId, status: 'active', ...overrides }
  });
}

/**
 * Creates a StaffMembership with optional branch access.
 */
export async function createStaffMembership(identityId, washerId, branchId = null, overrides = {}) {
  const membership = await prisma.staffMembership.upsert({
    where: { identityId_washerId: { identityId, washerId } },
    update: {},
    create: {
      identityId,
      washerId,
      role: overrides.role || 'worker',
      status: 'active',
      hasFullWasherAccess: overrides.hasFullWasherAccess || false,
      ...overrides
    }
  });

  if (branchId && !overrides.hasFullWasherAccess) {
    await prisma.branchAccess.upsert({
      where: { staffMembershipId_branchId: { staffMembershipId: membership.id, branchId } },
      update: {},
      create: { staffMembershipId: membership.id, branchId }
    });
  }

  return membership;
}
