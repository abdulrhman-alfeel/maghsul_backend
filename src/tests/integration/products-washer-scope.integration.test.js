import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { setupTestDb, teardownTestDb, createTestWasher, createTestBranch } from './test-utils.js';
import { TokenService } from '../../modules/auth/services/token.service.js';

describe('Products Washer-Scope Integration Tests', () => {
  let washerA, branchA, washerB, branchB;
  let ownerAIdentity, ownerAMembership, ownerAToken;
  let managerAIdentity, managerAMembership, managerAToken;
  let branchManagerAIdentity, branchManagerAMembership, branchManagerAToken;
  let workerAIdentity, workerAMembership, workerAToken;
  let driverAIdentity, driverAMembership, driverAToken;
  let ownerBIdentity, ownerBMembership, ownerBToken;
  let platformProduct1, platformProduct2;

  beforeAll(async () => {
    await setupTestDb();

    // Create Platform Products
    await prisma.product.deleteMany();
    platformProduct1 = await prisma.product.create({
      data: { name: 'Thobe Regular', isDefault: true, type: 'regular' }
    });
    platformProduct2 = await prisma.product.create({
      data: { name: 'Shirt Press', isDefault: true, type: 'press' }
    });

    // Create Washer A & Branch A
    const createdA = await createTestWasher({ name: 'Washer A' });
    washerA = createdA.washer;
    branchA = await createTestBranch(washerA.id, { name: 'Branch A1' });

    // Create Washer B & Branch B
    const createdB = await createTestWasher({ name: 'Washer B' });
    washerB = createdB.washer;
    branchB = await createTestBranch(washerB.id, { name: 'Branch B1' });

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 1. Owner A
    ownerAIdentity = await prisma.identity.create({
      data: { phone: '966500000001', name: 'Owner A' }
    });
    ownerAMembership = await prisma.staffMembership.create({
      data: {
        identityId: ownerAIdentity.id,
        washerId: washerA.id,
        role: 'washer_owner',
        status: 'active',
        hasFullWasherAccess: true,
      }
    });
    const sessionOwnerA = await prisma.session.create({
      data: {
        identityId: ownerAIdentity.id,
        staffMembershipId: ownerAMembership.id,
        washerId: washerA.id,
        branchId: branchA.id,
        sessionType: 'operational',
        expiresAt,
      }
    });
    ownerAToken = TokenService.signAccessToken({
      sessionId: sessionOwnerA.id,
      identityId: ownerAIdentity.id,
      sessionType: 'operational',
      staffMembershipId: ownerAMembership.id,
      washerId: washerA.id,
      branchId: branchA.id,
    });

    // 2. Manager A
    managerAIdentity = await prisma.identity.create({
      data: { phone: '966500000002', name: 'Manager A' }
    });
    managerAMembership = await prisma.staffMembership.create({
      data: {
        identityId: managerAIdentity.id,
        washerId: washerA.id,
        role: 'washer_manager',
        status: 'active',
        hasFullWasherAccess: true,
      }
    });
    const sessionManagerA = await prisma.session.create({
      data: {
        identityId: managerAIdentity.id,
        staffMembershipId: managerAMembership.id,
        washerId: washerA.id,
        branchId: branchA.id,
        sessionType: 'operational',
        expiresAt,
      }
    });
    managerAToken = TokenService.signAccessToken({
      sessionId: sessionManagerA.id,
      identityId: managerAIdentity.id,
      sessionType: 'operational',
      staffMembershipId: managerAMembership.id,
      washerId: washerA.id,
      branchId: branchA.id,
    });

    // 3. Branch Manager A
    branchManagerAIdentity = await prisma.identity.create({
      data: { phone: '966500000003', name: 'Branch Manager A' }
    });
    branchManagerAMembership = await prisma.staffMembership.create({
      data: {
        identityId: branchManagerAIdentity.id,
        washerId: washerA.id,
        role: 'branch_manager',
        status: 'active',
        hasFullWasherAccess: false,
      }
    });
    await prisma.branchAccess.create({
      data: {
        staffMembershipId: branchManagerAMembership.id,
        branchId: branchA.id
      }
    });
    const sessionBranchManagerA = await prisma.session.create({
      data: {
        identityId: branchManagerAIdentity.id,
        staffMembershipId: branchManagerAMembership.id,
        washerId: washerA.id,
        branchId: branchA.id,
        sessionType: 'operational',
        expiresAt,
      }
    });
    branchManagerAToken = TokenService.signAccessToken({
      sessionId: sessionBranchManagerA.id,
      identityId: branchManagerAIdentity.id,
      sessionType: 'operational',
      staffMembershipId: branchManagerAMembership.id,
      washerId: washerA.id,
      branchId: branchA.id,
    });

    // 4. Worker A
    workerAIdentity = await prisma.identity.create({
      data: { phone: '966500000004', name: 'Worker A' }
    });
    workerAMembership = await prisma.staffMembership.create({
      data: {
        identityId: workerAIdentity.id,
        washerId: washerA.id,
        role: 'worker',
        status: 'active',
        hasFullWasherAccess: true,
      }
    });
    const sessionWorkerA = await prisma.session.create({
      data: {
        identityId: workerAIdentity.id,
        staffMembershipId: workerAMembership.id,
        washerId: washerA.id,
        branchId: branchA.id,
        sessionType: 'operational',
        expiresAt,
      }
    });
    workerAToken = TokenService.signAccessToken({
      sessionId: sessionWorkerA.id,
      identityId: workerAIdentity.id,
      sessionType: 'operational',
      staffMembershipId: workerAMembership.id,
      washerId: washerA.id,
      branchId: branchA.id,
    });

    // 5. Driver A
    driverAIdentity = await prisma.identity.create({
      data: { phone: '966500000005', name: 'Driver A' }
    });
    driverAMembership = await prisma.staffMembership.create({
      data: {
        identityId: driverAIdentity.id,
        washerId: washerA.id,
        role: 'driver',
        status: 'active',
        hasFullWasherAccess: true,
      }
    });
    const sessionDriverA = await prisma.session.create({
      data: {
        identityId: driverAIdentity.id,
        staffMembershipId: driverAMembership.id,
        washerId: washerA.id,
        branchId: branchA.id,
        sessionType: 'operational',
        expiresAt,
      }
    });
    driverAToken = TokenService.signAccessToken({
      sessionId: sessionDriverA.id,
      identityId: driverAIdentity.id,
      sessionType: 'operational',
      staffMembershipId: driverAMembership.id,
      washerId: washerA.id,
      branchId: branchA.id,
    });

    // 6. Owner B
    ownerBIdentity = await prisma.identity.create({
      data: { phone: '966500000006', name: 'Owner B' }
    });
    ownerBMembership = await prisma.staffMembership.create({
      data: {
        identityId: ownerBIdentity.id,
        washerId: washerB.id,
        role: 'washer_owner',
        status: 'active',
        hasFullWasherAccess: true,
      }
    });
    const sessionOwnerB = await prisma.session.create({
      data: {
        identityId: ownerBIdentity.id,
        staffMembershipId: ownerBMembership.id,
        washerId: washerB.id,
        branchId: branchB.id,
        sessionType: 'operational',
        expiresAt,
      }
    });
    ownerBToken = TokenService.signAccessToken({
      sessionId: sessionOwnerB.id,
      identityId: ownerBIdentity.id,
      sessionType: 'operational',
      staffMembershipId: ownerBMembership.id,
      washerId: washerB.id,
      branchId: branchB.id,
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // 1. GET defaults works
  test('1. GET /api/products/defaults returns default platform products', async () => {
    const res = await request(app).get('/api/products/defaults');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(2);
    expect(res.body.data.some(p => p.name === 'Thobe Regular')).toBe(true);
  });

  // 2. Washer owner can manage own Washer products
  test('2. Washer owner can save product for own washer', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ productId: platformProduct1.id, price: 500 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.price).toBe(500);
    expect(res.body.data.washerId).toBe(washerA.id);
  });

  // 3. Washer manager can manage own Washer products
  test('3. Washer manager can save product for own washer', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${managerAToken}`)
      .send({ productId: platformProduct2.id, price: 700 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.price).toBe(700);
  });

  // 4. Branch manager: NOT granted automatically (403)
  test('4. Branch manager is rejected from washer-level product management', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${branchManagerAToken}`)
      .send({ productId: platformProduct1.id, price: 600 });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  // 5. Worker rejected
  test('5. Worker is rejected from product management (403)', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${workerAToken}`)
      .send({ productId: platformProduct1.id, price: 600 });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  // 6. Driver rejected
  test('6. Driver is rejected from product management (403)', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${driverAToken}`)
      .send({ productId: platformProduct1.id, price: 600 });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  // 7. Washer A staff cannot mutate Washer B products (Cross-Washer IDOR protection)
  test('7. Washer A staff cannot mutate Washer B products (403)', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerB.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ productId: platformProduct1.id, price: 900 });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  // 8. Platform product configuration created
  test('8. Platform product configuration is persisted in WasherProduct', async () => {
    const wp = await prisma.washerProduct.findUnique({
      where: {
        washerId_productId: {
          washerId: washerA.id,
          productId: platformProduct1.id
        }
      }
    });
    expect(wp).toBeTruthy();
    expect(wp.price).toBe(500);
  });

  // 9. Same Washer + same product: upsert/update, no duplicate
  test('9. Updating existing platform product updates price without duplicate row', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ productId: platformProduct1.id, price: 550 });
    expect(res.status).toBe(200);
    expect(res.body.data.price).toBe(550);

    const count = await prisma.washerProduct.count({
      where: {
        washerId: washerA.id,
        productId: platformProduct1.id
      }
    });
    expect(count).toBe(1);
  });

  // 10. Same Product can have different price in Washer A and Washer B
  test('10. Same Product can have different prices in Washer A and Washer B', async () => {
    await request(app)
      .post(`/api/products/washer/${washerB.id}`)
      .set('Authorization', `Bearer ${ownerBToken}`)
      .send({ productId: platformProduct1.id, price: 1200 });

    const wpA = await prisma.washerProduct.findUnique({
      where: { washerId_productId: { washerId: washerA.id, productId: platformProduct1.id } }
    });
    const wpB = await prisma.washerProduct.findUnique({
      where: { washerId_productId: { washerId: washerB.id, productId: platformProduct1.id } }
    });
    expect(wpA.price).toBe(550);
    expect(wpB.price).toBe(1200);
  });

  // 11. Custom product: productId null, customName valid -> accepted
  test('11. Custom product with productId null and valid customName is accepted', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ customName: 'Silk Blanket Clean', price: 2500 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.customName).toBe('Silk Blanket Clean');
    expect(res.body.data.productId).toBeNull();
    expect(res.body.data.price).toBe(2500);
  });

  // 12. Multiple custom products under same Washer -> accepted
  test('12. Multiple custom products under same Washer are allowed', async () => {
    const res2 = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ customName: 'Leather Jacket Polish', price: 4000 });
    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);

    const customProducts = await prisma.washerProduct.findMany({
      where: { washerId: washerA.id, productId: null }
    });
    expect(customProducts.length).toBe(2);
  });

  // 13. productId null + empty customName -> 400
  test('13. Custom product with empty customName returns 400', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ customName: '   ', price: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  // 14. Invalid productId -> rejected (404)
  test('14. Invalid productId is rejected with 404', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ productId: 'nonexistent_prod_123', price: 1000 });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  // 15. Negative price -> rejected (400)
  test('15. Negative price is rejected with 400', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ productId: platformProduct1.id, price: -100 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  // 16. Non-integer price -> rejected (400)
  test('16. Non-integer price (e.g. 50.5) is rejected with 400', async () => {
    const res = await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ productId: platformProduct1.id, price: 50.5 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  // 17. Cache invalidated after modification
  test('17. Washer products cache is updated after modification', async () => {
    const get1 = await request(app).get(`/api/products/washer/${washerA.id}`);
    expect(get1.status).toBe(200);

    await request(app)
      .post(`/api/products/washer/${washerA.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ productId: platformProduct1.id, price: 999 });

    const get2 = await request(app).get(`/api/products/washer/${washerA.id}`);
    expect(get2.status).toBe(200);
    const updatedItem = get2.body.data.find(p => p.productId === platformProduct1.id);
    expect(updatedItem.price).toBe(999);
  });

  // 18. No branchId introduced in current contract
  test('18. GET /api/products/washer/:washerId returns washer-level items without branchId in response schema', async () => {
    const res = await request(app).get(`/api/products/washer/${washerA.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    for (const item of res.body.data) {
      expect(item.washerId).toBe(washerA.id);
      expect(item.branchId).toBeUndefined();
    }
  });

  // 19. ProductOverride untouched
  test('19. ProductOverride table remains completely empty/untouched', async () => {
    const count = await prisma.productOverride.count();
    expect(count).toBe(0);
  });
});
