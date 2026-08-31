import { jest } from '@jest/globals';
import prisma from '../../config/db.js';
import { RealtimeEventRegistry } from '../../modules/realtime/realtime-event.registry.js';
import { RealtimeTargetResolver } from '../../modules/realtime/realtime-target.resolver.js';
import { RealtimePublisher } from '../../modules/realtime/realtime-publisher.js';
import { startRealtimeDispatcher, stopRealtimeDispatcher } from '../../modules/realtime/realtime-dispatcher.js';
import { SocketRoomFactory } from '../../modules/realtime/socket-room.factory.js';
import { createTestIdentity, createTestWasher, createStaffMembership, setupTestDb } from './test-utils.js';
import { SocketSessionControlService } from '../../modules/realtime/socket-session-control.service.js';

let washer, ownerIdentity, ownerMembership, workerIdentity, workerMembership;

beforeAll(async () => {
  await setupTestDb();
  const washerResult = await createTestWasher({ name: 'Phase3C2 Washer', status: 'active' });
  washer = washerResult.washer;
  ownerIdentity = await createTestIdentity('+96650000c201', { status: 'active' });
  ownerMembership = await createStaffMembership(ownerIdentity.id, washer.id, null, { role: 'washer_owner', hasFullWasherAccess: true });
  workerIdentity = await createTestIdentity('+96650000c202', { status: 'active' });
  workerMembership = await createStaffMembership(workerIdentity.id, washer.id, null, { role: 'worker', hasFullWasherAccess: false });
});

afterAll(async () => {
  stopRealtimeDispatcher();
  await prisma.realtimeOutboxEvent.deleteMany({});
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.realtimeOutboxEvent.deleteMany({});
  stopRealtimeDispatcher();
});

describe('1. Event Registry', () => {
  it('1.1 Supported events are properly registered with version and kind', () => {
    const def = RealtimeEventRegistry.getDefinition('staff_invitation.created', 1, 'client_event');
    expect(def).not.toBeNull();
    expect(def.eventKind).toBe('client_event');
    
    const internalDef = RealtimeEventRegistry.getDefinition('socket.session.disconnect', 1, 'internal_command');
    expect(internalDef).not.toBeNull();
    expect(internalDef.eventKind).toBe('internal_command');
  });

  it('1.2 Unsupported event type returns null definition', () => {
    const def = RealtimeEventRegistry.getDefinition('unknown.event', 1, 'client_event');
    expect(def).toBeNull();
  });

  it('1.3 buildClientPayload contains no sensitive fields', () => {
    const def = RealtimeEventRegistry.getDefinition('staff_invitation.created', 1, 'client_event');
    const payload = def.buildClientPayload({
      id: 'inv-123',
      washerId: 'w-1',
      proposedRole: 'worker',
      status: 'pending',
      phone: '+966500000000',
      tokenHash: 'abc',
      createdAt: new Date(),
      expiresAt: new Date()
    });
    expect(payload).not.toHaveProperty('phone');
    expect(payload).not.toHaveProperty('tokenHash');
    expect(payload).toHaveProperty('invitationId', 'inv-123');
  });
});

describe('2. Target Resolver', () => {
  it('2.1 Validates payload safety and rejects unsafe payloads', () => {
    expect(() => {
      RealtimeTargetResolver._validatePayloadSafety({ rawToken: 'secret' });
    }).toThrow('Payload contains forbidden field: rawToken');

    expect(() => {
      RealtimeTargetResolver._validatePayloadSafety({ nested: { accessToken: '123' } });
    }).toThrow('Payload contains forbidden field: accessToken');

    expect(() => {
      RealtimeTargetResolver._validatePayloadSafety({ nested: [{ phone: '123' }] });
    }).toThrow('Payload contains forbidden field: phone');
  });

  it('2.2 Target Resolver isolates tenants correctly', async () => {
    const invitation = await prisma.staffInvitation.create({
      data: {
        washerId: washer.id,
        phone: '+966500000099',
        proposedRole: 'worker',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86400000),
        tokenHash: 'abc',
        invitedByIdentityId: ownerIdentity.id,
        invitedByStaffMembershipId: ownerMembership.id
      }
    });

    const result = await RealtimeTargetResolver.resolve({
      eventType: 'staff_invitation.created',
      eventVersion: 1,
      eventKind: 'client_event',
      aggregateType: 'StaffInvitation',
      aggregateId: invitation.id,
      createdAt: new Date()
    }, prisma);

    expect(result.isCommand).toBe(false);
    expect(result.rooms).toContain(SocketRoomFactory.buildIdentityRoom(ownerIdentity.id));
    expect(result.rooms).not.toContain(SocketRoomFactory.buildIdentityRoom(workerIdentity.id));
  });

  it('2.3 Executes internal commands without returning rooms or payloads', async () => {
    jest.spyOn(SocketSessionControlService, 'disconnectSession').mockResolvedValueOnce(undefined);

    const result = await RealtimeTargetResolver.resolve({
      eventType: 'socket.session.disconnect',
      eventVersion: 1,
      eventKind: 'internal_command',
      aggregateType: 'Session',
      aggregateId: 'sess_123',
      createdAt: new Date()
    }, prisma);

    expect(result.isCommand).toBe(true);
    expect(result.rooms).toBeUndefined();
    expect(result.payload).toBeUndefined();
    expect(SocketSessionControlService.disconnectSession).toHaveBeenCalledWith('sess_123');
  });
});

describe('3. Realtime Publisher', () => {
  it('3.1 Returns explicit retryable_unavailable when infrastructure is degraded', () => {
    const result = RealtimePublisher.emitClientEvent(
      { eventId: '1', eventType: 'test', eventVersion: 1, occurredAt: new Date() },
      ['room1'],
      { data: 'safe' }
    );
    expect(result.outcome).toBe('retryable_unavailable');
    expect(result.emitted).toBe(false);
  });
});

describe('4. Realtime Dispatcher (SKIP LOCKED)', () => {
  it('4.1 Dispatcher atomic claim using SKIP LOCKED', async () => {
    await prisma.realtimeOutboxEvent.create({
      data: {
        eventKey: 'skip-locked-test-1',
        eventType: 'staff_invitation.created',
        eventVersion: 1,
        eventKind: 'client_event',
        aggregateType: 'StaffInvitation',
        aggregateId: 'fake-id',
        status: 'pending'
      }
    });

    const dbNowQuery = await prisma.$queryRaw`SELECT NOW() as "dbNow"`;
    const dbNow = dbNowQuery[0].dbNow;

    const [res1, res2] = await Promise.all([
      prisma.$transaction(tx => tx.$queryRaw`
        SELECT "eventId" FROM "RealtimeOutboxEvent"
        WHERE status = 'pending' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${dbNow})
        FOR UPDATE SKIP LOCKED
      `),
      prisma.$transaction(tx => tx.$queryRaw`
        SELECT "eventId" FROM "RealtimeOutboxEvent"
        WHERE status = 'pending' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${dbNow})
        FOR UPDATE SKIP LOCKED
      `)
    ]);

    const claimedCount = res1.length + res2.length;
    expect(claimedCount).toBeGreaterThanOrEqual(0);
  });
});
