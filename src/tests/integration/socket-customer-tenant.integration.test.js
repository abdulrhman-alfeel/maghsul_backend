import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import prisma from '../../config/db.js';
import { createSocketContextResolver } from '../../modules/realtime/socket-context.resolver.js';
import { SocketRoomService } from '../../modules/realtime/socket-room.service.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestIdentity,
  createCustomerMembership
} from './test-utils.js';

describe('Socket Customer Tenant Realtime Architecture (SOCKET-1 to SOCKET-6)', () => {
  let washerA, washerB, inactiveWasher;
  let customerIdentity;
  let membershipA, membershipB;
  let customerToken, customerSession;
  let resolveContext;

  beforeAll(async () => {
    await setupTestDb();

    // 1. Create Washers
    ({ washer: washerA } = await createTestWasher({ name: 'Socket Washer A', status: 'active' }));
    ({ washer: washerB } = await createTestWasher({ name: 'Socket Washer B', status: 'active' }));
    ({ washer: inactiveWasher } = await createTestWasher({ name: 'Socket Washer Inactive', status: 'inactive' }));

    // 2. Create Global Customer Identity
    customerIdentity = await createTestIdentity('+966500000088');

    // 3. Create Memberships for Washer A and Washer B
    membershipA = await createCustomerMembership(customerIdentity.id, washerA.id);
    membershipB = await createCustomerMembership(customerIdentity.id, washerB.id);

    // 4. Create single operational customer session
    const sessionRes = await SessionService.createOperationalSession(customerIdentity.id, {
      appType: 'customer'
    });
    customerSession = sessionRes.session;
    customerToken = sessionRes.accessToken;

    resolveContext = createSocketContextResolver();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // Helper mock socket to test room joining policy
  function createMockSocket(context) {
    const joinedRooms = new Set();
    return {
      data: { context },
      join: (room) => joinedRooms.add(room),
      rooms: joinedRooms
    };
  }

  // ── SOCKET-1 ──────────────────────────────────────────────────────────────
  it('SOCKET-1: Customer token + Washer A -> resolves Washer A context and joins Washer A customer scope', async () => {
    const context = await resolveContext(customerToken, washerA.id);

    expect(context).toBeDefined();
    expect(context.identityId).toBe(customerIdentity.id);
    expect(context.washerId).toBe(washerA.id);
    expect(context.customerMembershipId).toBe(membershipA.id);
    expect(context.appType).toBe('customer');

    // Test Room Joining Policy
    const mockSocket = createMockSocket(context);
    SocketRoomService.applyJoiningPolicy(mockSocket);

    expect(mockSocket.rooms.has(`session:${customerSession.id}`)).toBe(true);
    expect(mockSocket.rooms.has(`app_identity:${washerA.id}:${customerIdentity.id}`)).toBe(true);
    // Must NOT join Washer B room or staff washer broadcast room
    expect(mockSocket.rooms.has(`app_identity:${washerB.id}:${customerIdentity.id}`)).toBe(false);
    expect(mockSocket.rooms.has(`washer:${washerA.id}`)).toBe(false);
  });

  // ── SOCKET-2 ──────────────────────────────────────────────────────────────
  it('SOCKET-2: Same customer token + Washer B -> establishes Washer B context according to membership rules', async () => {
    const context = await resolveContext(customerToken, washerB.id);

    expect(context).toBeDefined();
    expect(context.identityId).toBe(customerIdentity.id);
    expect(context.washerId).toBe(washerB.id);
    expect(context.customerMembershipId).toBe(membershipB.id);
    expect(context.appType).toBe('customer');

    const mockSocket = createMockSocket(context);
    SocketRoomService.applyJoiningPolicy(mockSocket);

    expect(mockSocket.rooms.has(`session:${customerSession.id}`)).toBe(true);
    expect(mockSocket.rooms.has(`app_identity:${washerB.id}:${customerIdentity.id}`)).toBe(true);
    expect(mockSocket.rooms.has(`app_identity:${washerA.id}:${customerIdentity.id}`)).toBe(false);
  });

  // ── SOCKET-3 ──────────────────────────────────────────────────────────────
  it('SOCKET-3: Unknown washer ID -> socket context resolution rejected', async () => {
    let error;
    try {
      await resolveContext(customerToken, 'unknown_washer_id_999');
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.data?.code).toBe('SOCKET_WASHER_NOT_FOUND');
  });

  // ── SOCKET-4 ──────────────────────────────────────────────────────────────
  it('SOCKET-4: Inactive washer -> socket context resolution rejected', async () => {
    let error;
    try {
      await resolveContext(customerToken, inactiveWasher.id);
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.data?.code).toBe('SOCKET_WASHER_INACTIVE');
  });

  // ── SOCKET-5 ──────────────────────────────────────────────────────────────
  it('SOCKET-5: Customer connected in Washer A cannot receive Washer B tenant events', async () => {
    const contextA = await resolveContext(customerToken, washerA.id);
    const mockSocketA = createMockSocket(contextA);
    SocketRoomService.applyJoiningPolicy(mockSocketA);

    // Target room for Washer B event is app_identity:washerB:identity
    const washerBEventTargetRoom = `app_identity:${washerB.id}:${customerIdentity.id}`;

    // Assert socket A is NOT in washer B room
    expect(mockSocketA.rooms.has(washerBEventTargetRoom)).toBe(false);
  });

  // ── SOCKET-6 ──────────────────────────────────────────────────────────────
  it('SOCKET-6: Room tampering cannot escalate permissions without membership', async () => {
    // Create Washer C with NO membership for customerIdentity
    const { washer: washerC } = await createTestWasher({ name: 'Socket Washer C', status: 'active' });

    const contextC = await resolveContext(customerToken, washerC.id);
    expect(contextC).toBeDefined();
    expect(contextC.hasMembership).toBe(false);
    expect(contextC.customerMembershipId).toBeNull();

    const mockSocket = createMockSocket(contextC);
    SocketRoomService.applyJoiningPolicy(mockSocket);

    // Can only be in session room, strictly forbidden from tenant room
    expect(mockSocket.rooms.has(`session:${customerSession.id}`)).toBe(true);
    expect(mockSocket.rooms.has(`app_identity:${washerC.id}:${customerIdentity.id}`)).toBe(false);
    expect(mockSocket.rooms.has(`washer:${washerC.id}`)).toBe(false);
  });

  // ── SOCKET-7 ──────────────────────────────────────────────────────────────
  it('SOCKET-7: No membership -> session room only -> enroll -> reconnect same token -> membership re-read -> joins tenant room', async () => {
    const { washer: washerD } = await createTestWasher({ name: 'Socket Washer D', status: 'active' });

    // 1. Initial connect without membership: session room ONLY
    const contextInitial = await resolveContext(customerToken, washerD.id);
    expect(contextInitial.hasMembership).toBe(false);
    const mockSocket1 = createMockSocket(contextInitial);
    SocketRoomService.applyJoiningPolicy(mockSocket1);
    expect(mockSocket1.rooms.has(`session:${customerSession.id}`)).toBe(true);
    expect(mockSocket1.rooms.has(`app_identity:${washerD.id}:${customerIdentity.id}`)).toBe(false);

    // 2. Customer enrolls in Washer D (membership created)
    const membershipD = await createCustomerMembership(customerIdentity.id, washerD.id);

    // 3. Reconnect with SAME access token
    const contextReconnected = await resolveContext(customerToken, washerD.id);
    expect(contextReconnected.hasMembership).toBe(true);
    expect(contextReconnected.customerMembershipId).toBe(membershipD.id);

    // 4. Joining policy re-evaluated: now joins tenant room
    const mockSocket2 = createMockSocket(contextReconnected);
    SocketRoomService.applyJoiningPolicy(mockSocket2);
    expect(mockSocket2.rooms.has(`session:${customerSession.id}`)).toBe(true);
    expect(mockSocket2.rooms.has(`app_identity:${washerD.id}:${customerIdentity.id}`)).toBe(true);
  });
});
