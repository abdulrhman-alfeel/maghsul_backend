import { jest } from "@jest/globals";
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestBranch,
  createTestIdentity,
  createCustomerMembership,
  createStaffMembership
} from './test-utils.js';
import prisma from '../../config/db.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import {
  contextGuard,
  requireProvisionalSession,
  requireOperationalSession,
  requireCustomerSession,
  requireStaffSession
} from '../../middlewares/contextGuard.js';

function mockNext() { return jest.fn(); }
function makeRes() {
  const r = {};
  r.status = () => r; r.json = () => r;
  return r;
}

let washer, appClient, branch, identity;

beforeAll(async () => {
  await setupTestDb();
  ({ washer, appClient } = await createTestWasher({ appKey: 'guard-test-key' }));
  branch = await createTestBranch(washer.id);
  identity = await createTestIdentity('500000001');
});
afterAll(async () => { await teardownTestDb(); });

// ── Helper: make a req with Authorization header ──────────────────────────
function makeReq(token) {
  return {
    headers: { authorization: token ? `Bearer ${token}` : '' }
  };
}

// ── Helper: sign a crafted token with specific claims ─────────────────────
function signCrafted(claims, expiresIn = '15m') {
  return TokenService.signAccessToken(claims, expiresIn);
}

describe('ContextGuard', () => {
  test('1. rejects missing Authorization header', async () => {
    const req = { headers: {} };
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_MISSING' }));
  });

  test('2. rejects malformed Bearer token', async () => {
    const req = makeReq('not.a.valid.jwt');
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  test('3. rejects expired token', async () => {
    // Create a session, sign a token that's already expired
    const { session } = await SessionService.createProvisionalSession(identity.id, {});
    const expiredToken = signCrafted({
      sessionId: session.id,
      identityId: identity.id,
      sessionType: 'provisional',
      washerId: null
    }, '-1s'); // Already expired
    const req = makeReq(expiredToken);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
  });

  test('4. rejects token pointing to non-existent session', async () => {
    const token = signCrafted({
      sessionId: 'nonexistent-session-id',
      identityId: identity.id,
      sessionType: 'provisional',
      washerId: null
    });
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });

  test('5. rejects revoked session', async () => {
    const { session, accessToken } = await SessionService.createProvisionalSession(identity.id, {});
    await SessionService.revokeSession(session.id, 'test');
    const req = makeReq(accessToken);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }));
  });

  test('6. rejects when token identityId does not match session', async () => {
    const { session } = await SessionService.createProvisionalSession(identity.id, {});
    const token = signCrafted({
      sessionId: session.id,
      identityId: 'wrong-identity-id',
      sessionType: 'provisional',
      washerId: null
    });
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_SESSION_MISMATCH' }));
  });

  test('7. rejects when token sessionType does not match session', async () => {
    const { session } = await SessionService.createProvisionalSession(identity.id, {});
    const token = signCrafted({
      sessionId: session.id,
      identityId: identity.id,
      sessionType: 'operational', // mismatch
      washerId: null
    });
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_SESSION_MISMATCH' }));
  });

  test('8. rejects when token lacks washerId that session has', async () => {
    const { session } = await SessionService.createProvisionalSession(identity.id, { washerId: washer.id });
    // Token missing washerId (null) but session has one
    const token = signCrafted({
      sessionId: session.id,
      identityId: identity.id,
      sessionType: 'provisional'
      // washerId absent → null in token
    });
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_SESSION_MISMATCH' }));
  });

  test('9. rejects when token has different branchId than session', async () => {
    const cust = await createCustomerMembership(identity.id, washer.id);
    const { session, accessToken } = await SessionService.createOperationalSession(identity.id, {
      washerId: washer.id,
      branchId: branch.id,
      staffMembershipId: null,
      customerMembershipId: null
    });
    // Craft token with different branchId
    const token = signCrafted({
      sessionId: session.id,
      identityId: identity.id,
      sessionType: 'operational',
      washerId: washer.id,
      branchId: 'different-branch-id',
      staffMembershipId: null,
      customerMembershipId: null
    });
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_SESSION_MISMATCH' }));
  });

  test('10. accepts valid token and populates req.authContext', async () => {
    const { session, accessToken } = await SessionService.createProvisionalSession(identity.id, {});
    const req = makeReq(accessToken);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.authContext).toMatchObject({
      identityId: identity.id,
      sessionId: session.id,
      sessionType: 'provisional'
    });
  });
});

describe('requireProvisionalSession', () => {
  test('11. passes on provisional session', () => {
    const req = { authContext: { sessionType: 'provisional' } };
    const next = mockNext();
    requireProvisionalSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  test('12. rejects operational session', () => {
    const req = { authContext: { sessionType: 'operational' } };
    const next = mockNext();
    requireProvisionalSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROVISIONAL_SESSION_REQUIRED' }));
  });
});

describe('requireOperationalSession', () => {
  test('13. rejects provisional session', () => {
    const req = { authContext: { sessionType: 'provisional', customerMembershipId: null, staffMembershipId: null, washerId: null } };
    const next = mockNext();
    requireOperationalSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'OPERATIONAL_SESSION_REQUIRED' }));
  });

  test('14. rejects session with both customerMembershipId and staffMembershipId', () => {
    const req = { authContext: { sessionType: 'operational', customerMembershipId: 'c1', staffMembershipId: 's1', washerId: 'w1' } };
    const next = mockNext();
    requireOperationalSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SESSION_STATE' }));
  });

  test('15. rejects session with neither customerMembershipId nor staffMembershipId', () => {
    const req = { authContext: { sessionType: 'operational', customerMembershipId: null, staffMembershipId: null, washerId: 'w1' } };
    const next = mockNext();
    requireOperationalSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SESSION_STATE' }));
  });

  test('16. rejects session without washerId', () => {
    const req = { authContext: { sessionType: 'operational', customerMembershipId: 'c1', staffMembershipId: null, washerId: null } };
    const next = mockNext();
    requireOperationalSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SESSION_STATE' }));
  });

  test('17. passes valid customer operational session', () => {
    const req = { authContext: { sessionType: 'operational', customerMembershipId: 'c1', staffMembershipId: null, washerId: 'w1' } };
    const next = mockNext();
    requireOperationalSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('requireCustomerSession', () => {
  test('18. rejects if customerMembershipId missing', async () => {
    const req = { authContext: { sessionType: 'operational', customerMembershipId: null, staffMembershipId: null, identityId: identity.id, washerId: washer.id } };
    const next = mockNext();
    await requireCustomerSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_SESSION_REQUIRED' }));
  });

  test('19. rejects if session has staffMembershipId instead', async () => {
    const req = { authContext: { sessionType: 'operational', customerMembershipId: null, staffMembershipId: 'sm1', identityId: identity.id, washerId: washer.id } };
    const next = mockNext();
    await requireCustomerSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_SESSION_REQUIRED' }));
  });

  test('20. rejects if CustomerMembership belongs to different identity', async () => {
    const otherIdentity = await createTestIdentity('500000099');
    const membership = await createCustomerMembership(otherIdentity.id, washer.id);
    const req = { authContext: { sessionType: 'operational', customerMembershipId: membership.id, staffMembershipId: null, identityId: identity.id, washerId: washer.id } };
    const next = mockNext();
    await requireCustomerSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEMBERSHIP_IDENTITY_MISMATCH' }));
  });

  test('21. rejects if CustomerMembership belongs to different washer', async () => {
    const { washer: w2 } = await createTestWasher({ appKey: 'other-washer-key' });
    const membership = await createCustomerMembership(identity.id, w2.id);
    const req = { authContext: { sessionType: 'operational', customerMembershipId: membership.id, staffMembershipId: null, identityId: identity.id, washerId: washer.id } };
    const next = mockNext();
    await requireCustomerSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEMBERSHIP_WASHER_MISMATCH' }));
  });

  test('22. passes valid customer session', async () => {
    const membership = await createCustomerMembership(identity.id, washer.id);
    const req = { authContext: { sessionType: 'operational', customerMembershipId: membership.id, staffMembershipId: null, identityId: identity.id, washerId: washer.id } };
    const next = mockNext();
    await requireCustomerSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('requireStaffSession', () => {
  test('23. rejects if staffMembershipId missing', async () => {
    const req = { authContext: { sessionType: 'operational', staffMembershipId: null, customerMembershipId: null, identityId: identity.id, washerId: washer.id, branchId: branch.id } };
    const next = mockNext();
    await requireStaffSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'STAFF_SESSION_REQUIRED' }));
  });

  test('24. rejects if session has no branchId', async () => {
    const membership = await createStaffMembership(identity.id, washer.id, branch.id);
    const req = { authContext: { sessionType: 'operational', staffMembershipId: membership.id, customerMembershipId: null, identityId: identity.id, washerId: washer.id, branchId: null } };
    const next = mockNext();
    await requireStaffSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRANCH_CONTEXT_REQUIRED' }));
  });

  test('25. rejects if StaffMembership belongs to different identity', async () => {
    const otherIdentity = await createTestIdentity('500000098');
    const membership = await createStaffMembership(otherIdentity.id, washer.id, branch.id);
    const req = { authContext: { sessionType: 'operational', staffMembershipId: membership.id, customerMembershipId: null, identityId: identity.id, washerId: washer.id, branchId: branch.id } };
    const next = mockNext();
    await requireStaffSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEMBERSHIP_IDENTITY_MISMATCH' }));
  });

  test('26. rejects if StaffMembership belongs to different washer', async () => {
    const { washer: w3 } = await createTestWasher({ appKey: 'other-washer-staff-key' });
    const membership = await createStaffMembership(identity.id, w3.id, branch.id);
    const req = { authContext: { sessionType: 'operational', staffMembershipId: membership.id, customerMembershipId: null, identityId: identity.id, washerId: washer.id, branchId: branch.id } };
    const next = mockNext();
    await requireStaffSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEMBERSHIP_WASHER_MISMATCH' }));
  });

  test('27. rejects if staff has no access to the specific branch', async () => {
    const branch2 = await createTestBranch(washer.id, { name: 'Branch 2' });
    // Membership with access to branch only, not branch2
    const membership = await createStaffMembership(identity.id, washer.id, branch.id);
    const req = { authContext: { sessionType: 'operational', staffMembershipId: membership.id, customerMembershipId: null, identityId: identity.id, washerId: washer.id, branchId: branch2.id } };
    const next = mockNext();
    await requireStaffSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }));
  });

  test('28. passes valid staff session with BranchAccess', async () => {
    const membership = await createStaffMembership(identity.id, washer.id, branch.id);
    const req = { authContext: { sessionType: 'operational', staffMembershipId: membership.id, customerMembershipId: null, identityId: identity.id, washerId: washer.id, branchId: branch.id } };
    const next = mockNext();
    await requireStaffSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  test('29. passes staff session with hasFullWasherAccess and any active branch', async () => {
    const identity2 = await createTestIdentity('500000002');
    const membership = await createStaffMembership(identity2.id, washer.id, null, {
      hasFullWasherAccess: true,
      role: 'washer_owner'
    });
    const req = { authContext: { sessionType: 'operational', staffMembershipId: membership.id, customerMembershipId: null, identityId: identity2.id, washerId: washer.id, branchId: branch.id } };
    const next = mockNext();
    await requireStaffSession(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('Purpose matching', () => {
  test('30. passes when JWT purpose matches DB purpose', async () => {
    const { session, accessToken } = await SessionService.createProvisionalSession(identity.id, {});
    
    await prisma.session.update({
      where: { id: session.id },
      data: { purpose: 'staff_invitation_accept' }
    });
    
    const token = signCrafted({
      sessionId: session.id,
      identityId: identity.id,
      sessionType: 'provisional',
      purpose: 'staff_invitation_accept'
    });
    
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(); // no error
  });

  test('31. rejects when token purpose mismatch with DB purpose', async () => {
    const { session } = await SessionService.createProvisionalSession(identity.id, {});
    
    await prisma.session.update({
      where: { id: session.id },
      data: { purpose: 'staff_invitation_accept' }
    });
    
    const token = signCrafted({
      sessionId: session.id,
      identityId: identity.id,
      sessionType: 'provisional',
      purpose: 'login' // Mismatch
    });
    
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_SESSION_MISMATCH' }));
  });

  test('32. rejects missing JWT purpose with DB purpose non-null', async () => {
    const { session } = await SessionService.createProvisionalSession(identity.id, {});
    
    await prisma.session.update({
      where: { id: session.id },
      data: { purpose: 'login' }
    });
    
    const token = signCrafted({
      sessionId: session.id,
      identityId: identity.id,
      sessionType: 'provisional'
      // purpose absent
    });
    
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_SESSION_MISMATCH' }));
  });

  test('33. rejects token purpose present with DB purpose null', async () => {
    const { session } = await SessionService.createProvisionalSession(identity.id, {});
    
    await prisma.session.update({
      where: { id: session.id },
      data: { purpose: null }
    });
    
    const token = signCrafted({
      sessionId: session.id,
      identityId: identity.id,
      sessionType: 'provisional',
      purpose: 'login' // Present while DB is null
    });
    
    const req = makeReq(token);
    const next = mockNext();
    await contextGuard(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_SESSION_MISMATCH' }));
  });

  test('34. token service adds purpose claim', () => {
    const token = TokenService.signAccessToken({
      sessionId: 'ses-123',
      identityId: 'id-123',
      sessionType: 'provisional',
      purpose: 'staff_invitation_accept'
    });
    
    const decoded = TokenService.verifyAccessToken(token);
    expect(decoded.purpose).toBe('staff_invitation_accept');
  });
});
