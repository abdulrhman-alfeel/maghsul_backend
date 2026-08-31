import { jest } from '@jest/globals';
import { setupTestDb, teardownTestDb } from './test-utils.js';
import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { TokenService } from '../../modules/auth/services/token.service.js';

describe('Phase 2A: Staff Invitation Transactional Outbox', () => {
  let washer, inviterIdentity, inviterMembership, session, accessToken;

  beforeAll(async () => {
    await setupTestDb();
    // Clear relevant data
    await prisma.notificationOutboxEvent.deleteMany({});
    await prisma.staffInvitation.deleteMany({});
    await prisma.session.deleteMany({});
    await prisma.staffMembership.deleteMany({});
    await prisma.identity.deleteMany({});
    await prisma.washer.deleteMany({});

    washer = await prisma.washer.create({
      data: { name: 'Outbox Test Washer', status: 'active' }
    });

    inviterIdentity = await prisma.identity.create({
      data: { phone: '555555555', status: 'active' }
    });

    const branch = await prisma.branch.create({
      data: {
        washerId: washer.id,
        name: 'Main Branch'
      }
    });

    inviterMembership = await prisma.staffMembership.create({
      data: {
        identityId: inviterIdentity.id,
        washerId: washer.id,
        role: 'washer_manager',
        status: 'active',
        branchAccesses: {
          create: [{ branchId: branch.id }]
        }
      }
    });

    session = await prisma.session.create({
      data: {
        identityId: inviterIdentity.id,
        sessionType: 'operational',
        staffMembershipId: inviterMembership.id,
        washerId: washer.id,
        branchId: branch.id,
        expiresAt: new Date(Date.now() + 1000000)
      }
    });

    const permCodes = [
      'staff.invitation.create',
      'staff.invitation.read',
      'staff.invitation.resend',
      'staff.invitation.revoke',
    ];
    for (const code of permCodes) {
      const perm = await prisma.permission.upsert({
        where: { code },
        create: { code, name: code, description: code, scope: 'washer', isActive: true },
        update: {},
      });
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role: inviterMembership.role, permissionId: perm.id } },
        create: { role: inviterMembership.role, permissionId: perm.id },
        update: {},
      });
    }

    accessToken = TokenService.signAccessToken({
      sessionId: session.id,
      identityId: inviterIdentity.id,
      sessionType: 'operational',
      staffMembershipId: inviterMembership.id,
      washerId: washer.id,
      branchId: branch.id
    }, '1h');
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  describe('Outbox Event Creation', () => {
    let createdInvitationId;

    it('should create invitation and outbox event in same transaction', async () => {
      const res = await request(app)
        .post('/api/staff-invitations')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          phone: '0555555556',
          proposedRole: 'worker'
        });

      expect(res.status).toBe(201);
      createdInvitationId = res.body.data.id;

      // Verify Outbox Event exists
      const event = await prisma.notificationOutboxEvent.findUnique({
        where: { eventKey: `staff-invitation-created-${createdInvitationId}` }
      });

      expect(event).not.toBeNull();
      expect(event.eventType).toBe('staff_invitation.created');
      expect(event.status).toBe('pending');
      expect(event.aggregateId).toBe(createdInvitationId);
      expect(event.washerId).toBe(washer.id);
      
      // Ensure no sensitive data
      expect(JSON.stringify(event)).not.toContain('tokenHash');
      expect(JSON.stringify(event)).not.toContain('rawToken');
    });

    it('should not allow duplicate created events due to unique eventKey constraint', async () => {
      // Manual attempt to create duplicate
      await expect(
        prisma.notificationOutboxEvent.create({
          data: {
            eventKey: `staff-invitation-created-${createdInvitationId}`,
            washerId: washer.id,
            eventType: 'staff_invitation.created',
            aggregateType: 'StaffInvitation',
            aggregateId: createdInvitationId,
            status: 'pending'
          }
        })
      ).rejects.toThrow(); // Prisma throws P2002 on unique constraint
    });

    it('should increment resendCount and create unique resent event keys', async () => {
      // First resend
      const resend1 = await request(app)
        .post(`/api/staff-invitations/${createdInvitationId}/resend`)
        .set('Authorization', `Bearer ${accessToken}`);
      
      expect(resend1.status).toBe(201);
      const newInvId1 = resend1.body.data.id;

      const dbInv1 = await prisma.staffInvitation.findUnique({ where: { id: newInvId1 } });
      expect(dbInv1.resendCount).toBe(1);

      const event1 = await prisma.notificationOutboxEvent.findUnique({
        where: { eventKey: `staff-invitation-resent-${newInvId1}-1` }
      });
      expect(event1).not.toBeNull();

      // Second resend
      const resend2 = await request(app)
        .post(`/api/staff-invitations/${newInvId1}/resend`)
        .set('Authorization', `Bearer ${accessToken}`);
      
      expect(resend2.status).toBe(201);
      const newInvId2 = resend2.body.data.id;

      const dbInv2 = await prisma.staffInvitation.findUnique({ where: { id: newInvId2 } });
      expect(dbInv2.resendCount).toBe(2);

      const event2 = await prisma.notificationOutboxEvent.findUnique({
        where: { eventKey: `staff-invitation-resent-${newInvId2}-2` }
      });
      expect(event2).not.toBeNull();
      
      createdInvitationId = newInvId2; // update for next test
    });

    it('should create accepted event securely', async () => {
      // We need to fetch the tokenHash directly for testing (mocking SMS reception)
      const inv = await prisma.staffInvitation.findUnique({ where: { id: createdInvitationId } });
      
      // Creating identity for invited user
      const inviteeIdentity = await prisma.identity.create({
        data: { phone: '555555556', status: 'active' }
      });

      const provisionalSession = await prisma.session.create({
        data: {
          identityId: inviteeIdentity.id,
          sessionType: 'provisional',
          purpose: 'staff_invitation_accept',
          expiresAt: new Date(Date.now() + 1000000)
        }
      });

      const inviteeToken = TokenService.signAccessToken({
        sessionId: provisionalSession.id,
        identityId: inviteeIdentity.id,
        sessionType: 'provisional',
        purpose: 'staff_invitation_accept'
      }, '15m');

      // Since we don't have rawToken (it's only in SMS), we'll bypass controller for this test
      // by temporarily setting tokenHash to a known hash.
      const testRawToken = '123456';
      const testHash = TokenService.hashSecureToken(testRawToken);
      
      await prisma.staffInvitation.update({
        where: { id: createdInvitationId },
        data: { tokenHash: testHash }
      });

      const acceptRes = await request(app)
        .post(`/api/staff-invitations/${createdInvitationId}/accept`)
        .set('Authorization', `Bearer ${inviteeToken}`)
        .send({ token: testRawToken });

      expect(acceptRes.status).toBe(200);

      // Verify Accepted Event
      const acceptEvent = await prisma.notificationOutboxEvent.findUnique({
        where: { eventKey: `staff-invitation-accepted-${createdInvitationId}` }
      });

      expect(acceptEvent).not.toBeNull();
      expect(acceptEvent.eventType).toBe('staff_invitation.accepted');
      expect(acceptEvent.status).toBe('pending');
    });

    it('should not swallow other P2002 unique constraint errors as eventKey duplicates', async () => {
      // Intentionally cause a duplicate tokenHash error by mocking it or inserting one
      const dummyInv = await prisma.staffInvitation.create({
        data: {
          washerId: washer.id,
          phone: '966500000000',
          proposedRole: 'worker',
          invitedByIdentityId: inviterIdentity.id,
          invitedByStaffMembershipId: inviterMembership.id,
          tokenHash: 'duplicate-hash-123',
          expiresAt: new Date(Date.now() + 100000),
          status: 'pending'
        }
      });

      // Now try to create another invitation using the service but force it to generate the same hash
      // The easiest way is to mock TokenService.hashSecureToken
      const originalHashFunc = TokenService.hashSecureToken;
      TokenService.hashSecureToken = jest.fn().mockReturnValue('duplicate-hash-123');

      const res = await request(app)
        .post('/api/staff-invitations')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          phone: '0555555559',
          proposedRole: 'worker'
        });

      TokenService.hashSecureToken = originalHashFunc; // restore

      expect(res.status).toBe(409);
      // The error should be DUPLICATE_INVITATION (or equivalent), NOT DUPLICATE_EVENT_KEY
      expect(res.body.code).toBe('DUPLICATE_INVITATION');
    });

  });
});
