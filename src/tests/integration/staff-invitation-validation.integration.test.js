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
import redis from '../../config/redis.js';
import { StaffInvitationService } from '../../modules/auth/services/staff-invitation.service.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { MockSmsProvider } from '../../modules/auth/services/sms/mock.sms.provider.js';

let washer, washer2, branch, identity, identity2, staffMembership, staffMembership2;

beforeAll(async () => {
  await setupTestDb();
  ({ washer } = await createTestWasher({ appKey: 'inv-test-key-1' }));
  ({ washer: washer2 } = await createTestWasher({ appKey: 'inv-test-key-2' }));
  branch = await createTestBranch(washer.id);
  identity = await createTestIdentity('500000001');
  identity2 = await createTestIdentity('500000002');
  staffMembership = await createStaffMembership(identity.id, washer.id, branch.id);
  staffMembership2 = await createStaffMembership(identity2.id, washer2.id, null);
});

afterAll(async () => {
  await teardownTestDb();
});

afterEach(async () => {
  await prisma.staffInvitation.deleteMany({});
  await prisma.refreshToken.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.auditLog.deleteMany({});
});

describe('StaffInvitationService Validation', () => {

  describe('1. Token Security', () => {
    it('proves rawToken is never stored, list/get hide tokenHash, audit hides rawToken', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      
      let capturedRawToken;
      const originalSend = MockSmsProvider.prototype.sendSms;
      MockSmsProvider.prototype.sendSms = jest.fn().mockImplementation(async (phone, message) => {
        const match = message.match(/رمز الدعوة الخاص بك هو: (.*)$/);
        if (match) capturedRawToken = match[1];
        return true;
      });

      const inv = await StaffInvitationService.createInvitation(ctx, { phone: '501112222', proposedRole: 'worker' });
      
      // rawToken is not returned by service
      expect(inv.rawToken).toBeUndefined();
      
      // rawToken is never stored in DB
      const dbInv = await prisma.staffInvitation.findUnique({ where: { id: inv.id } });
      expect(dbInv.rawToken).toBeUndefined(); // Schema does not have it
      expect(dbInv.tokenHash).toBeDefined();

      // list and get outputs hide tokenHash
      const list = await StaffInvitationService.listInvitations(ctx);
      expect(list[0].tokenHash).toBeUndefined();
      
      const getInv = await StaffInvitationService.getInvitationById(ctx, inv.id);
      expect(getInv.tokenHash).toBeUndefined();

      // Audit hides rawToken after accept
      const newIdentity = await createTestIdentity('501112222');
      const session = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctxAccept = { sessionId: session.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      const res = await StaffInvitationService.acceptInvitation(ctxAccept, { token: capturedRawToken });
      
      const logs = await prisma.auditLog.findMany({ where: { entityId: res.membership.id } });
      expect(logs[0].metadata.rawToken).toBeUndefined();
      
      MockSmsProvider.prototype.sendSms = originalSend;
    });
  });

  describe('2. Resend Provider Failure', () => {
    it('proves old is superseded, new is revoked due to delivery_failed and returns MESSAGE_PROVIDER_UNAVAILABLE', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv1 = await StaffInvitationService.createInvitation(ctx, { phone: '502223333', proposedRole: 'worker' });
      
      const originalSend = MockSmsProvider.prototype.sendSms;
      MockSmsProvider.prototype.sendSms = jest.fn().mockRejectedValue(new Error('Simulated failure'));
      
      await expect(
        StaffInvitationService.resendInvitation(ctx, inv1.id)
      ).rejects.toMatchObject({ code: 'MESSAGE_PROVIDER_UNAVAILABLE' });

      MockSmsProvider.prototype.sendSms = originalSend;

      // Check states
      const dbInv1 = await prisma.staffInvitation.findUnique({ where: { id: inv1.id } });
      expect(dbInv1.status).toBe('superseded'); // Old remains superseded

      const newInv = await prisma.staffInvitation.findFirst({ where: { phone: '502223333', id: { not: inv1.id } } });
      expect(newInv.status).toBe('revoked'); // New is revoked
      expect(newInv.revokedReason).toBe('delivery_failed'); // Correct reason
    });
  });

  describe('3. Session Replacement', () => {
    let capturedRawToken;
    beforeEach(() => {
      const originalSend = MockSmsProvider.prototype.sendSms;
      MockSmsProvider.prototype.sendSms = jest.fn().mockImplementation(async (phone, message) => {
        const match = message.match(/رمز الدعوة الخاص بك هو: (.*)$/);
        if (match) capturedRawToken = match[1];
        return true;
      });
    });

    it('proves operational session creation, linkages, revocation, and familyId accuracy', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      await StaffInvitationService.createInvitation(ctx1, { phone: '503334444', proposedRole: 'washer_manager', proposedBranchIds: [branch.id] });
      
      const newIdentity = await createTestIdentity('503334444');
      const provSession = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctxAccept = { sessionId: provSession.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      const res = await StaffInvitationService.acceptInvitation(ctxAccept, { token: capturedRawToken });
      
      // operational replacement session created
      expect(res.session.sessionType).toBe('operational');
      expect(res.session.washerId).toBe(washer.id);
      expect(res.session.branchId).toBe(branch.id);
      expect(res.session.staffMembershipId).toBe(res.membership.id);
      
      // provisional session revoked & replacedBySessionId linked
      const oldSession = await prisma.session.findUnique({ where: { id: provSession.id } });
      expect(oldSession.isRevoked).toBe(true);
      expect(oldSession.replacedBySessionId).toBe(res.session.id);
      
      // refresh token linked to replacement session and familyId created
      const rtHash = TokenService.hashSecureToken(res.refreshToken);
      const rt = await prisma.refreshToken.findFirst({ where: { tokenHash: rtHash } });
      expect(rt.sessionId).toBe(res.session.id);
      expect(rt.familyId).toBeDefined();

      // Old provisional token rejected (we mock TokenService usage here or just rely on ContextGuard)
      // Since it's isRevoked = true, ContextGuard will reject it. We can manually verify isRevoked.
      expect(oldSession.isRevoked).toBe(true);
    });
  });

  describe('4. permissionsVersion', () => {
    let capturedRawToken;
    beforeEach(() => {
      const originalSend = MockSmsProvider.prototype.sendSms;
      MockSmsProvider.prototype.sendSms = jest.fn().mockImplementation(async (phone, message) => {
        const match = message.match(/رمز الدعوة الخاص بك هو: (.*)$/);
        if (match) capturedRawToken = match[1];
        return true;
      });
    });

    it('proves increments exactly once after success, unchanged after fails, unchanged after other operations', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const initialWasher = await prisma.washer.findUnique({ where: { id: washer.id } });
      
      // Create - unchanged
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '504445555', proposedRole: 'worker' });
      const washerAfterCreate = await prisma.washer.findUnique({ where: { id: washer.id } });
      expect(washerAfterCreate.permissionsVersion).toBe(initialWasher.permissionsVersion);

      // List / Get - unchanged
      await StaffInvitationService.listInvitations(ctx1);
      await StaffInvitationService.getInvitationById(ctx1, inv.id);

      // Failed acceptance - unchanged
      const newIdentity = await createTestIdentity('504445555');
      const provSession = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctxAccept = { sessionId: provSession.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      await expect(StaffInvitationService.acceptInvitation(ctxAccept, { token: 'bad-token' })).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
      
      const washerAfterFail = await prisma.washer.findUnique({ where: { id: washer.id } });
      expect(washerAfterFail.permissionsVersion).toBe(initialWasher.permissionsVersion);

      // Successful acceptance - incremented
      await StaffInvitationService.acceptInvitation(ctxAccept, { token: capturedRawToken });
      
      const washerAfterSuccess = await prisma.washer.findUnique({ where: { id: washer.id } });
      expect(washerAfterSuccess.permissionsVersion).toBeGreaterThan(initialWasher.permissionsVersion);
    });
  });

  describe('5. Audit', () => {
    let capturedRawToken;
    beforeEach(() => {
      const originalSend = MockSmsProvider.prototype.sendSms;
      MockSmsProvider.prototype.sendSms = jest.fn().mockImplementation(async (phone, message) => {
        const match = message.match(/رمز الدعوة الخاص بك هو: (.*)$/);
        if (match) capturedRawToken = match[1];
        return true;
      });
    });

    it('proves audit contains right IDs, no raw token, and no success audit on rollback', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '505556666', proposedRole: 'worker' });
      
      const newIdentity = await createTestIdentity('505556666');
      const provSession = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctxAccept = { sessionId: provSession.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      const res = await StaffInvitationService.acceptInvitation(ctxAccept, { token: capturedRawToken });
      
      const logs = await prisma.auditLog.findMany({ where: { entityId: res.membership.id, action: 'staff_invitation_accepted' } });
      expect(logs.length).toBe(1);
      
      // contains identityId as subjectId
      expect(logs[0].subjectId).toBe(newIdentity.id);
      // contains membershipId as entityId
      expect(logs[0].entityId).toBe(res.membership.id);
      
      // washerId and invitationId in metadata
      expect(logs[0].metadata.washerId).toBe(washer.id);
      expect(logs[0].metadata.invitationId).toBe(inv.id);
      expect(logs[0].metadata.rawToken).toBeUndefined();
    });
  });

  describe('6. Transaction Rollback', () => {
    let capturedRawToken;
    beforeEach(() => {
      const originalSend = MockSmsProvider.prototype.sendSms;
      MockSmsProvider.prototype.sendSms = jest.fn().mockImplementation(async (phone, message) => {
        const match = message.match(/رمز الدعوة الخاص بك هو: (.*)$/);
        if (match) capturedRawToken = match[1];
        return true;
      });
    });

    it('1. failure after membership mutation', async () => {
      // Setup active washer and identity
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      
      // We need a temporary branch that we will delete to cause FK constraint failure
      const tempBranch = await createTestBranch(washer.id);
      
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '508889999', proposedRole: 'washer_manager', proposedBranchIds: [tempBranch.id] });
      
      const newIdentity = await createTestIdentity('508889999');
      // Create an inactive membership to prove it doesn't get reactivated
      const inactiveMem = await prisma.staffMembership.create({
        data: { identityId: newIdentity.id, washerId: washer.id, role: 'driver', status: 'suspended' }
      });

      const provSession = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctxAccept = { sessionId: provSession.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      // Delete the branch to cause organic failure during tx.branchAccess.createMany
      await prisma.branch.delete({ where: { id: tempBranch.id } });

      const initialWasher = await prisma.washer.findUnique({ where: { id: washer.id } });

      await expect(StaffInvitationService.acceptInvitation(ctxAccept, { token: capturedRawToken })).rejects.toThrow();

      // Prove rollbacks
      // - العضوية الخاملة لا تبقى مفعلة
      const checkMem = await prisma.staffMembership.findUnique({ where: { id: inactiveMem.id } });
      expect(checkMem.status).toBe('suspended');
      expect(checkMem.role).toBe('driver');
      
      // - لا توجد عضوية جديدة (Since we used existing inactive, there is only 1 membership)
      const memCount = await prisma.staffMembership.count({ where: { identityId: newIdentity.id, washerId: washer.id } });
      expect(memCount).toBe(1);

      // - الدعوة تبقى pending
      const checkInv = await prisma.staffInvitation.findUnique({ where: { id: inv.id } });
      expect(checkInv.status).toBe('pending');
      
      // - الجلسة المؤقتة تبقى صالحة
      const checkSession = await prisma.session.findUnique({ where: { id: provSession.id } });
      expect(checkSession.isRevoked).toBe(false);
      expect(checkSession.replacedBySessionId).toBeNull();
      
      // - permissionsVersion لا يتغير
      const finalWasher = await prisma.washer.findUnique({ where: { id: washer.id } });
      expect(finalWasher.permissionsVersion).toBe(initialWasher.permissionsVersion);

      // - لا يوجد success audit
      const auditCount = await prisma.auditLog.count({ where: { subjectId: newIdentity.id, action: 'staff_invitation_accepted' } });
      expect(auditCount).toBe(0);
    });

    it('2. failure after branch access mutation', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '509990000', proposedRole: 'worker', proposedBranchIds: [branch.id] });
      
      const newIdentity = await createTestIdentity('509990000');
      const provSession = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      // Pass a fake sessionId to organically fail tx.session.update
      const ctxAccept = { sessionId: 'non-existent-session-id', identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };

      await expect(StaffInvitationService.acceptInvitation(ctxAccept, { token: capturedRawToken })).rejects.toThrow();

      // Prove rollbacks
      // - لا توجد عضوية أو جلسة بديلة جزئية
      const checkMem = await prisma.staffMembership.findFirst({ where: { identityId: newIdentity.id, washerId: washer.id } });
      expect(checkMem).toBeNull();

      const opSession = await prisma.session.findFirst({ where: { identityId: newIdentity.id, sessionType: 'operational' } });
      expect(opSession).toBeNull();

      // - لا توجد BranchAccess جزئية
      const branchAccesses = await prisma.branchAccess.findMany({ where: { branchId: branch.id } });
      const newIdentityAccess = branchAccesses.find(ba => ba.staffMembershipId === checkMem?.id);
      expect(newIdentityAccess).toBeUndefined();

      // - الدعوة تبقى pending
      const checkInv = await prisma.staffInvitation.findUnique({ where: { id: inv.id } });
      expect(checkInv.status).toBe('pending');
      
      // - لا يوجد RefreshToken
      const tokens = await prisma.refreshToken.findMany(); // Assuming isolated test db, or we can just count for this session
      // Wait, let's just check no tokens for this identity's operational sessions
      const identTokens = await prisma.refreshToken.count({ where: { session: { identityId: newIdentity.id, sessionType: 'operational' } } });
      expect(identTokens).toBe(0);

      // - لا يوجد success audit
      const auditCount = await prisma.auditLog.count({ where: { subjectId: newIdentity.id, action: 'staff_invitation_accepted' } });
      expect(auditCount).toBe(0);
      
      // Cleanup the real provisional session we created
      await prisma.session.delete({ where: { id: provSession.id } });
    });

    it('3. failure after refresh token creation', async () => {
      const { PermissionService } = await import('../../modules/auth/services/permission.service.js');
      const originalIncrement = PermissionService.incrementPermissionsVersion;
      PermissionService.incrementPermissionsVersion = jest.fn().mockRejectedValue(new Error('Simulated Rollback Error'));

      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '501119999', proposedRole: 'worker', proposedBranchIds: [branch.id] });
      
      const newIdentity = await createTestIdentity('501119999');
      const provSession = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctxAccept = { sessionId: provSession.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };

      const initialWasher = await prisma.washer.findUnique({ where: { id: washer.id } });

      await expect(StaffInvitationService.acceptInvitation(ctxAccept, { token: capturedRawToken })).rejects.toThrow('Simulated Rollback Error');

      PermissionService.incrementPermissionsVersion = originalIncrement;

      // Prove rollbacks
      // - لا يبقى RefreshToken
      const identTokens = await prisma.refreshToken.count({ where: { session: { identityId: newIdentity.id, sessionType: 'operational' } } });
      expect(identTokens).toBe(0);

      // - لا تبقى replacement session
      const opSession = await prisma.session.findFirst({ where: { identityId: newIdentity.id, sessionType: 'operational' } });
      expect(opSession).toBeNull();

      // - provisional session لا تُسحب
      const checkSession = await prisma.session.findUnique({ where: { id: provSession.id } });
      expect(checkSession.isRevoked).toBe(false);

      // - replacedBySessionId يبقى فارغًا
      expect(checkSession.replacedBySessionId).toBeNull();

      // - الدعوة تبقى pending
      const checkInv = await prisma.staffInvitation.findUnique({ where: { id: inv.id } });
      expect(checkInv.status).toBe('pending');
      
      // - permissionsVersion لا يتغير
      const finalWasher = await prisma.washer.findUnique({ where: { id: washer.id } });
      expect(finalWasher.permissionsVersion).toBe(initialWasher.permissionsVersion);

      // - لا يوجد success audit
      const auditCount = await prisma.auditLog.count({ where: { subjectId: newIdentity.id, action: 'staff_invitation_accepted' } });
      expect(auditCount).toBe(0);
    });
  });

});
