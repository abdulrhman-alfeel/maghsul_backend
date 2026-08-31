import { jest } from '@jest/globals';
import crypto from 'crypto';
import prisma from '../../config/db.js';
import { setupTestDb, teardownTestDb, createTestWasher, createTestBranch } from './test-utils.js';
import { executeAccountDeletionCleanup } from '../../workers/accountDeletion.worker.js';

describe('Account Deletion Worker Integration Tests', () => {
  let washer, branch;

  beforeAll(async () => {
    await setupTestDb();
    const created = await createTestWasher({ name: 'Deletion Washer' });
    washer = created.washer;
    branch = await createTestBranch(washer.id, { name: 'Main Branch' });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  test('1. Expired pending_deletion identity is fully anonymized and revoked', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day in past

    // Create Identity pending deletion
    const identity = await prisma.identity.create({
      data: {
        phone: '966551112233',
        name: 'Ahmed Expirer',
        avatarUrl: 'https://example.com/avatar.png',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        scheduledDeletionAt: pastDate,
        deletionReason: 'No longer needed',
      }
    });

    const membership = await prisma.customerMembership.create({
      data: {
        identityId: identity.id,
        washerId: washer.id,
        status: 'active'
      }
    });

    // Create active session
    const session = await prisma.session.create({
      data: {
        identityId: identity.id,
        customerMembershipId: membership.id,
        washerId: washer.id,
        sessionType: 'operational',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    });

    // Create active refresh token
    const refreshToken = await prisma.refreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: 'sample-hash-12345',
        familyId: 'fam-del-1',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        isRevoked: false
      }
    });

    // Create user device
    const device = await prisma.userDevice.create({
      data: {
        identityId: identity.id,
        applicationId: 'com.laundry.customer',
        installationId: 'inst-del-1',
        platform: 'ios',
        appType: 'customer',
        fcmToken: 'fcm-token-live',
        tokenStatus: 'active'
      }
    });

    // Run cleanup
    const result = await executeAccountDeletionCleanup(new Date());
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.successCount).toBeGreaterThanOrEqual(1);

    // Verify Identity
    const updatedIdentity = await prisma.identity.findUnique({ where: { id: identity.id } });
    expect(updatedIdentity.status).toBe('deleted');
    expect(updatedIdentity.name).toBe('مستخدم محذوف');
    expect(updatedIdentity.phone.startsWith('anon_')).toBe(true);
    expect(updatedIdentity.avatarUrl).toBeNull();
    expect(updatedIdentity.deletedAt).not.toBeNull();
    expect(updatedIdentity.anonymizedAt).not.toBeNull();

    // Verify Session
    const updatedSession = await prisma.session.findUnique({ where: { id: session.id } });
    expect(updatedSession.isRevoked).toBe(true);
    expect(updatedSession.revokedReason).toBe('account_deleted');

    // Verify Refresh Token
    const updatedToken = await prisma.refreshToken.findUnique({ where: { id: refreshToken.id } });
    expect(updatedToken.isRevoked).toBe(true);
    expect(updatedToken.revokedReason).toBe('account_deleted');

    // Verify User Device
    const updatedDevice = await prisma.userDevice.findUnique({ where: { id: device.id } });
    expect(updatedDevice.tokenStatus).toBe('invalid');
    expect(updatedDevice.fcmToken).toBeNull();
  });

  test('2. Historical Orders Preserved -> Order and CustomerMembership remain intact with valid ownership relations', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const orderIdentity = await prisma.identity.create({
      data: {
        phone: '966552223344',
        name: 'Order Owner',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        scheduledDeletionAt: pastDate,
      }
    });

    const membership = await prisma.customerMembership.create({
      data: {
        identityId: orderIdentity.id,
        washerId: washer.id,
        status: 'active'
      }
    });

    const historicalOrder = await prisma.order.create({
      data: {
        washerId: washer.id,
        branchId: branch.id,
        customerMembershipId: membership.id,
        publicNumber: 8001,
        idempotencyKey: crypto.randomUUID(),
        contentHash: 'sample-content-hash-del-1',
        pickupLat: 24.7136,
        pickupLng: 46.6753,
        deliveryLat: 24.7136,
        deliveryLng: 46.6753,
        subtotal: 7500,
        totalPrice: 7500,
        status: 'delivered',
        paymentStatus: 'paid',
        paymentMethod: 'online',
      }
    });

    // Run account deletion cleanup
    const result = await executeAccountDeletionCleanup(new Date());
    expect(result.successCount).toBeGreaterThanOrEqual(1);

    // 1. Verify Identity was anonymized
    const anonymizedIdentity = await prisma.identity.findUnique({ where: { id: orderIdentity.id } });
    expect(anonymizedIdentity.status).toBe('deleted');
    expect(anonymizedIdentity.phone.startsWith('anon_')).toBe(true);

    // 2. Verify Historical Order STILL EXISTS
    const retrievedOrder = await prisma.order.findUnique({ where: { id: historicalOrder.id } });
    expect(retrievedOrder).not.toBeNull();
    expect(retrievedOrder.id).toBe(historicalOrder.id);
    expect(retrievedOrder.customerMembershipId).toBe(membership.id);
    expect(retrievedOrder.washerId).toBe(washer.id);
    expect(retrievedOrder.branchId).toBe(branch.id);
    expect(retrievedOrder.totalPrice).toBe(7500);
    expect(retrievedOrder.status).toBe('delivered');

    // 3. Verify CustomerMembership STILL EXISTS and links to identity
    const retrievedMembership = await prisma.customerMembership.findUnique({ where: { id: membership.id } });
    expect(retrievedMembership).not.toBeNull();
    expect(retrievedMembership.identityId).toBe(orderIdentity.id);
    expect(retrievedMembership.washerId).toBe(washer.id);

    // 4. Verify Washer & Branch still exist
    const retrievedWasher = await prisma.washer.findUnique({ where: { id: washer.id } });
    const retrievedBranch = await prisma.branch.findUnique({ where: { id: branch.id } });
    expect(retrievedWasher).not.toBeNull();
    expect(retrievedBranch).not.toBeNull();
  });

  test('3. Historical Payments & Financial History Preserved -> Order, Payment, and Refund records remain queryable after Identity anonymization', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const finIdentity = await prisma.identity.create({
      data: {
        phone: '966553334455',
        name: 'Financial Audit Customer',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        scheduledDeletionAt: pastDate,
      }
    });

    const membership = await prisma.customerMembership.create({
      data: {
        identityId: finIdentity.id,
        washerId: washer.id,
        status: 'active'
      }
    });

    const finOrder = await prisma.order.create({
      data: {
        washerId: washer.id,
        branchId: branch.id,
        customerMembershipId: membership.id,
        publicNumber: 8002,
        idempotencyKey: crypto.randomUUID(),
        contentHash: 'sample-content-hash-del-2',
        pickupLat: 24.7136,
        pickupLng: 46.6753,
        deliveryLat: 24.7136,
        deliveryLng: 46.6753,
        subtotal: 10000,
        totalPrice: 10000,
        status: 'delivered',
        paymentStatus: 'paid',
        paymentMethod: 'online',
      }
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: finOrder.id,
        provider: 'moyasar',
        externalId: `pay_audit_${Date.now()}`,
        amount: 10000,
        currency: 'SAR',
        status: 'paid',
        method: 'creditcard',
      }
    });

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        orderId: finOrder.id,
        externalRefundId: `ref_audit_${Date.now()}`,
        amount: 2500,
        currency: 'SAR',
        reason: 'Partial returned item refund',
        status: 'completed',
      }
    });

    // Run account deletion cleanup
    await executeAccountDeletionCleanup(new Date());

    // 1. Identity is deleted/anonymized
    const anonymizedIdentity = await prisma.identity.findUnique({ where: { id: finIdentity.id } });
    expect(anonymizedIdentity.status).toBe('deleted');

    // 2. Order remains queryable
    const checkOrder = await prisma.order.findUnique({ where: { id: finOrder.id } });
    expect(checkOrder).not.toBeNull();
    expect(checkOrder.totalPrice).toBe(10000);

    // 3. Payment remains intact and queryable
    const checkPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(checkPayment).not.toBeNull();
    expect(checkPayment.orderId).toBe(finOrder.id);
    expect(checkPayment.amount).toBe(10000);
    expect(checkPayment.status).toBe('paid');

    // 4. Refund remains intact and queryable
    const checkRefund = await prisma.refund.findUnique({ where: { id: refund.id } });
    expect(checkRefund).not.toBeNull();
    expect(checkRefund.paymentId).toBe(payment.id);
    expect(checkRefund.orderId).toBe(finOrder.id);
    expect(checkRefund.amount).toBe(2500);
    expect(checkRefund.status).toBe('completed');
  });

  test('4. Worker Idempotency -> Executing cleanup twice does not reprocess deleted identity or cause duplicate side effects', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const idempIdentity = await prisma.identity.create({
      data: {
        phone: '966554445566',
        name: 'Idempotent Customer',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        scheduledDeletionAt: pastDate,
      }
    });

    const membership = await prisma.customerMembership.create({
      data: {
        identityId: idempIdentity.id,
        washerId: washer.id,
        status: 'active'
      }
    });

    const session = await prisma.session.create({
      data: {
        identityId: idempIdentity.id,
        customerMembershipId: membership.id,
        washerId: washer.id,
        sessionType: 'operational',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    });

    // First cleanup run
    const result1 = await executeAccountDeletionCleanup(new Date());
    expect(result1.successCount).toBeGreaterThanOrEqual(1);

    const snapshot1 = await prisma.identity.findUnique({ where: { id: idempIdentity.id } });
    expect(snapshot1.status).toBe('deleted');
    expect(snapshot1.phone.startsWith('anon_')).toBe(true);
    const firstDeletedAt = snapshot1.deletedAt;
    const firstAnonymizedAt = snapshot1.anonymizedAt;
    const firstAnonPhone = snapshot1.phone;

    // Second cleanup run (IDEMPOTENCY PROOF)
    const result2 = await executeAccountDeletionCleanup(new Date());
    expect(result2.errorCount).toBe(0);

    const snapshot2 = await prisma.identity.findUnique({ where: { id: idempIdentity.id } });
    expect(snapshot2.status).toBe('deleted');
    expect(snapshot2.phone).toBe(firstAnonPhone);
    expect(snapshot2.deletedAt.getTime()).toBe(firstDeletedAt.getTime());
    expect(snapshot2.anonymizedAt.getTime()).toBe(firstAnonymizedAt.getTime());

    const sessionCheck = await prisma.session.findUnique({ where: { id: session.id } });
    expect(sessionCheck.isRevoked).toBe(true);
  });

  test('5. Batch Failure Isolation -> Error during one identity transaction does not abort batch and leaves unaffected identities processed', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const identityA = await prisma.identity.create({
      data: {
        phone: '966558800001',
        name: 'Batch User A',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        scheduledDeletionAt: pastDate,
      }
    });

    const identityB = await prisma.identity.create({
      data: {
        phone: '966558800002',
        name: 'Batch User B (Failing)',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        scheduledDeletionAt: pastDate,
      }
    });

    const identityC = await prisma.identity.create({
      data: {
        phone: '966558800003',
        name: 'Batch User C',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        scheduledDeletionAt: pastDate,
      }
    });

    // Controlled test-only spy: fail transaction for Identity B on the 2nd batch iteration
    const originalTx = prisma.$transaction.bind(prisma);
    let txCallCount = 0;
    const txSpy = jest.spyOn(prisma, '$transaction').mockImplementation(async (ops, opts) => {
      txCallCount++;
      if (txCallCount === 2) {
        throw new Error('Simulated transient database transaction failure for Identity B');
      }
      return originalTx(ops, opts);
    });

    let batchResult;
    try {
      batchResult = await executeAccountDeletionCleanup(new Date());
    } finally {
      txSpy.mockRestore();
    }

    expect(batchResult.processed).toBeGreaterThanOrEqual(3);
    expect(batchResult.successCount).toBeGreaterThanOrEqual(2);
    expect(batchResult.errorCount).toBeGreaterThanOrEqual(1);

    // Identity A: successfully anonymized
    const checkA = await prisma.identity.findUnique({ where: { id: identityA.id } });
    expect(checkA.status).toBe('deleted');
    expect(checkA.phone.startsWith('anon_')).toBe(true);

    // Identity B: failed cleanly without partial corruption, remains pending_deletion
    const checkB = await prisma.identity.findUnique({ where: { id: identityB.id } });
    expect(checkB.status).toBe('pending_deletion');
    expect(checkB.phone).toBe('966558800002');
    expect(checkB.name).toBe('Batch User B (Failing)');
    expect(checkB.deletedAt).toBeNull();
    expect(checkB.anonymizedAt).toBeNull();

    // Identity C: successfully anonymized despite B failing
    const checkC = await prisma.identity.findUnique({ where: { id: identityC.id } });
    expect(checkC.status).toBe('deleted');
    expect(checkC.phone.startsWith('anon_')).toBe(true);

    // Anonymous phone uniqueness between A and C
    expect(checkA.phone).not.toBe(checkC.phone);
  });

  test('6. Identity scheduled for deletion in the FUTURE is NOT touched', async () => {
    const futureDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000); // 15 days in future

    const futureIdentity = await prisma.identity.create({
      data: {
        phone: '966559998877',
        name: 'Future Deletion',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(),
        scheduledDeletionAt: futureDate,
      }
    });

    await executeAccountDeletionCleanup(new Date());

    const check = await prisma.identity.findUnique({ where: { id: futureIdentity.id } });
    expect(check.status).toBe('pending_deletion');
    expect(check.name).toBe('Future Deletion');
    expect(check.phone).toBe('966559998877');
    expect(check.deletedAt).toBeNull();
  });

  test('7. Active identity is NOT touched by worker', async () => {
    const activeIdentity = await prisma.identity.create({
      data: {
        phone: '966554443322',
        name: 'Active Customer',
        status: 'active',
      }
    });

    await executeAccountDeletionCleanup(new Date());

    const check = await prisma.identity.findUnique({ where: { id: activeIdentity.id } });
    expect(check.status).toBe('active');
    expect(check.name).toBe('Active Customer');
    expect(check.phone).toBe('966554443322');
  });
});
