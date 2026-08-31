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
