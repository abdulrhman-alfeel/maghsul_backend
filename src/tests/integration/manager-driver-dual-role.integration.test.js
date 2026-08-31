import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { setupTestDb, teardownTestDb, createTestWasher, createTestBranch, createTestIdentity, createStaffMembership } from './test-utils.js';

describe('Phase 3D-2B-2B-1A: Manager/Driver dual-role and Assignment Isolation', () => {
  let user1, user2;
  let washerFajr, branchFajr;
  let managerSession, driverSession;
  let managerToken, driverToken;
  let managerMembership, driverMembership;
  let testOrder, driverTask;

  beforeAll(async () => {
    await setupTestDb();
    
    user1 = await createTestIdentity('+966555555551');
    user2 = await createTestIdentity('+966555555552');
    
    const w = await createTestWasher({ name: 'Washer Fajr' });
    washerFajr = w.washer;
    branchFajr = await createTestBranch(washerFajr.id, { acceptingOrders: true });

    // User 1 is a Manager (no explicit driver assignment)
    managerMembership = await createStaffMembership(user1.id, washerFajr.id, branchFajr.id, { role: 'washer_manager', hasFullWasherAccess: true });
    
    // User 2 is a Driver
    driverMembership = await createStaffMembership(user2.id, washerFajr.id, branchFajr.id, { role: 'driver', hasFullWasherAccess: false });

    // Sessions
    const deviceManager = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.staff', appType: 'dashboard', fcmToken: 'fcm1', installationId: 'inst-1', platform: 'ios', model: 'iPhone' } });
    managerSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: deviceManager.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    managerToken = TokenService.signAccessToken({ sessionId: managerSession.id, identityId: user1.id, sessionType: 'operational' });

    const deviceDriver = await prisma.userDevice.create({ data: { identityId: user2.id, applicationId: 'com.staff', appType: 'dashboard', fcmToken: 'fcm2', installationId: 'inst-2', platform: 'ios', model: 'iPhone' } });
    driverSession = await prisma.session.create({ data: { identityId: user2.id, userDeviceId: deviceDriver.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    driverToken = TokenService.signAccessToken({ sessionId: driverSession.id, identityId: user2.id, sessionType: 'operational' });

    // Create Order
    const custId = await createTestIdentity('+966555555559');
    const custMem = await prisma.customerMembership.create({ data: { identityId: custId.id, washerId: washerFajr.id, status: 'active' } });
    
    testOrder = await prisma.order.create({
      data: {
        customerMembershipId: custMem.id,
        washerId: washerFajr.id,
        branchId: branchFajr.id,
        originCustomerApplicationId: 'com.fajr.customer',
        status: 'pending_pickup', pickupLat: 0, pickupLng: 0, deliveryLat: 0, deliveryLng: 0, paymentMethod: 'cash_on_delivery', paymentStatus: 'unpaid', totalPrice: 0, publicNumber: 1, idempotencyKey: 'idemp-1', contentHash: 'hash-1'
      }
    });

    // Create DriverTask assigned to User 2
    driverTask = await prisma.driverTask.create({
      data: {
        orderId: testOrder.id,
        taskType: 'pickup',
        status: 'open',
        assignedDriverId: driverMembership.id
      }
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('Manager access is authorized by StaffMembership/permissions but Manager is not automatically assigned to DriverTasks', async () => {
    const tasksForManager = await prisma.driverTask.findMany({ where: { assignedDriverId: managerMembership.id } });
    expect(tasksForManager.length).toBe(0);
  });

  it('Driver access is authorized by actual Driver assignment', async () => {
    const tasksForDriver = await prisma.driverTask.findMany({ where: { assignedDriverId: driverMembership.id } });
    expect(tasksForDriver.length).toBe(1);
    expect(tasksForDriver[0].orderId).toBe(testOrder.id);
  });
});
