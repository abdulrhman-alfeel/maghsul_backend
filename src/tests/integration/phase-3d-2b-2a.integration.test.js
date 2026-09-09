import prisma from '../../config/db.js';
import redis from '../../config/redis.js';
import { SocketRoomService } from '../../modules/realtime/socket-room.service.js';
import { SocketRoomFactory } from '../../modules/realtime/socket-room.factory.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import { createSocketContextResolver } from '../../modules/realtime/socket-context.resolver.js';
import { setupTestDb, teardownTestDb, createTestWasher } from './test-utils.js';

process.env.ACCESS_TOKEN_SECRET = 'test-secret-key-do-not-use-in-prod';

describe('Phase 3D-2B-2A: Customer Session and Room Architecture', () => {
  let identity, device, session, washer, washer2, membership;
  const resolveContext = createSocketContextResolver();

  beforeAll(async () => {
    await setupTestDb();
    const w1 = await createTestWasher({ name: 'Phase3D Washer 1' });
    washer = w1.washer;

    const w2 = await createTestWasher({ name: 'Phase3D Washer 2' });
    washer2 = w2.washer;

    identity = await prisma.identity.create({
      data: { phone: `+9665${Math.floor(Math.random() * 10000000)}`, status: 'active' }
    });

    device = await prisma.userDevice.create({
      data: {
        identityId: identity.id,
        applicationId: 'com.laundry.customer',
        installationId: `inst-${Math.floor(Math.random() * 10000000)}`,
        platform: 'ios',
        appType: 'customer'
      }
    });

    membership = await prisma.customerMembership.create({
      data: {
        identityId: identity.id,
        washerId: washer.id,
        status: 'active'
      }
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    process.env.ACCESS_TOKEN_SECRET = 'test-secret-key-do-not-use-in-prod';
    if (!identity) return;
    session = await prisma.session.create({
      data: {
        identityId: identity.id,
        userDeviceId: device.id,
        sessionType: 'operational',
        expiresAt: new Date(Date.now() + 86400000)
      }
    });
    await redis.set(`session-state:${session.id}`, 'active', 'EX', 60);
  });

  afterEach(async () => {
    if (session) {
      await prisma.session.deleteMany({ where: { id: session.id } });
      await redis.del(`session-state:${session.id}`);
    }
  });

  describe('Customer Context', () => {
    it('should accept operational customer session and return clean context', async () => {
      const accessToken = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        appType: 'customer'
      }, '15m');
      
      const context = await resolveContext(accessToken, washer.id);
      expect(context.appType).toBe('customer');
      expect(context.identityId).toBe(identity.id);
      expect(context.sessionId).toBe(session.id);
      expect(context.washerId).toBe(washer.id);
      expect(context.hasMembership).toBe(true);
      expect(context.customerMembershipId).toBe(membership.id);
      expect(context.permissions).toBeUndefined();
    });

    it('should reject OTP/provisional session', async () => {
      const provisionalSession = await prisma.session.create({
        data: {
          identityId: identity.id,
          userDeviceId: device.id,
          sessionType: 'provisional',
          expiresAt: new Date(Date.now() + 86400000)
        }
      });
      const accessToken = TokenService.signAccessToken({
        sessionId: provisionalSession.id,
        identityId: identity.id,
        sessionType: 'provisional',
        appType: 'customer'
      }, '15m');
      
      await expect(resolveContext(accessToken, washer.id)).rejects.toThrow('Invalid access token');
      await prisma.session.delete({ where: { id: provisionalSession.id } });
    });

    it('should reject revoked session', async () => {
      await redis.set(`session-state:${session.id}`, 'revoked', 'EX', 60);
      const accessToken = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        appType: 'customer'
      }, '15m');
      
      await expect(resolveContext(accessToken, washer.id)).rejects.toThrow('Session is revoked');
    });

    it('should reject expired token', async () => {
      const accessToken = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        appType: 'customer'
      }, '-15m'); // Expired
      
      await expect(resolveContext(accessToken, washer.id)).rejects.toThrow('Access token expired');
    });
  });

  describe('Trust Boundary and Tenant Scope', () => {
    it('1. Missing washerId is rejected with SOCKET_CONTEXT_INVALID', async () => {
      const token = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        appType: 'customer'
      }, '15m');
      
      await expect(resolveContext(token, null)).rejects.toThrow('Washer ID required for customer socket connection');
    });

    it('2. Unknown washer identifier is rejected', async () => {
      const token = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        appType: 'customer'
      }, '15m');
      
      await expect(resolveContext(token, 'non-existent-washer-id')).rejects.toThrow('Washer not found');
    });

    it('3. Inactive washer is rejected', async () => {
      const inactiveWasher = await prisma.washer.create({
        data: { name: 'Inactive Washer', status: 'inactive' }
      });
      const token = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        appType: 'customer'
      }, '15m');

      await expect(resolveContext(token, inactiveWasher.id)).rejects.toThrow('Washer is inactive');
      await prisma.washer.delete({ where: { id: inactiveWasher.id } });
    });

    it('4. Customer without membership in targeted washer resolves hasMembership: false', async () => {
      const token = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        appType: 'customer'
      }, '15m');
      
      const ctx = await resolveContext(token, washer2.id);
      expect(ctx.washerId).toBe(washer2.id);
      expect(ctx.hasMembership).toBe(false);
      expect(ctx.customerMembershipId).toBeNull();
    });

    it('5. Tampered token signature is rejected', async () => {
      const token = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        appType: 'customer'
      }, '15m');
      const tampered = token.slice(0, -5) + 'abcde';
      
      await expect(resolveContext(tampered, washer.id)).rejects.toThrow();
    });
  });

  describe('Room Policy', () => {
    it('should enforce customer room policy with active membership', () => {
      const mockSocket = {
        data: {
          context: {
            appType: 'customer',
            sessionId: 'session-123',
            identityId: 'ident-123',
            washerId: 'washer-123',
            hasMembership: true
          }
        },
        joinedRooms: [],
        join(room) {
          this.joinedRooms.push(room);
        }
      };

      SocketRoomService.applyJoiningPolicy(mockSocket);
      expect(mockSocket.joinedRooms).toContain('session:session-123');
      expect(mockSocket.joinedRooms).toContain('app_identity:washer-123:ident-123');
      expect(mockSocket.joinedRooms).not.toContain('washer:washer-123');
      expect(mockSocket.joinedRooms).not.toContain('identity:ident-123');
    });

    it('should enforce customer room policy with no membership (session room only)', () => {
      const mockSocket = {
        data: {
          context: {
            appType: 'customer',
            sessionId: 'session-123',
            identityId: 'ident-123',
            washerId: 'washer-123',
            hasMembership: false
          }
        },
        joinedRooms: [],
        join(room) {
          this.joinedRooms.push(room);
        }
      };

      SocketRoomService.applyJoiningPolicy(mockSocket);
      expect(mockSocket.joinedRooms).toContain('session:session-123');
      expect(mockSocket.joinedRooms).not.toContain('app_identity:washer-123:ident-123');
    });

    it('should build app identity room safely and validate ids strictly', () => {
      expect(SocketRoomFactory.buildAppIdentityRoom('wash_1', 'ident1')).toBe('app_identity:wash_1:ident1');
      expect(SocketRoomFactory.buildAppIdentityRoom('cmtt_washer_abc', 'ident1')).toBe('app_identity:cmtt_washer_abc:ident1');
      
      // Delimiter injection tests (colon)
      expect(() => SocketRoomFactory.buildAppIdentityRoom('app:customer', 'ident1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', 'ident:1')).toThrow('invalid characters');
      
      // Whitespace and newlines, unicode space, tab, carriage return, null byte
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', 'ident 1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', 'ident\n1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', 'ident\u200B1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', 'ident\t1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', 'ident\r1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', 'ident\x001')).toThrow('invalid characters');
      
      // Empty values and non-strings
      expect(() => SocketRoomFactory.buildAppIdentityRoom('', 'ident1')).toThrow('non-empty string');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', null)).toThrow('non-empty string');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', 123)).toThrow('non-empty string');
      
      // Excessive length (>64 chars)
      const exactMax = 'a'.repeat(64);
      const aboveMax = 'a'.repeat(65);
      
      expect(SocketRoomFactory.buildAppIdentityRoom('wash_1', exactMax)).toBe(`app_identity:wash_1:${exactMax}`);
      expect(() => SocketRoomFactory.buildAppIdentityRoom('wash_1', aboveMax)).toThrow('too long');
    });
  });

  describe('Session Disconnect', () => {
    it('logoutSession creates socket.session.disconnect outbox event', async () => {
      await SessionService.logoutSession(session.id);
      
      const outbox = await prisma.realtimeOutboxEvent.findFirst({
        where: { aggregateId: session.id }
      });
      
      expect(outbox).not.toBeNull();
      expect(outbox.eventType).toBe('socket.session.disconnect');
      expect(outbox.eventKind).toBe('internal_command');
      
      await prisma.realtimeOutboxEvent.deleteMany({ where: { aggregateId: session.id } });
    });
  });

  describe('Cross-Application Isolation', () => {
    it('should enforce distinct routing between customer and staff applications', () => {
      const customerSocket = {
        data: { context: { appType: 'customer', sessionId: 's1', identityId: 'id1', washerId: 'wash_1', hasMembership: true } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };
      const staffSocket = {
        data: { context: { appType: 'staff', sessionId: 's2', identityId: 'id1', applicationId: 'com.staff' } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };

      SocketRoomService.applyJoiningPolicy(customerSocket);
      SocketRoomService.applyJoiningPolicy(staffSocket);

      expect(customerSocket.joinedRooms).toContain('app_identity:wash_1:id1');
      expect(staffSocket.joinedRooms).not.toContain('app_identity:wash_1:id1');
      expect(staffSocket.joinedRooms).toContain('identity:id1');
      expect(customerSocket.joinedRooms).not.toContain('identity:id1');
    });

    it('should route customer broadcasts to multiple devices simultaneously without affecting staff', async () => {
      // Simulate two Customer devices and one Staff session
      const customerSocketDev1 = {
        data: { context: { appType: 'customer', sessionId: 's-cust1', identityId: 'id-alpha', washerId: 'wash_1', hasMembership: true } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };
      const customerSocketDev2 = {
        data: { context: { appType: 'customer', sessionId: 's-cust2', identityId: 'id-alpha', washerId: 'wash_1', hasMembership: true } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };
      const staffSocket = {
        data: { context: { appType: 'staff', sessionId: 's-staff1', identityId: 'id-alpha', applicationId: 'com.staff' } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };

      SocketRoomService.applyJoiningPolicy(customerSocketDev1);
      SocketRoomService.applyJoiningPolicy(customerSocketDev2);
      SocketRoomService.applyJoiningPolicy(staffSocket);

      const targetCustomerRoom = SocketRoomFactory.buildAppIdentityRoom('wash_1', 'id-alpha');
      
      expect(customerSocketDev1.joinedRooms).toContain(targetCustomerRoom);
      expect(customerSocketDev2.joinedRooms).toContain(targetCustomerRoom);
      expect(staffSocket.joinedRooms).not.toContain(targetCustomerRoom);
      
      const targetStaffRoom = SocketRoomFactory.buildIdentityRoom('id-alpha');
      expect(staffSocket.joinedRooms).toContain(targetStaffRoom);
      expect(customerSocketDev1.joinedRooms).not.toContain(targetStaffRoom);
      expect(customerSocketDev2.joinedRooms).not.toContain(targetStaffRoom);
    });
  });
});
