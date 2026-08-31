import { jest } from "@jest/globals";
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestIdentity,
  createTestBranch,
  createStaffMembership
} from './test-utils.js';
import prisma from '../../config/db.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import SessionController from '../../modules/auth/v2/session.controller.js';
import { contextGuard } from '../../middlewares/contextGuard.js';

let identity, washer, branch, membership;

function makeReq(authHeader, body = {}, authContext = null) {
  const headers = authHeader ? { authorization: authHeader } : {};
  return { headers, body, authContext };
}
function makeRes() {
  const r = { _data: null, _status: 200 };
  r.status = (s) => { r._status = s; return r; };
  r.json = (d) => { r._data = d; return r; };
  return r;
}

beforeAll(async () => {
  await setupTestDb();
  const w = await createTestWasher({ name: 'Session Washer' });
  washer = w.washer;
  branch = await createTestBranch(washer.id, { name: 'Session Branch' });
  identity = await createTestIdentity('500000030');
  membership = await createStaffMembership(identity.id, washer.id, branch.id);
});

afterAll(async () => { await teardownTestDb(); });

describe('Session Controller — logout', () => {
  let validAccessToken, validRefreshToken, sessionId;

  beforeEach(async () => {
    const result = await SessionService.createOperationalSession(identity.id, {
      washerId: washer.id, branchId: branch.id, staffMembershipId: membership.id
    });
    validAccessToken = result.accessToken;
    validRefreshToken = result.refreshToken;
    sessionId = result.session.id;
  });

  test('1. Logout with valid Access Token', async () => {
    // contextGuard provides authContext for valid access tokens (not explicitly passed here since we simulate controller layer)
    const req = makeReq(`Bearer ${validAccessToken}`);
    const res = makeRes();
    await SessionController.logout(req, res);
    
    expect(res._data.ok).toBe(true);
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(session.isRevoked).toBe(true);
    expect(session.revokedReason).toBe('logout');
  });

  test('2. Logout with expired Access Token and valid Refresh Token', async () => {
    const expiredToken = TokenService.signAccessToken({
      sessionId, identityId: identity.id, sessionType: 'operational',
      washerId: washer.id, branchId: branch.id, staffMembershipId: membership.id
    }, '-1s');

    const req = makeReq(`Bearer ${expiredToken}`, { refreshToken: validRefreshToken });
    const res = makeRes();
    await SessionController.logout(req, res);

    expect(res._data.ok).toBe(true);
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(session.isRevoked).toBe(true);
    expect(session.revokedReason).toBe('logout_via_refresh');
  });

  test('3. Rejects if Access Token and Refresh Token belong to DIFFERENT sessions (LOGOUT_TOKEN_MISMATCH)', async () => {
    const result2 = await SessionService.createOperationalSession(identity.id, {
      washerId: washer.id, branchId: branch.id, staffMembershipId: membership.id
    });
    const session2Id = result2.session.id;

    // Send valid access token for session 1, but refresh token for session 2
    const req = makeReq(`Bearer ${validAccessToken}`, { refreshToken: result2.refreshToken });
    const next = jest.fn();
    await SessionController.logout(req, makeRes(), next).catch(e => next(e));

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'LOGOUT_TOKEN_MISMATCH' }));

    // Verify neither session is revoked
    const s1 = await prisma.session.findUnique({ where: { id: sessionId } });
    const s2 = await prisma.session.findUnique({ where: { id: session2Id } });
    expect(s1.isRevoked).toBe(false);
    expect(s2.isRevoked).toBe(false);
  });

  test('4. Safe idempotent response for revoked Refresh Token', async () => {
    await SessionService.revokeSession(sessionId, 'manual');
    const req = makeReq('', { refreshToken: validRefreshToken });
    const res = makeRes();
    await SessionController.logout(req, res);
    expect(res._data.ok).toBe(true);
  });

  test('5. Safe response for unknown Refresh Token (no error)', async () => {
    const req = makeReq('', { refreshToken: 'unknown-token-string' });
    const res = makeRes();
    await SessionController.logout(req, res);
    expect(res._data.ok).toBe(true); // Does not throw error, acts idempotent
  });
});

describe('Session Controller — ping', () => {
  let sessionId, accessToken;

  beforeEach(async () => {
    const result = await SessionService.createOperationalSession(identity.id, {
      washerId: washer.id, branchId: branch.id, staffMembershipId: membership.id
    });
    sessionId = result.session.id;
    accessToken = result.accessToken;
  });

  const makeReq = (token) => ({ headers: { authorization: `Bearer ${token}` } });
  const makeRes = () => ({
    _data: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this._data = data; return this; }
  });

  test('1. returns active session details successfully', async () => {
    const req = makeReq(accessToken);
    const res = makeRes();
    const next = jest.fn();
    
    await contextGuard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();

    await SessionController.ping(req, res);
    expect(res._data.data.authenticated).toBe(true);
    expect(res._data.data.sessionId).toBe(sessionId);
    expect(res._data.data.sessionType).toBe('operational');
    expect(res._data.data.identityId).toBe(identity.id);
  });

  test('2. rejects if session is revoked (DB Fallback)', async () => {
    await prisma.session.update({ where: { id: sessionId }, data: { isRevoked: true } });
    await SessionService.invalidateSessionCache(sessionId);

    const req = makeReq(accessToken);
    const res = makeRes();
    const next = jest.fn();

    await contextGuard(req, res, next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }));
  });

  test('3. rejects if session does not exist', async () => {
    await prisma.refreshToken.deleteMany({ where: { sessionId } });
    await prisma.session.delete({ where: { id: sessionId } });
    await SessionService.invalidateSessionCache(sessionId);

    const req = makeReq(accessToken);
    const res = makeRes();
    const next = jest.fn();

    await contextGuard(req, res, next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });

  test('4. rejects expired token', async () => {
    const expiredToken = TokenService.signAccessToken({
      sessionId, identityId: identity.id, sessionType: 'operational', washerId: washer.id, branchId: branch.id, staffMembershipId: membership.id
    }, '-1h');

    const req = makeReq(expiredToken);
    const res = makeRes();
    const next = jest.fn();

    await contextGuard(req, res, next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
  });

  test('5. rejects if claim mismatch (e.g. branchId differs)', async () => {
    // Generate token with different branchId
    const badToken = TokenService.signAccessToken({
      sessionId, identityId: identity.id, sessionType: 'operational', washerId: washer.id, branchId: 'bad-branch-id', staffMembershipId: membership.id
    }, '1h');

    const req = makeReq(badToken);
    const res = makeRes();
    const next = jest.fn();

    await contextGuard(req, res, next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_SESSION_MISMATCH' }));
  });

  test('6. fails ping after remote revoke', async () => {
    // First ping works
    let req = makeReq(accessToken);
    let res = makeRes();
    let next = jest.fn();
    await contextGuard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();

    // Remote revoke
    const revokeReq = {
      authContext: { identityId: identity.id, sessionId: 'some-other-session' },
      params: { id: sessionId }
    };
    await SessionController.revokeSession(revokeReq, makeRes());

    // Next ping fails
    req = makeReq(accessToken);
    res = makeRes();
    next = jest.fn();
    await contextGuard(req, res, next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }));
  });
});
