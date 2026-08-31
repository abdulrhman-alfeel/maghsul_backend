import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { setupTestDb, teardownTestDb, createTestWasher, createTestBranch } from './test-utils.js';
import { signToken } from '../../utils/jwt.js';

describe('Users & Account Deletion Canonical Identity Integration Tests', () => {
  let washer, branch, identity, token;

  beforeAll(async () => {
    await setupTestDb();
    const created = await createTestWasher({ name: 'Identity Test Washer' });
    washer = created.washer;
    branch = await createTestBranch(washer.id, { name: 'Main Branch' });

    identity = await prisma.identity.create({
      data: {
        phone: '966512345678',
        name: 'Saad Tester',
        status: 'active'
      }
    });

    await prisma.customerMembership.create({
      data: {
        identityId: identity.id,
        washerId: washer.id,
        status: 'active'
      }
    });

    token = signToken({
      userId: identity.id,
      role: 'customer',
      washerId: washer.id
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  test('1. GET /api/users/me returns profile mapped from canonical Identity', async () => {
    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(identity.id);
    expect(res.body.data.phone).toBe('966512345678');
    expect(res.body.data.name).toBe('Saad Tester');
    expect(res.body.data.status).toBe('active');
  });

  test('2. PATCH /api/users/me updates Identity name and avatarUrl', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Saad Al-Tester', avatarUrl: 'https://example.com/saad.jpg' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe('Saad Al-Tester');

    const db = await prisma.identity.findUnique({ where: { id: identity.id } });
    expect(db.name).toBe('Saad Al-Tester');
    expect(db.avatarUrl).toBe('https://example.com/saad.jpg');
  });

  test('3. PUT /api/users/me/fcm-token upserts UserDevice', async () => {
    const res = await request(app)
      .put('/api/users/me/fcm-token')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fcmToken: 'test-fcm-token-saad',
        deviceType: 'ios',
        applicationId: 'com.laundry.customer',
        installationId: 'inst-saad-1'
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const dev = await prisma.userDevice.findFirst({
      where: { identityId: identity.id, fcmToken: 'test-fcm-token-saad' }
    });
    expect(dev).toBeTruthy();
    expect(dev.tokenStatus).toBe('active');
  });

  test('4. DELETE /api/users/me/account sets pending_deletion and invalidates devices', async () => {
    const res = await request(app)
      .delete('/api/users/me/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Moving abroad' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('pending_deletion');
    expect(res.body.data.scheduledDeletionAt).toBeTruthy();

    const idty = await prisma.identity.findUnique({ where: { id: identity.id } });
    expect(idty.status).toBe('pending_deletion');
    expect(idty.deletionReason).toBe('Moving abroad');

    const devices = await prisma.userDevice.findMany({ where: { identityId: identity.id } });
    for (const d of devices) {
      expect(d.tokenStatus).toBe('invalid');
      expect(d.fcmToken).toBeNull();
    }
  });

  test('5. GET /api/users/me/account/deletion-status returns deletion info', async () => {
    const res = await request(app)
      .get('/api/users/me/account/deletion-status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('pending_deletion');
    expect(res.body.data.canRestore).toBe(true);
  });

  test('6. Normal route access during pending_deletion is blocked (403)', async () => {
    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_PENDING_DELETION');
  });

  test('7. POST /api/users/me/account/restore restores account to active and issues new token', async () => {
    const res = await request(app)
      .post('/api/users/me/account/restore')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBeTruthy();

    const restoredToken = res.body.data.token;
    const idty = await prisma.identity.findUnique({ where: { id: identity.id } });
    expect(idty.status).toBe('active');
    expect(idty.scheduledDeletionAt).toBeNull();

    // Now normal access should succeed with restored token
    const meRes = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${restoredToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.status).toBe('active');
  });

  test('8. GET /api/users/me/washer-staff returns staff memberships for washer', async () => {
    const ownerIdentity = await prisma.identity.create({
      data: { phone: '966599991111', name: 'Owner Staff' }
    });
    const staff1Identity = await prisma.identity.create({
      data: { phone: '966599992222', name: 'Worker Staff' }
    });

    const ownerMem = await prisma.staffMembership.create({
      data: {
        identityId: ownerIdentity.id,
        washerId: washer.id,
        role: 'washer_owner',
        status: 'active',
        hasFullWasherAccess: true
      }
    });

    await prisma.staffMembership.create({
      data: {
        identityId: staff1Identity.id,
        washerId: washer.id,
        role: 'worker',
        status: 'active',
        hasFullWasherAccess: true
      }
    });

    const staffToken = signToken({
      userId: ownerIdentity.id,
      role: 'washer_admin',
      washerId: washer.id
    });

    const res = await request(app)
      .get('/api/users/me/washer-staff')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some(s => s.phone === '966599992222')).toBe(true);
  });
});
