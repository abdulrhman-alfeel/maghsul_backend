import { jest } from "@jest/globals";
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestIdentity,
  createCustomerMembership
} from './test-utils.js';
import prisma from '../../config/db.js';
import { OtpService } from '../../modules/auth/services/otp.service.js';
import CustomerController from '../../modules/auth/v2/customer.controller.js';
import { SessionService } from '../../modules/auth/services/session.service.js';

let washer, appClient, identity;

// Helper to make req object
function makeReq(body = {}, appClientOverride = null) {
  return {
    body,
    appClient: appClientOverride || { appClientId: appClient.id, washerId: washer.id, isActive: true }
  };
}
function makeRes() {
  const r = { _data: null, _status: 200 };
  r.status = (s) => { r._status = s; return r; };
  r.json = (d) => { r._data = d; return r; };
  return r;
}

beforeAll(async () => {
  await setupTestDb();
  ({ washer, appClient } = await createTestWasher({ appKey: 'customer-test-key' }));
  identity = await createTestIdentity('500000010');
});
afterAll(async () => { await teardownTestDb(); });

// ── Helper: inject OTP into DB directly ───────────────────────────────────
async function injectOtp(phone, appClientId = appClient.id) {
  const code = '123456';
  const codeHash = OtpService.hashOtpCode(code);
  await prisma.otpCode.create({
    data: { phone, appClientId, purpose: 'login', codeHash, expiresAt: new Date(Date.now() + 300000) }
  });
  return code;
}

describe('Customer Auth — sendOtp', () => {
  test('1. rejects invalid phone number', async () => {
    const req = makeReq({ phone: 'not-a-phone' });
    const res = makeRes();
    const next = jest.fn();
    await CustomerController.sendOtp(req, res, next).catch(e => next(e));
    // asyncHandler will call next(err) if thrown
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_PHONE' }));
  });

  test('2. sends OTP for valid phone', async () => {
    const req = makeReq({ phone: '0500000011' });
    const res = makeRes();
    await CustomerController.sendOtp(req, res, jest.fn());
    expect(res._data).toMatchObject({ ok: true, data: { sent: true } });
  });
});

describe('Customer Auth — verifyOtp', () => {
  test('3. rejects wrong OTP code', async () => {
    await injectOtp('500000010');
    const req = makeReq({ phone: '0500000010', code: '000000' });
    const next = jest.fn();
    await CustomerController.verifyOtp(req, makeRes(), next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_INVALID' }));
  });

  test('4. returns CUSTOMER_ENROLLMENT_REQUIRED when no membership exists', async () => {
    const code = await injectOtp('500000010');
    const req = makeReq({ phone: '0500000010', code });
    const res = makeRes();
    await CustomerController.verifyOtp(req, res, jest.fn());
    expect(res._data.data.status).toBe('CUSTOMER_ENROLLMENT_REQUIRED');
    expect(res._data.data.sessionType).toBe('provisional');
    expect(res._data.data.accessToken).toBeTruthy();
    // Provisional session must have washerId stored
    const sessionId = res._data.data.accessToken;
    // Decode to get sessionId
  });

  test('5. provisional session stores washerId from AppClient (not body)', async () => {
    // Send fresh OTP
    await injectOtp('500000012');
    const req = makeReq({ phone: '0500000012', code: '123456' });
    const res = makeRes();
    await CustomerController.verifyOtp(req, res, jest.fn());
    expect(res._data.data.sessionType).toBe('provisional');

    // Verify the session in DB has washerId
    const identity12 = await prisma.identity.findUnique({ where: { phone: '500000012' } });
    const sessions = await prisma.session.findMany({
      where: { identityId: identity12.id, sessionType: 'provisional' },
      orderBy: { createdAt: 'desc' },
      take: 1
    });
    expect(sessions[0].washerId).toBe(washer.id);
  });

  test('6. returns operational session when membership exists', async () => {
    await createCustomerMembership(identity.id, washer.id);
    const code = await injectOtp('500000010');
    const req = makeReq({ phone: '0500000010', code });
    const res = makeRes();
    await CustomerController.verifyOtp(req, res, jest.fn());
    expect(res._data.data.sessionType).toBe('operational');
    expect(res._data.data.accessToken).toBeTruthy();
    expect(res._data.data.refreshToken).toBeTruthy();
  });

  test('7. rejects OTP used for different washer (cross-washer reuse)', async () => {
    const { washer: w2, appClient: ac2 } = await createTestWasher({ appKey: 'washer2-key' });
    // Generate OTP for Washer 1 via AppClient 1
    const code = await injectOtp('500000010');
    
    // Attempt verify via AppClient 2 for Washer 2
    const req = makeReq({ phone: '0500000010', code }, { appClientId: ac2.id, washerId: w2.id, isActive: true });
    const next = jest.fn();
    await CustomerController.verifyOtp(req, makeRes(), next).catch(e => next(e));
    // Should fail because OTP is scoped to appClient.id
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: expect.stringMatching(/OTP/) }));
  });
});

describe('Customer Auth — enroll', () => {
  let provisionalToken, provisionalSessionId;

  beforeEach(async () => {
    // Clean sessions
    await prisma.refreshToken.deleteMany({ where: { session: { identityId: identity.id } } });
    await prisma.session.deleteMany({ where: { identityId: identity.id } });
    const result = await SessionService.createProvisionalSession(identity.id, { washerId: washer.id });
    provisionalToken = result.accessToken;
    provisionalSessionId = result.session.id;
  });

  test('8. rejects if AppClient washerId differs from session washerId', async () => {
    const { washer: w3, appClient: ac3 } = await createTestWasher({ appKey: 'washer3-key' });
    const req = {
      body: {},
      appClient: { appClientId: ac3.id, washerId: w3.id, isActive: true }, // different washer
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', washerId: washer.id }
    };
    const next = jest.fn();
    await CustomerController.enroll(req, makeRes(), next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'WASHER_CONTEXT_MISMATCH' }));
  });

  test('9. successfully enrolls and upgrades to operational session', async () => {
    await prisma.customerMembership.deleteMany({ where: { identityId: identity.id, washerId: washer.id } });
    const req = {
      body: {},
      appClient: { appClientId: appClient.id, washerId: washer.id, isActive: true },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', washerId: washer.id }
    };
    const res = makeRes();
    await CustomerController.enroll(req, res, jest.fn());
    expect(res._data.data.sessionType).toBe('operational');
    expect(res._data.data.accessToken).toBeTruthy();
    expect(res._data.data.refreshToken).toBeTruthy();

    // Provisional session must be revoked
    const provisionalSession = await prisma.session.findUnique({ where: { id: provisionalSessionId } });
    expect(provisionalSession.isRevoked).toBe(true);
    expect(provisionalSession.revokedReason).toBe('upgraded_to_operational');
  });

  test('10. enrollment is idempotent (existing membership)', async () => {
    const existing = await createCustomerMembership(identity.id, washer.id);
    const req = {
      body: {},
      appClient: { appClientId: appClient.id, washerId: washer.id, isActive: true },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', washerId: washer.id }
    };
    const res = makeRes();
    await CustomerController.enroll(req, res, jest.fn());
    expect(res._data.data.sessionType).toBe('operational');
    // Membership count should still be 1
    const count = await prisma.customerMembership.count({ where: { identityId: identity.id, washerId: washer.id } });
    expect(count).toBe(1);
  });

  test('11. enrollment rolls back completely if session creation fails', async () => {
    await prisma.customerMembership.deleteMany({ where: { identityId: identity.id, washerId: washer.id } });
    const req = {
      appClient: { appClientId: appClient.id, washerId: washer.id, isActive: true },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', washerId: washer.id }
    };
    const res = makeRes();
    const next = jest.fn();

    // Inject failure deterministically using jest.spyOn
    const spy = jest.spyOn(SessionService, 'createReplacementSession').mockRejectedValueOnce(new Error('Injected failure after membership'));

    await CustomerController.enroll(req, res, next).catch(e => next(e));
    spy.mockRestore();

    // The error should be caught by the error handler
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    const errorPassed = next.mock.calls[0][0];
    expect(errorPassed.message).toBe('Injected failure after membership');

    // Simulate global errorHandler processing the error
    const errorHandler = (await import('../../middlewares/errorHandler.js')).default;
    const errRes = makeRes();
    errorHandler(errorPassed, req, errRes, jest.fn());
    // Verify it doesn't leak raw unformatted 500
    expect(errRes._status).toBe(500);
    expect(errRes._data.code).toBe('INTERNAL_ERROR');

    // Verify complete rollback: No customer membership should exist
    const membershipCount = await prisma.customerMembership.count({ where: { identityId: identity.id, washerId: washer.id } });
    expect(membershipCount).toBe(0);

    // No Operational Session should exist
    const opSessionCount = await prisma.session.count({ where: { identityId: identity.id, washerId: washer.id, sessionType: 'operational' } });
    expect(opSessionCount).toBe(0);

    // No new Refresh Token should be generated
    const rtCount = await prisma.refreshToken.count({ where: { session: { identityId: identity.id, sessionType: 'operational' } } });
    expect(rtCount).toBe(0);

    // Provisional session should remain valid
    const provisionalSession = await prisma.session.findUnique({ where: { id: provisionalSessionId } });
    expect(provisionalSession.isRevoked).toBe(false);
    expect(provisionalSession.replacedBySessionId).toBeNull();
  });

  test('12. concurrent enrollment requests are handled safely (idempotent, no dupes)', async () => {
    await prisma.customerMembership.deleteMany({ where: { identityId: identity.id, washerId: washer.id } });
    const req1 = {
      body: {},
      appClient: { appClientId: appClient.id, washerId: washer.id, isActive: true },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', washerId: washer.id }
    };
    const req2 = {
      body: {},
      appClient: { appClientId: appClient.id, washerId: washer.id, isActive: true },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', washerId: washer.id }
    };

    const res1 = makeRes();
    const res2 = makeRes();
    const next1 = jest.fn();
    const next2 = jest.fn();

    // Fire concurrently
    const [result1, result2] = await Promise.allSettled([
      CustomerController.enroll(req1, res1, next1).catch(e => next1(e)),
      CustomerController.enroll(req2, res2, next2).catch(e => next2(e))
    ]);

    // One should succeed, one should fail (or both succeed if Prisma manages to serialize and idempotent upsert works and session replacement catches the conflict)
    // Wait, createReplacementSession will throw "Session already replaced" for the second one!
    // So one will have an operational session, one will throw 403 INVALID_TOKEN.
    
    // Verify CustomerMembership: Exactly ONE
    const memberships = await prisma.customerMembership.findMany({ where: { identityId: identity.id, washerId: washer.id } });
    expect(memberships.length).toBe(1);

    // Verify Session: Exactly ONE Operational Session for this washer/identity
    const operationalSessions = await prisma.session.findMany({ 
      where: { identityId: identity.id, washerId: washer.id, sessionType: 'operational' } 
    });
    expect(operationalSessions.length).toBe(1);

    // Verify Refresh Token: Exactly ONE active for the operational session
    const refreshTokens = await prisma.refreshToken.findMany({
      where: { sessionId: operationalSessions[0].id, isRevoked: false }
    });
    expect(refreshTokens.length).toBe(1);

    // Verify Provisional Session: replacedBySessionId points to the single operational session
    const provisionalSession = await prisma.session.findUnique({ where: { id: provisionalSessionId } });
    expect(provisionalSession.isRevoked).toBe(true);
    expect(provisionalSession.replacedBySessionId).toBe(operationalSessions[0].id);
    
    // Verify no 500 error occurred in next (it should be 403 INVALID_TOKEN or P2002 if it failed)
    const errArgs = next1.mock.calls.length > 0 ? next1.mock.calls[0][0] : next2.mock.calls[0][0];
    if (errArgs) {
      expect(errArgs.statusCode).not.toBe(500);
      expect(['INVALID_TOKEN', 'P2002']).toContain(errArgs.code);
    }
  });
});
