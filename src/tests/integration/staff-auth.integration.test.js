import { jest } from "@jest/globals";
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestBranch,
  createTestIdentity,
  createStaffMembership
} from './test-utils.js';
import prisma from '../../config/db.js';
import { OtpService } from '../../modules/auth/services/otp.service.js';
import StaffController from '../../modules/auth/v2/staff.controller.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import { TokenService } from '../../modules/auth/services/token.service.js';

let washer1, branch1_1, branch1_2;
let washer2, branch2_1;
let identityOwner, identityWorker, identityUnregistered;

function makeReq(body = {}, authContext = null) {
  return { body, authContext };
}
function makeRes() {
  const r = { _data: null, _status: 200 };
  r.status = (s) => { r._status = s; return r; };
  r.json = (d) => { r._data = d; return r; };
  return r;
}

beforeAll(async () => {
  await setupTestDb();
  const w1 = await createTestWasher({ name: 'Washer 1', appKey: 'w1-key' });
  washer1 = w1.washer;
  branch1_1 = await createTestBranch(washer1.id, { name: 'Branch 1.1' });
  branch1_2 = await createTestBranch(washer1.id, { name: 'Branch 1.2' });

  const w2 = await createTestWasher({ name: 'Washer 2', appKey: 'w2-key' });
  washer2 = w2.washer;
  branch2_1 = await createTestBranch(washer2.id, { name: 'Branch 2.1' });

  identityOwner = await createTestIdentity('500000020');
  identityWorker = await createTestIdentity('500000021');
  identityUnregistered = await createTestIdentity('500000022'); // in DB but no staff membership

  // Owner of Washer 1 (hasFullWasherAccess = true) -> multiple branches
  await createStaffMembership(identityOwner.id, washer1.id, null, { role: 'washer_owner', hasFullWasherAccess: true });
  // Owner is also worker in Washer 2 (hasFullWasherAccess = true) -> single branch
  await createStaffMembership(identityOwner.id, washer2.id, null, { role: 'worker', hasFullWasherAccess: true });

  // Worker for Washer 1 -> access to Branch 1.1 only
  await createStaffMembership(identityWorker.id, washer1.id, branch1_1.id, { role: 'worker' });
});

afterAll(async () => { await teardownTestDb(); });

async function injectOtp(phone) {
  const code = '123456';
  const codeHash = OtpService.hashOtpCode(code);
  await prisma.otpCode.create({
    data: { phone, appClientId: null, purpose: 'login', codeHash, expiresAt: new Date(Date.now() + 300000) }
  });
  return code;
}

describe('Staff Auth — verifyOtp', () => {
  test('1. rejects unregistered phone (STAFF_ACCESS_NOT_FOUND)', async () => {
    const code = await injectOtp('500000099');
    const req = makeReq({ phone: '0500000099', code });
    const next = jest.fn();
    await StaffController.verifyOtp(req, makeRes(), next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'STAFF_ACCESS_NOT_FOUND' }));
  });

  test('2. rejects registered identity without staff memberships', async () => {
    const code = await injectOtp('500000022');
    const req = makeReq({ phone: '0500000022', code });
    const next = jest.fn();
    await StaffController.verifyOtp(req, makeRes(), next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'STAFF_ACCESS_NOT_FOUND' }));
  });

  test('3. worker with single explicit branch access -> operational session', async () => {
    const code = await injectOtp('500000021');
    const req = makeReq({ phone: '0500000021', code });
    const res = makeRes();
    await StaffController.verifyOtp(req, res, jest.fn());
    expect(res._data.data.sessionType).toBe('operational');
    expect(res._data.data.accessToken).toBeTruthy();
    // Validate the operational session context
    const tokenPayload = TokenService.verifyAccessToken(res._data.data.accessToken, 'operational');
    expect(tokenPayload.washerId).toBe(washer1.id);
    expect(tokenPayload.branchId).toBe(branch1_1.id);
  });

  test('4. hasFullWasherAccess with multiple branches -> provisional session', async () => {
    // Delete worker membership temporarily so owner has only washer1 membership to test this cleanly
    await prisma.staffMembership.delete({ where: { identityId_washerId: { identityId: identityOwner.id, washerId: washer2.id } } });

    const code = await injectOtp('500000020');
    const req = makeReq({ phone: '0500000020', code });
    const res = makeRes();
    await StaffController.verifyOtp(req, res, jest.fn());
    
    expect(res._data.data.sessionType).toBe('provisional');
    expect(res._data.data.availableContexts).toBeDefined();
    expect(res._data.data.availableContexts.length).toBe(2); // Branch 1.1 and 1.2
    
    // Restore washer2 membership
    await createStaffMembership(identityOwner.id, washer2.id, null, { role: 'worker', hasFullWasherAccess: true });
  });

  test('5. hasFullWasherAccess with exactly ONE branch -> operational session', async () => {
    // We will test washer2 which only has branch2_1
    // First, temporarily remove washer1 membership
    const ownerWasher1Mem = await prisma.staffMembership.findUnique({ where: { identityId_washerId: { identityId: identityOwner.id, washerId: washer1.id } } });
    await prisma.staffMembership.delete({ where: { id: ownerWasher1Mem.id } });

    const code = await injectOtp('500000020');
    const req = makeReq({ phone: '0500000020', code });
    const res = makeRes();
    await StaffController.verifyOtp(req, res, jest.fn());

    expect(res._data.data.sessionType).toBe('operational');
    const tokenPayload = TokenService.verifyAccessToken(res._data.data.accessToken, 'operational');
    expect(tokenPayload.washerId).toBe(washer2.id);
    expect(tokenPayload.branchId).toBe(branch2_1.id);

    // Restore washer1 membership
    await createStaffMembership(identityOwner.id, washer1.id, null, { role: 'washer_owner', hasFullWasherAccess: true });
  });

  test('6. hasFullWasherAccess with zero active branches -> provisions default branch and succeeds', async () => {
    try {
      // Set branch2_1 to permanently_closed
      await prisma.branch.update({ where: { id: branch2_1.id }, data: { status: 'permanently_closed' } });
      // Remove washer1 membership temporarily so owner only has washer2
      await prisma.staffMembership.deleteMany({ where: { identityId: identityOwner.id, washerId: washer1.id } });

      const code = await injectOtp('500000020');
      const req = makeReq({ phone: '0500000020', code });
      const res = makeRes();
      await StaffController.verifyOtp(req, res, jest.fn());

      expect(res._data.data.sessionType).toBe('operational');
      const tokenPayload = TokenService.verifyAccessToken(res._data.data.accessToken, 'operational');
      expect(tokenPayload.washerId).toBe(washer2.id);
      expect(tokenPayload.branchId).toBeTruthy();
    } finally {
      // Restore
      await prisma.branch.update({ where: { id: branch2_1.id }, data: { status: 'active' } });
      await createStaffMembership(identityOwner.id, washer1.id, null, { role: 'washer_owner', hasFullWasherAccess: true });
    }
  });

  test('6b. restricted worker with no active assigned branch -> ACTIVE_BRANCH_NOT_FOUND', async () => {
    try {
      // Worker only assigned to branch1_1; set branch1_1 to permanently_closed
      await prisma.branch.update({ where: { id: branch1_1.id }, data: { status: 'permanently_closed' } });

      const code = await injectOtp('500000021');
      const req = makeReq({ phone: '0500000021', code });
      const next = jest.fn();
      await StaffController.verifyOtp(req, makeRes(), next).catch(e => next(e));

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACTIVE_BRANCH_NOT_FOUND' }));
    } finally {
      await prisma.branch.update({ where: { id: branch1_1.id }, data: { status: 'active' } });
    }
  });
});

describe('Staff Auth — selectContext', () => {
  let provisionalToken, sessionId, ownerMem;

  beforeEach(async () => {
    ownerMem = await prisma.staffMembership.findUnique({ where: { identityId_washerId: { identityId: identityOwner.id, washerId: washer1.id } } });
    const result = await SessionService.createProvisionalSession(identityOwner.id, {});
    provisionalToken = result.accessToken;
    sessionId = result.session.id;
  });

  test('7. rejects selection if branch does not belong to washer', async () => {
    const req = makeReq({
      staffMembershipId: ownerMem.id,
      washerId: washer1.id,
      branchId: branch2_1.id // Wrong washer
    }, { identityId: identityOwner.id, sessionId, sessionType: 'provisional' });
    const next = jest.fn();
    await StaffController.selectContext(req, makeRes(), next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRANCH_WASHER_MISMATCH' }));
  });

  test('8. rejects selection if staff does not have access to branch', async () => {
    // Using worker who only has access to branch1_1
    const workerMem = await prisma.staffMembership.findUnique({ where: { identityId_washerId: { identityId: identityWorker.id, washerId: washer1.id } } });
    const req = makeReq({
      staffMembershipId: workerMem.id,
      washerId: washer1.id,
      branchId: branch1_2.id // No access
    }, { identityId: identityWorker.id, sessionId, sessionType: 'provisional' });
    const next = jest.fn();
    await StaffController.selectContext(req, makeRes(), next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }));
  });

  test('9. successfully selects context and upgrades to operational', async () => {
    const req = makeReq({
      staffMembershipId: ownerMem.id,
      washerId: washer1.id,
      branchId: branch1_2.id
    }, { identityId: identityOwner.id, sessionId, sessionType: 'provisional' });
    const res = makeRes();
    await StaffController.selectContext(req, res, jest.fn());

    expect(res._data.data.sessionType).toBe('operational');
    expect(res._data.data.accessToken).toBeTruthy();
    
    // Original provisional session must be revoked
    const prov = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(prov.isRevoked).toBe(true);
  });
});

describe('Staff Auth — switch-context Redis failure', () => {
  let sessionId, accessToken, ownerMem;

  beforeEach(async () => {
    // Need an active operational session for staff
    ownerMem = await prisma.staffMembership.findUnique({ where: { identityId_washerId: { identityId: identityOwner.id, washerId: washer1.id } } });
    const result = await SessionService.createOperationalSession(identityOwner.id, {
      washerId: washer1.id, branchId: branch1_1.id, staffMembershipId: ownerMem.id
    });
    sessionId = result.session.id;
    accessToken = result.accessToken;
  });

  const makeReq = (token, body) => ({
    headers: { authorization: `Bearer ${token}` },
    body,
    authContext: { identityId: identityOwner.id, sessionId, sessionType: 'operational', washerId: washer1.id, branchId: branch1_1.id, staffMembershipId: ownerMem.id }
  });
  
  const makeRes = () => ({
    _data: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this._data = data; return this; }
  });

  test('handles Redis failure gracefully after switch-context DB commit (fallback prevents old session use)', async () => {
    const req = makeReq(accessToken, { staffMembershipId: ownerMem.id, washerId: washer1.id, branchId: branch1_2.id });
    const res = makeRes();
    const next = jest.fn();

    // Mock Redis to throw an error for the cache update
    const redis = (await import('../../config/redis.js')).default;
    const originalSet = redis.set;
    const originalDel = redis.del;
    redis.set = jest.fn().mockRejectedValue(new Error('Simulated Redis Down'));
    redis.del = jest.fn().mockResolvedValue('OK'); // del fallback works
    // wait, we mock set to fail, del might also fail or succeed. we want to ensure no unhandled promise rejection.
    // The test framework should automatically fail on unhandled promise rejections.

    await StaffController.switchContext(req, res, next);
    
    // Switch should succeed despite Redis failure
    expect(res._data.data.sessionType).toBe('operational');
    expect(res._data.data.accessToken).toBeTruthy();

    // The old session is revoked in DB
    const oldSession = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(oldSession.isRevoked).toBe(true);

    // If we try to use the old token again via contextGuard, DB fallback should reject it immediately
    redis.get = jest.fn().mockRejectedValue(new Error('Redis Down')); // force DB fallback

    const pingReq = { headers: { authorization: `Bearer ${accessToken}` } };
    const pingNext = jest.fn();
    const { contextGuard } = await import('../../middlewares/contextGuard.js');

    await contextGuard(pingReq, res, pingNext).catch(e => pingNext(e));
    expect(pingNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }));

    // Restore redis
    redis.set = originalSet;
    redis.del = originalDel;
    redis.get = (await import('../../config/redis.js')).default.get;
  });
});
