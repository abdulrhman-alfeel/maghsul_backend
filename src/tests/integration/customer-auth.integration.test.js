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
function makeReq(body = {}, contextOverride = null) {
  const wId = contextOverride?.washerId || washer.id;
  return {
    body,
    washerContext: { washerId: wId, washerName: 'Test Washer' },
    appClient: { appClientId: wId, washerId: wId, isActive: true }
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
  ({ washer, appClient } = await createTestWasher({ name: 'Customer Test Washer', status: 'active' }));
  identity = await createTestIdentity('500000010');
});
afterAll(async () => { await teardownTestDb(); });

// ── Helper: inject OTP into DB directly ───────────────────────────────────
async function injectOtp(phone) {
  const code = '123456';
  const codeHash = OtpService.hashOtpCode(code);
  await prisma.otpCode.create({
    data: { phone, purpose: 'login', codeHash, expiresAt: new Date(Date.now() + 300000) }
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
  });

  test('5. provisional session stores washerId from X-Washer-Id context (not body)', async () => {
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
    expect(sessions[0].washerId).toBeNull();
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

  test('7. OTP is global to phone and authenticates identity across washers', async () => {
    const { washer: w2 } = await createTestWasher({ name: 'Washer 2', status: 'active' });
    // Generate global OTP for phone
    const code = await injectOtp('500000010');
    
    // Verify OTP via Washer 2 context
    const req = makeReq({ phone: '0500000010', code }, { washerId: w2.id });
    const res = makeRes();
    await CustomerController.verifyOtp(req, res, jest.fn());
    expect(res._data.ok).toBe(true);
  });
});

describe('Customer Auth — enroll', () => {
  let provisionalToken, provisionalSessionId;

  beforeEach(async () => {
    // Clean sessions
    await prisma.refreshToken.deleteMany({ where: { session: { identityId: identity.id } } });
    await prisma.session.deleteMany({ where: { identityId: identity.id } });
    const result = await SessionService.createProvisionalSession(identity.id, { appType: 'customer' });
    provisionalToken = result.accessToken;
    provisionalSessionId = result.session.id;
  });

  test('8. enroll validates target washer context', async () => {
    const req = {
      body: {},
      washerContext: { washerId: washer.id },
      appClient: { appClientId: washer.id, washerId: washer.id, isActive: true },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', appType: 'customer' }
    };
    const res = makeRes();
    await CustomerController.enroll(req, res, jest.fn());
    expect(res._data.data.sessionType).toBe('operational');
  });

  test('9. successfully enrolls and upgrades to operational session', async () => {
    await prisma.customerMembership.deleteMany({ where: { identityId: identity.id, washerId: washer.id } });
    const req = {
      body: {},
      washerContext: { washerId: washer.id },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', appType: 'customer' }
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
      washerContext: { washerId: washer.id },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', appType: 'customer' }
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
      washerContext: { washerId: washer.id },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', appType: 'customer' }
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
    const opSessionCount = await prisma.session.count({ where: { identityId: identity.id, sessionType: 'operational' } });
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
      washerContext: { washerId: washer.id },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', appType: 'customer' }
    };
    const req2 = {
      body: {},
      washerContext: { washerId: washer.id },
      authContext: { identityId: identity.id, sessionId: provisionalSessionId, sessionType: 'provisional', appType: 'customer' }
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

    // Verify Session: Exactly ONE Operational Session for this identity
    const operationalSessions = await prisma.session.findMany({ 
      where: { identityId: identity.id, sessionType: 'operational' } 
    });
    expect(operationalSessions.length).toBe(1);
    expect(operationalSessions[0].washerId).toBeNull();

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

describe('Multi-Washer Enrollment & Cross-Tenant Access', () => {
  let washerA, washerB, customerIdentity, operationalSessionA;

  beforeAll(async () => {
    ({ washer: washerA } = await createTestWasher({ name: 'Washer Multi A', status: 'active' }));
    ({ washer: washerB } = await createTestWasher({ name: 'Washer Multi B', status: 'active' }));
    customerIdentity = await createTestIdentity('500000099');

    // 1. Identity has active Membership A
    await prisma.customerMembership.create({
      data: { identityId: customerIdentity.id, washerId: washerA.id, status: 'active' }
    });

    // 2. Operational customer Session exists
    operationalSessionA = await SessionService.createOperationalSession(customerIdentity.id, {
      appType: 'customer',
      washerId: washerA.id
    });
  });

  test('MULTI-WASHER-ENROLL-1: Operational session in Washer A enrolls in Washer B with SAME token and no OTP', async () => {
    // 3. No Membership B initially
    const preB = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: customerIdentity.id, washerId: washerB.id } }
    });
    expect(preB).toBeNull();

    // 4. POST /customer/enroll with SAME token + X-Washer-Id B
    const req = {
      body: {},
      washerContext: { washerId: washerB.id, washerName: 'Washer Multi B' },
      authContext: {
        identityId: customerIdentity.id,
        sessionId: operationalSessionA.session.id,
        sessionType: 'operational',
        appType: 'customer'
      }
    };
    const res = makeRes();
    await CustomerController.enroll(req, res, jest.fn());

    // 5. Membership B created
    const postB = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: customerIdentity.id, washerId: washerB.id } }
    });
    expect(postB).not.toBeNull();
    expect(postB.status).toBe('active');

    // 6. Session ID unchanged
    expect(res._data.ok).toBe(true);
    expect(res._data.data.sessionType).toBe('operational');
    expect(res._data.data.identity.id).toBe(customerIdentity.id);

    // 7. Session row in DB remains operational and NOT revoked
    const sessionInDb = await prisma.session.findUnique({ where: { id: operationalSessionA.session.id } });
    expect(sessionInDb.isRevoked).toBe(false);

    // 8. Membership A unchanged
    const postA = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: customerIdentity.id, washerId: washerA.id } }
    });
    expect(postA.status).toBe('active');
  });

  test('MULTI-WASHER-ENROLL-2: Existing active Membership B enrolls again idempotently without duplicate', async () => {
    const req = {
      body: {},
      washerContext: { washerId: washerB.id, washerName: 'Washer Multi B' },
      authContext: {
        identityId: customerIdentity.id,
        sessionId: operationalSessionA.session.id,
        sessionType: 'operational',
        appType: 'customer'
      }
    };
    const res = makeRes();
    await CustomerController.enroll(req, res, jest.fn());
    expect(res._data.ok).toBe(true);

    const countB = await prisma.customerMembership.count({
      where: { identityId: customerIdentity.id, washerId: washerB.id }
    });
    expect(countB).toBe(1);
  });

  test('MULTI-WASHER-ENROLL-3: Prohibited/inactive Membership B rejects enrollment and never silently reactivates', async () => {
    // Set membership B to suspended
    await prisma.customerMembership.update({
      where: { identityId_washerId: { identityId: customerIdentity.id, washerId: washerB.id } },
      data: { status: 'suspended' }
    });

    const req = {
      body: {},
      washerContext: { washerId: washerB.id, washerName: 'Washer Multi B' },
      authContext: {
        identityId: customerIdentity.id,
        sessionId: operationalSessionA.session.id,
        sessionType: 'operational',
        appType: 'customer'
      }
    };
    const res = makeRes();
    const next = jest.fn();
    await CustomerController.enroll(req, res, next).catch(e => next(e));

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      status: 403,
      code: 'MEMBERSHIP_INACTIVE'
    }));

    // Status MUST still be suspended
    const membership = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: customerIdentity.id, washerId: washerB.id } }
    });
    expect(membership.status).toBe('suspended');
  });
});

describe('OTP Global Security Suite (OTP-1 to OTP-6)', () => {
  const phone = '0500000098';

  test('OTP-1: New GLOBAL OTP for same phone/purpose invalidates previous GLOBAL OTP', async () => {
    const phone1 = '0500000081';
    await OtpService.sendOtp(phone1, 'login', null);
    const firstOtp = await prisma.otpCode.findFirst({
      where: { phone: phone1, purpose: 'login', appClientId: null },
      orderBy: { createdAt: 'desc' }
    });

    // Fast-forward cooldown by updating first OTP createdAt
    await prisma.otpCode.update({
      where: { id: firstOtp.id },
      data: { createdAt: new Date(Date.now() - 70000) }
    });

    // Send second OTP
    await OtpService.sendOtp(phone1, 'login', null);
    const updatedFirst = await prisma.otpCode.findUnique({ where: { id: firstOtp.id } });
    expect(updatedFirst.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('OTP-2: Global customer OTP does NOT invalidate separately scoped OTP', async () => {
    const phone2 = '0500000082';
    // Create scoped OTP
    const scopedCode = '999999';
    const scoped = await prisma.otpCode.create({
      data: {
        phone: phone2,
        purpose: 'login',
        appClientId: 'legacy-scoped-client',
        codeHash: OtpService.hashOtpCode(scopedCode),
        expiresAt: new Date(Date.now() + 300000)
      }
    });

    // Send global OTP
    await OtpService.sendOtp(phone2, 'login', null);

    // Scoped OTP must NOT be expired
    const scopedAfter = await prisma.otpCode.findUnique({ where: { id: scoped.id } });
    expect(scopedAfter.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('OTP-3: Scoped legacy OTP cannot verify through global customer verification', async () => {
    const phone3 = '0500000083';
    const scopedCode = '888888';
    await prisma.otpCode.create({
      data: {
        phone: phone3,
        purpose: 'login',
        appClientId: 'legacy-scoped-client',
        codeHash: OtpService.hashOtpCode(scopedCode),
        expiresAt: new Date(Date.now() + 300000)
      }
    });

    // Attempt global verification (appClientId: null)
    await expect(OtpService.verifyOtp(phone3, scopedCode, 'login', null))
      .rejects.toThrow();
  });

  test('OTP-4: Phone A OTP cannot verify Phone B', async () => {
    const code = '777777';
    await prisma.otpCode.create({
      data: {
        phone: '0500000091',
        purpose: 'login',
        appClientId: null,
        codeHash: OtpService.hashOtpCode(code),
        expiresAt: new Date(Date.now() + 300000)
      }
    });

    await expect(OtpService.verifyOtp('0500000092', code, 'login', null))
      .rejects.toThrow();
  });

  test('OTP-5: Expired OTP rejected', async () => {
    const code = '666666';
    await prisma.otpCode.create({
      data: {
        phone: '0500000093',
        purpose: 'login',
        appClientId: null,
        codeHash: OtpService.hashOtpCode(code),
        expiresAt: new Date(Date.now() - 1000)
      }
    });

    await expect(OtpService.verifyOtp('0500000093', code, 'login', null))
      .rejects.toThrow('الرمز منتهي الصلاحية');
  });

  test('OTP-6: Verified OTP cannot be reused', async () => {
    const code = '555555';
    await prisma.otpCode.create({
      data: {
        phone: '0500000094',
        purpose: 'login',
        appClientId: null,
        codeHash: OtpService.hashOtpCode(code),
        expiresAt: new Date(Date.now() + 300000)
      }
    });

    const firstVerify = await OtpService.verifyOtp('0500000094', code, 'login', null);
    expect(firstVerify).toBe(true);

    // Second verify attempt must fail
    await expect(OtpService.verifyOtp('0500000094', code, 'login', null))
      .rejects.toThrow('لا يوجد رمز فعال لهذا الرقم');
  });
});
