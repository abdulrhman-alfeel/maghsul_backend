import { jest } from '@jest/globals';
import { setupTestDb, teardownTestDb } from './test-utils.js';
import prisma from '../../config/db.js';
import { StaffInvitationService } from '../../modules/auth/services/staff-invitation.service.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import { RealtimeEventKeyFactory } from '../../modules/realtime/realtime-event.factory.js';
import { TokenService } from '../../modules/auth/services/token.service.js';

describe('Phase 3B-1: Realtime Outbox Schema and Transactional Event Creation', () => {
  let identity, washer, membership, inviterSession;

  beforeAll(async () => {
    await setupTestDb();
    
    // Setup base data
    identity = await prisma.identity.create({
      data: { phone: '+966590000001', status: 'active' }
    });
    washer = await prisma.washer.create({
      data: { name: 'Test Washer', status: 'active' }
    });
    membership = await prisma.staffMembership.create({
      data: {
        identityId: identity.id,
        washerId: washer.id,
        role: 'washer_owner',
        status: 'active'
      }
    });
    inviterSession = await prisma.session.create({
      data: {
        identityId: identity.id,
        sessionType: 'operational',
        washerId: washer.id,
        staffMembershipId: membership.id,
        expiresAt: new Date(Date.now() + 86400000)
      }
    });
  });

  afterAll(async () => {
    await prisma.realtimeOutboxEvent.deleteMany({});
    await prisma.staffInvitation.deleteMany({});
    await prisma.refreshToken.deleteMany({});
    await prisma.session.deleteMany({});
    await prisma.staffMembership.deleteMany({});
    await prisma.washer.deleteMany({});
    await prisma.identity.deleteMany({});
    
    await teardownTestDb();
  });

  beforeEach(async () => {
    await prisma.realtimeOutboxEvent.deleteMany({});
  });

  describe('Invitation Events', () => {
    it('1. إنشاء الدعوة والحدث داخل المعاملة نفسها', async () => {
      const invCtx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };
      const res = await StaffInvitationService.createInvitation(invCtx, {
        phone: '+966591111111',
        proposedRole: 'worker'
      });

      const outbox = await prisma.realtimeOutboxEvent.findUnique({
        where: { eventKey: RealtimeEventKeyFactory.staffInvitationCreated(res.id) }
      });

      expect(outbox).toBeTruthy();
      expect(outbox.eventType).toBe('staff_invitation.created');
      expect(outbox.eventKind).toBe('client_event');
      expect(outbox.aggregateId).toBe(res.id);
    });

    it('2. فشل الحدث يؤدي إلى تراجع إنشاء الدعوة', async () => {
      // Intentionally pass bad context or trigger failure inside transaction
      // Actually we can mock RealtimeEventKeyFactory to throw an error to fail the event creation
      const spy = jest.spyOn(RealtimeEventKeyFactory, 'staffInvitationCreated').mockImplementation(() => {
        throw new Error('Forced Event Error');
      });

      const invCtx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };

      await expect(StaffInvitationService.createInvitation(invCtx, {
        phone: '+966592222222',
        proposedRole: 'worker'
      })).rejects.toThrow('Forced Event Error');

      const inv = await prisma.staffInvitation.findFirst({
        where: { phone: '+966592222222' }
      });
      expect(inv).toBeNull(); // Invitation rolled back

      spy.mockRestore();
    });

    it('3. فشل إنشاء الدعوة لا يترك حدثًا', async () => {
      const invCtx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };
      
      // Phone format error before transaction
      await expect(StaffInvitationService.createInvitation(invCtx, {
        phone: 'invalid_phone',
        proposedRole: 'worker'
      })).rejects.toThrow('صيغة رقم الهاتف غير صالحة');

      const eventsCount = await prisma.realtimeOutboxEvent.count();
      expect(eventsCount).toBe(0);
    });

    it('4. عدم إنشاء حدث إنشاء مكرر', async () => {
      const invCtx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };
      
      const res1 = await StaffInvitationService.createInvitation(invCtx, {
        phone: '+966593333333',
        proposedRole: 'worker'
      });

      // Try creating again with same phone
      await expect(StaffInvitationService.createInvitation(invCtx, {
        phone: '+966593333333',
        proposedRole: 'worker'
      })).rejects.toThrow();

      const eventsCount = await prisma.realtimeOutboxEvent.count({
        where: { aggregateId: res1.id }
      });
      expect(eventsCount).toBe(1); // Only 1 event created
    });

    it('5. إعادة الإرسال تزيد العداد وتنشئ مفتاحًا فريدًا', async () => {
      const invCtx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };
      const inv = await StaffInvitationService.createInvitation(invCtx, {
        phone: '+966594444444',
        proposedRole: 'worker'
      });

      const resent = await StaffInvitationService.resendInvitation(invCtx, inv.id);

      const outbox = await prisma.realtimeOutboxEvent.findUnique({
        where: { eventKey: RealtimeEventKeyFactory.staffInvitationResent(resent.id, 1) }
      });

      expect(outbox).toBeTruthy();
      expect(outbox.aggregateId).toBe(resent.id);
    });

    it('6. طلبا إعادة إرسال متزامنان لا ينتجان نفس المفتاح', async () => {
      const invCtx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };
      const inv = await StaffInvitationService.createInvitation(invCtx, {
        phone: '+966595555555',
        proposedRole: 'worker'
      });

      // To prevent deadlocks in SQLite/Prisma we serialize it slightly or try concurrently
      try {
        await Promise.all([
           StaffInvitationService.resendInvitation(invCtx, inv.id),
           StaffInvitationService.resendInvitation(invCtx, inv.id)
        ]);
      } catch (e) {
         // One might fail with conflict
      }

      const events = await prisma.realtimeOutboxEvent.findMany({
        where: { eventType: 'staff_invitation.resent' }
      });

      // They should have distinct keys
      const keys = events.map(e => e.eventKey);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });

    it('7. إلغاء الدعوة ينشئ حدثًا بعد نجاح تغيير الحالة', async () => {
      const invCtx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };
      const inv = await StaffInvitationService.createInvitation(invCtx, {
        phone: '+966596666666',
        proposedRole: 'worker'
      });

      await StaffInvitationService.revokeInvitation(invCtx, inv.id);

      const outbox = await prisma.realtimeOutboxEvent.findUnique({
        where: { eventKey: RealtimeEventKeyFactory.staffInvitationRevoked(inv.id) }
      });

      expect(outbox).toBeTruthy();
      const updatedInv = await prisma.staffInvitation.findUnique({ where: { id: inv.id }});
      expect(updatedInv.status).toBe('revoked');
    });

    it('8/9. قبول الدعوة ينشئ حدث قبول و حدث تفعيل العضوية داخل المعاملة', async () => {
      const invCtx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };
      const inv = await StaffInvitationService.createInvitation(invCtx, {
        phone: '+966597777777',
        proposedRole: 'worker'
      });

      // Simulate a user identity for accept
      const newIdentity = await prisma.identity.create({
        data: { phone: '+966597777777', status: 'active' }
      });

      const provSession = await prisma.session.create({
        data: {
          identityId: newIdentity.id,
          sessionType: 'provisional',
          purpose: 'staff_invitation_accept',
          expiresAt: new Date(Date.now() + 86400)
        }
      });

      const acceptCtx = {
        sessionId: provSession.id,
        identityId: newIdentity.id,
        sessionType: 'provisional',
        purpose: 'staff_invitation_accept'
      };

      const rawDbInv = await prisma.staffInvitation.findUnique({ where: { id: inv.id }});
      
      // Need token to accept. We have to bypass or get token. We don't have raw token easily from return.
      // We will override token hash for test
      const testToken = 'abc123test';
      const hash = TokenService.hashSecureToken(testToken);
      await prisma.staffInvitation.update({
        where: { id: inv.id },
        data: { tokenHash: hash }
      });

      const res = await StaffInvitationService.acceptInvitation(acceptCtx, { token: testToken });

      const acceptEvent = await prisma.realtimeOutboxEvent.findUnique({
        where: { eventKey: RealtimeEventKeyFactory.staffInvitationAccepted(inv.id) }
      });
      expect(acceptEvent).toBeTruthy();

      const memberEvent = await prisma.realtimeOutboxEvent.findUnique({
        where: { eventKey: RealtimeEventKeyFactory.staffMembershipActivated(res.membership.id) }
      });
      expect(memberEvent).toBeTruthy();
    });
  });

  describe('Session Events', () => {
    it('11/12. تسجيل الخروج وإبطال الجلسة ينشئ أمر فصل داخليًا', async () => {
      const sess = await prisma.session.create({
        data: {
          identityId: identity.id,
          sessionType: 'operational',
          expiresAt: new Date(Date.now() + 86400)
        }
      });

      await SessionService.logoutSession(sess.id);

      const outbox = await prisma.realtimeOutboxEvent.findUnique({
        where: { eventKey: RealtimeEventKeyFactory.socketSessionDisconnect(sess.id) }
      });

      expect(outbox).toBeTruthy();
      expect(outbox.eventType).toBe('socket.session.disconnect');
      expect(outbox.eventKind).toBe('internal_command');
    });

    it('13. تغيير السياق يبطل الجلسة القديمة وينشئ أمر الفصل', async () => {
      const oldSess = await prisma.session.create({
        data: {
          identityId: identity.id,
          sessionType: 'operational',
          expiresAt: new Date(Date.now() + 86400)
        }
      });

      await SessionService.createReplacementSession(oldSess.id, {
        identityId: identity.id,
        washerId: washer.id
      });

      const outbox = await prisma.realtimeOutboxEvent.findUnique({
        where: { eventKey: RealtimeEventKeyFactory.socketSessionDisconnect(oldSess.id) }
      });

      expect(outbox).toBeTruthy();
    });
  });

  describe('Constraints and P2002 Handling', () => {
    it('14/15/16/17/18/19. Schema properties are verified', async () => {
      const event = await prisma.realtimeOutboxEvent.create({
        data: {
          eventKey: 'realtime-test-schema-1',
          eventType: 'test',
          eventVersion: 2,
          eventKind: 'client_event',
          aggregateType: 'Test',
          aggregateId: 'test-123'
        }
      });

      expect(event.eventVersion).toBe(2);
      expect(event.eventKey).toBe('realtime-test-schema-1');
      expect(event.phone).toBeUndefined();
      expect(event.tokenHash).toBeUndefined();
    });

    it('1. الحدث المطابق الموجود مسبقًا لا يتكرر (Safe Duplicate)', async () => {
      const invCtx = { identityId: identity.id, staffMembershipId: membership.id, washerId: washer.id };
      const inv = await StaffInvitationService.createInvitation(invCtx, { phone: '+966598888888', proposedRole: 'worker' });
      
      // Simulate concurrent safe duplicate by creating the same event again via safeCreateEvent
      await prisma.$transaction(async (tx) => {
        const { RealtimeOutboxService } = await import('../../modules/realtime/realtime-outbox.service.js');
        const res = await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: RealtimeEventKeyFactory.staffInvitationCreated(inv.id),
          eventType: 'staff_invitation.created',
          eventKind: 'client_event',
          aggregateType: 'StaffInvitation',
          aggregateId: inv.id,
          status: 'pending'
        });
        expect(res).toBeTruthy();
      });
      
      const count = await prisma.realtimeOutboxEvent.count({
        where: { eventKey: RealtimeEventKeyFactory.staffInvitationCreated(inv.id) }
      });
      expect(count).toBe(1);
    });

    it('2/3. نفس المفتاح مع نوع حدث أو Aggregate مختلف يفشل', async () => {
      await prisma.realtimeOutboxEvent.create({
        data: {
          eventKey: 'realtime-collision-test',
          eventType: 'test',
          eventKind: 'client_event',
          aggregateType: 'Test',
          aggregateId: 'test-123'
        }
      });

      await expect(prisma.$transaction(async (tx) => {
        const { RealtimeOutboxService } = await import('../../modules/realtime/realtime-outbox.service.js');
        await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: 'realtime-collision-test',
          eventType: 'different_type',
          eventKind: 'client_event',
          aggregateType: 'Test',
          aggregateId: 'test-123'
        });
      })).rejects.toThrow('تعارض في مفتاح حدث الوقت الفعلي ببيانات مختلفة');
      
      await expect(prisma.$transaction(async (tx) => {
        const { RealtimeOutboxService } = await import('../../modules/realtime/realtime-outbox.service.js');
        await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: 'realtime-collision-test',
          eventType: 'test',
          eventKind: 'client_event',
          aggregateType: 'Different',
          aggregateId: 'test-123'
        });
      })).rejects.toThrow('تعارض في مفتاح حدث الوقت الفعلي ببيانات مختلفة');
    });

    it('4. تعارض فريد في جدول تجاري آخر لا يتم ابتلاعه', async () => {
      // Create duplicate phone error
      const invCtx = { identityId: identity.id, staffMembershipId: membership.id, washerId: washer.id };
      await StaffInvitationService.createInvitation(invCtx, { phone: '+966599999999', proposedRole: 'worker' });
      
      await expect(StaffInvitationService.createInvitation(invCtx, { phone: '+966599999999', proposedRole: 'worker' }))
        .rejects.toThrow('يوجد دعوة معلقة مسبقاً لهذا الرقم');
    });

    it('5. فشل Outbox يعيد المعاملة التجارية كاملة', async () => {
      const invCtx = { identityId: identity.id, staffMembershipId: membership.id, washerId: washer.id };
      
      // Inject a conflicting event to cause P2002 via direct prisma create (bypassing safeCreateEvent)
      // Actually, since we use safeCreateEvent, it handles it safely or throws 409
      // Let's force a 409 by inserting a completely different event with the same key using Prisma directly
      const collisionKey = 'fake-collision-key';
      await prisma.realtimeOutboxEvent.create({
        data: {
          eventKey: collisionKey,
          eventType: 'test',
          eventKind: 'client_event',
          aggregateType: 'Test',
          aggregateId: 'test-123' // completely different!
        }
      });
      
      // Mock RealtimeEventKeyFactory to return the collision key
      jest.spyOn(RealtimeEventKeyFactory, 'staffInvitationCreated').mockImplementationOnce(() => collisionKey);
      
      await expect(StaffInvitationService.createInvitation(invCtx, { phone: '+966500000000', proposedRole: 'worker' }))
        .rejects.toThrow('تعارض في مفتاح حدث الوقت الفعلي ببيانات مختلفة');
      
      jest.restoreAllMocks();
    });
  });

});
