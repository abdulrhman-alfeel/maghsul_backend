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
  staffMembership2 = await createStaffMembership(identity2.id, washer2.id, null); // For isolation testing
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

describe('StaffInvitationService', () => {
  
  describe('createInvitation', () => {
    it('1. create invitation success and normalized phone storage', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const payload = { phone: '+966501234567', proposedRole: 'worker' };
      
      const inv = await StaffInvitationService.createInvitation(ctx, payload);
      expect(inv.phone).toBe('501234567'); // Normalized
      expect(inv.status).toBe('pending');
      
      // TokenHash stored without raw token
      const dbInv = await prisma.staffInvitation.findUnique({ where: { id: inv.id } });
      expect(dbInv.tokenHash).toBeDefined();
      expect(dbInv.rawToken).toBeUndefined(); // Should not exist in schema
      expect(inv.rawToken).toBeUndefined(); // Should not be returned
    });

    it('2. duplicate pending invitation', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      await StaffInvitationService.createInvitation(ctx, { phone: '0501112222', proposedRole: 'worker' });
      
      await expect(
        StaffInvitationService.createInvitation(ctx, { phone: '501112222', proposedRole: 'worker' })
      ).rejects.toMatchObject({ code: 'DUPLICATE_INVITATION' });
    });

    it('3. concurrent create', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const promises = [
        StaffInvitationService.createInvitation(ctx, { phone: '501113333', proposedRole: 'worker' }),
        StaffInvitationService.createInvitation(ctx, { phone: '501113333', proposedRole: 'worker' })
      ];
      
      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.code).toBe('DUPLICATE_INVITATION');
    });

    it('4. inactive inviter membership', async () => {
      const inactiveMem = await createStaffMembership(identity2.id, washer.id, branch.id, { status: 'suspended' });
      const ctx = { washerId: washer.id, identityId: identity2.id, staffMembershipId: inactiveMem.id };
      
      await expect(
        StaffInvitationService.createInvitation(ctx, { phone: '501114444', proposedRole: 'worker' })
      ).rejects.toMatchObject({ code: 'INVALID_INVITER_MEMBERSHIP' });
    });

    it('5. inviter identity mismatch', async () => {
      const ctx = { washerId: washer.id, identityId: identity2.id, staffMembershipId: staffMembership.id }; // Identity mismatch
      await expect(
        StaffInvitationService.createInvitation(ctx, { phone: '501114444', proposedRole: 'worker' })
      ).rejects.toMatchObject({ code: 'INVALID_INVITER_MEMBERSHIP' });
    });

    it('6. inviter washer mismatch', async () => {
      const ctx = { washerId: washer2.id, identityId: identity.id, staffMembershipId: staffMembership.id }; // Washer mismatch
      await expect(
        StaffInvitationService.createInvitation(ctx, { phone: '501114444', proposedRole: 'worker' })
      ).rejects.toMatchObject({ code: 'INVALID_INVITER_MEMBERSHIP' });
    });
  });

  describe('listInvitations and getInvitationById', () => {
    it('7. list isolation and get isolation', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const ctx2 = { washerId: washer2.id, identityId: identity2.id, staffMembershipId: staffMembership2.id };
      
      const inv1 = await StaffInvitationService.createInvitation(ctx1, { phone: '501115555', proposedRole: 'worker' });
      const inv2 = await StaffInvitationService.createInvitation(ctx2, { phone: '501116666', proposedRole: 'worker' });

      const list1 = await StaffInvitationService.listInvitations(ctx1);
      expect(list1).toHaveLength(1);
      expect(list1[0].id).toBe(inv1.id);
      expect(list1[0].tokenHash).toBeUndefined(); // test tokenHash is hidden

      const get1 = await StaffInvitationService.getInvitationById(ctx1, inv1.id);
      expect(get1.id).toBe(inv1.id);
      expect(get1.tokenHash).toBeUndefined(); // test tokenHash is hidden

      await expect(
        StaffInvitationService.getInvitationById(ctx1, inv2.id)
      ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    });
  });

  describe('resendInvitation', () => {
    it('8. resend creates new token and supersedes old', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv1 = await StaffInvitationService.createInvitation(ctx, { phone: '501117777', proposedRole: 'worker' });
      const dbInv1 = await prisma.staffInvitation.findUnique({ where: { id: inv1.id } });

      const inv2 = await StaffInvitationService.resendInvitation(ctx, inv1.id);
      const dbInv2 = await prisma.staffInvitation.findUnique({ where: { id: inv2.id } });

      expect(dbInv2.tokenHash).not.toBe(dbInv1.tokenHash);
      
      const updatedOld = await prisma.staffInvitation.findUnique({ where: { id: inv1.id } });
      expect(updatedOld.status).toBe('superseded');
    });
  });

  describe('revokeInvitation', () => {
    it('9. revoke success', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv1 = await StaffInvitationService.createInvitation(ctx, { phone: '501118888', proposedRole: 'worker' });
      
      await StaffInvitationService.revokeInvitation(ctx, inv1.id);
      
      const updated = await prisma.staffInvitation.findUnique({ where: { id: inv1.id } });
      expect(updated.status).toBe('revoked');
      expect(updated.revokedReason).toBe('manual_revocation');
    });

    it('10. revoke already accepted', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv1 = await StaffInvitationService.createInvitation(ctx, { phone: '501119999', proposedRole: 'worker' });
      
      await prisma.staffInvitation.update({ where: { id: inv1.id }, data: { status: 'accepted' } });
      
      await expect(
        StaffInvitationService.revokeInvitation(ctx, inv1.id)
      ).rejects.toMatchObject({ code: 'INVALID_INVITATION_STATUS' });
    });
  });

  describe('Provider Failure', () => {
    it('11. provider failure compensation in create', async () => {
      const ctx = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      
      const originalSend = MockSmsProvider.prototype.sendSms;
      MockSmsProvider.prototype.sendSms = jest.fn().mockRejectedValue(new Error('Simulated failure'));
      
      await expect(
        StaffInvitationService.createInvitation(ctx, { phone: '501110000', proposedRole: 'worker' })
      ).rejects.toMatchObject({ code: 'MESSAGE_PROVIDER_UNAVAILABLE' });

      MockSmsProvider.prototype.sendSms = originalSend;

      const invs = await prisma.staffInvitation.findMany({ where: { phone: '501110000' } });
      expect(invs).toHaveLength(1);
      expect(invs[0].status).toBe('revoked');
      expect(invs[0].revokedReason).toBe('delivery_failed');
    });
  });

  describe('acceptInvitation', () => {
    // We will need a way to capture the raw token since we don't store it.
    let lastToken;
    beforeEach(() => {
      const originalSend = MockSmsProvider.prototype.sendSms;
      MockSmsProvider.prototype.sendSms = jest.fn().mockImplementation(async (phone, message) => {
        // Extract token
        const match = message.match(/رمز الدعوة الخاص بك هو: (.*)$/);
        if (match) lastToken = match[1];
        return true;
      });
    });

    it('12. accept new identity membership and proper context matching', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      await StaffInvitationService.createInvitation(ctx1, { phone: '502221111', proposedRole: 'washer_manager', proposedBranchIds: [branch.id] });
      
      const newIdentity = await createTestIdentity('502221111');
      const session = await prisma.session.create({
        data: {
          identityId: newIdentity.id,
          sessionType: 'provisional',
          purpose: 'staff_invitation_accept',
          expiresAt: new Date(Date.now() + 86400000)
        }
      });
      
      const ctx = { sessionId: session.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      const initialWasher = await prisma.washer.findUnique({ where: { id: washer.id } });
      
      const res = await StaffInvitationService.acceptInvitation(ctx, { token: lastToken });
      
      expect(res.session).toBeDefined();
      expect(res.session.sessionType).toBe('operational');
      expect(res.session.branchId).toBe(branch.id);
      expect(res.session.purpose).toBeNull(); // Because exactly 1 branch
      expect(res.accessToken).toBeDefined();
      expect(res.refreshToken).toBeDefined();
      
      const mem = await prisma.staffMembership.findUnique({ where: { id: res.membership.id }, include: { branchAccesses: true } });
      expect(mem.role).toBe('washer_manager');
      expect(mem.branchAccesses).toHaveLength(1);
      
      const finalWasher = await prisma.washer.findUnique({ where: { id: washer.id } });
      expect(finalWasher.permissionsVersion).toBeGreaterThan(initialWasher.permissionsVersion);

      const oldSession = await prisma.session.findUnique({ where: { id: session.id } });
      expect(oldSession.isRevoked).toBe(true);
      expect(oldSession.replacedBySessionId).toBe(res.session.id);
      
      const logs = await prisma.auditLog.findMany({ where: { entityId: mem.id } });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].metadata.role).toBe('washer_manager');
      expect(logs[0].metadata.rawToken).toBeUndefined();
    });

    it('13. accept with login purpose (fails)', async () => {
      const ctx = { sessionId: 'sid', identityId: identity.id, sessionType: 'provisional', purpose: 'login' };
      await expect(
        StaffInvitationService.acceptInvitation(ctx, { token: 'token' })
      ).rejects.toMatchObject({ code: 'INVALID_SESSION_PURPOSE' });
    });

    it('14. accept with operational session (fails)', async () => {
      const ctx = { sessionId: 'sid', identityId: identity.id, sessionType: 'operational', purpose: 'staff_invitation_accept' };
      await expect(
        StaffInvitationService.acceptInvitation(ctx, { token: 'token' })
      ).rejects.toMatchObject({ code: 'INVALID_SESSION_PURPOSE' });
    });

    it('15. accept with wrong token', async () => {
      const session = await prisma.session.create({
        data: { identityId: identity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctx = { sessionId: session.id, identityId: identity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      await expect(
        StaffInvitationService.acceptInvitation(ctx, { token: 'wrong-token' })
      ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    });
    
    it('16. prevent concurrent double acceptance', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const newIdentity = await createTestIdentity('502223333');
      await StaffInvitationService.createInvitation(ctx1, { phone: '502223333', proposedRole: 'worker' });

      const session1 = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const session2 = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });

      const ctxA = { sessionId: session1.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      const ctxB = { sessionId: session2.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };

      const promises = [
        StaffInvitationService.acceptInvitation(ctxA, { token: lastToken }),
        StaffInvitationService.acceptInvitation(ctxB, { token: lastToken })
      ];

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.code).toBe('CONCURRENT_ACCEPTANCE');
    });

    it('17. accept with wrong phone', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      await StaffInvitationService.createInvitation(ctx1, { phone: '503331111', proposedRole: 'worker' });
      
      const newIdentity = await createTestIdentity('503332222'); // Different phone
      const session = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctx = { sessionId: session.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      await expect(StaffInvitationService.acceptInvitation(ctx, { token: lastToken })).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    });

    it('18. accept expired invitation', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '503333333', proposedRole: 'worker' });
      
      await prisma.staffInvitation.update({ where: { id: inv.id }, data: { expiresAt: new Date(Date.now() - 10000) } }); // Expire it
      
      const newIdentity = await createTestIdentity('503333333');
      const session = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctx = { sessionId: session.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      await expect(StaffInvitationService.acceptInvitation(ctx, { token: lastToken })).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
    });

    it('19. accept revoked or superseded invitation', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '503334444', proposedRole: 'worker' });
      const token1 = lastToken;
      
      await StaffInvitationService.revokeInvitation(ctx1, inv.id);
      
      const newIdentity = await createTestIdentity('503334444');
      const session = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctx = { sessionId: session.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      await expect(StaffInvitationService.acceptInvitation(ctx, { token: token1 })).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    });

    it('20. accept already accepted invitation', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '503335555', proposedRole: 'worker' });
      
      await prisma.staffInvitation.update({ where: { id: inv.id }, data: { status: 'accepted' } });
      
      const newIdentity = await createTestIdentity('503335555');
      const session = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctx = { sessionId: session.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      await expect(StaffInvitationService.acceptInvitation(ctx, { token: lastToken })).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    });

    it('21. reactivate inactive membership and existing active membership rejects', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      await StaffInvitationService.createInvitation(ctx1, { phone: '503336666', proposedRole: 'worker' });
      const token1 = lastToken;
      
      const newIdentity = await createTestIdentity('503336666');
      
      // Create suspended membership
      const inactiveMem = await prisma.staffMembership.create({
        data: { identityId: newIdentity.id, washerId: washer.id, role: 'driver', status: 'suspended' }
      });
      
      const session = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctx = { sessionId: session.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      const res = await StaffInvitationService.acceptInvitation(ctx, { token: token1 });
      
      const updatedMem = await prisma.staffMembership.findUnique({ where: { id: inactiveMem.id } });
      expect(updatedMem.status).toBe('active');
      expect(updatedMem.role).toBe('worker'); // role updated
      
      // Now try to invite same user again
      await StaffInvitationService.createInvitation(ctx1, { phone: '503336666', proposedRole: 'worker' });
      const token2 = lastToken;
      
      const session2 = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctx2 = { sessionId: session2.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      await expect(StaffInvitationService.acceptInvitation(ctx2, { token: token2 })).rejects.toMatchObject({ code: 'MEMBERSHIP_ALREADY_ACTIVE' });
    });

    it('22. cross-washer branch rejected and invalid branch rejected', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      
      // Washer2 branch
      const branch2 = await createTestBranch(washer2.id);
      
      await expect(StaffInvitationService.createInvitation(ctx1, { phone: '503337777', proposedRole: 'worker', proposedBranchIds: [branch2.id] }))
        .rejects.toMatchObject({ code: 'INVALID_BRANCHES' });

      await expect(StaffInvitationService.createInvitation(ctx1, { phone: '503337777', proposedRole: 'worker', proposedBranchIds: ['invalid-id'] }))
        .rejects.toMatchObject({ code: 'INVALID_BRANCHES' });
    });

    it('23. rollback on failure leaves no partial state', async () => {
      const ctx1 = { washerId: washer.id, identityId: identity.id, staffMembershipId: staffMembership.id };
      const inv = await StaffInvitationService.createInvitation(ctx1, { phone: '503338888', proposedRole: 'worker' });
      
      const newIdentity = await createTestIdentity('503338888');
      const session = await prisma.session.create({
        data: { identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept', expiresAt: new Date(Date.now() + 86400000) }
      });
      const ctx = { sessionId: session.id, identityId: newIdentity.id, sessionType: 'provisional', purpose: 'staff_invitation_accept' };
      
      // Mock PermissionService to throw an error
      const { PermissionService } = await import('../../modules/auth/services/permission.service.js');
      const originalIncrement = PermissionService.incrementPermissionsVersion;
      PermissionService.incrementPermissionsVersion = jest.fn().mockRejectedValue(new Error('Simulated DB Error'));
      
      await expect(StaffInvitationService.acceptInvitation(ctx, { token: lastToken })).rejects.toThrow('Simulated DB Error');
      
      PermissionService.incrementPermissionsVersion = originalIncrement;
      
      // Prove no partial records
      const checkInv = await prisma.staffInvitation.findUnique({ where: { id: inv.id } });
      expect(checkInv.status).toBe('pending'); // Rollback successful
      
      const checkMem = await prisma.staffMembership.findFirst({ where: { identityId: newIdentity.id, washerId: washer.id } });
      expect(checkMem).toBeNull(); // No membership created
      
      const checkSession = await prisma.session.findUnique({ where: { id: session.id } });
      expect(checkSession.isRevoked).toBe(false); // Session not revoked
      expect(checkSession.replacedBySessionId).toBeNull();
      
      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'StaffMembership', subjectId: newIdentity.id } });
      expect(audit).toBeNull(); // No audit log
    });
  });
});
