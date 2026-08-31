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
      
      await expect(StaffInvitationService.acceptInvitation(ctx, { token: lastToken })).rejects.toMatchObject({ code: 'INVALID_INVITATION_STATUS' });
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
      
      await expect(StaffInvitationService.acceptInvitation(ctx, { token: token1 })).rejects.toMatchObject({ code: 'INVALID_INVITATION_STATUS' });
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
      
      await expect(StaffInvitationService.acceptInvitation(ctx, { token: lastToken })).rejects.toMatchObject({ code: 'INVALID_INVITATION_STATUS' });
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
      
      // Wait, we can't create an invitation if the membership is active? No, createInvitation doesn't block it unless we added that check.
      // Let's see what happens on accept
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
