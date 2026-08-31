
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';
import { SocketRoomService } from '../../modules/realtime/socket-room.service.js';
import { SocketRoomFactory } from '../../modules/realtime/socket-room.factory.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import { createSocketContextResolver } from '../../modules/realtime/socket-context.resolver.js';

process.env.ACCESS_TOKEN_SECRET = 'test-secret-key-do-not-use-in-prod';

describe('Phase 3D-2B-2A: Customer Session and Room Architecture', () => {
  let identity, device, session;
  const resolveContext = createSocketContextResolver();

  beforeAll(async () => {
    identity = await prisma.identity.create({
      data: { phone: `+9665${Math.floor(Math.random() * 10000000)}`, status: 'active' }
    });
    device = await prisma.userDevice.create({
      data: {
        identityId: identity.id,
        applicationId: 'com.laundry.customer', appType: 'customer',
        installationId: `inst-${Math.floor(Math.random() * 10000000)}`,
        platform: 'ios',
        appType: 'customer'
      }
    });
  });

  afterAll(async () => {
    if (identity) {
      await prisma.session.deleteMany({ where: { identityId: identity.id } });
      await prisma.userDevice.deleteMany({ where: { identityId: identity.id } });
      await prisma.identity.delete({ where: { id: identity.id } });
    }
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
        applicationId: 'com.laundry.customer', appType: 'customer',
        appType: 'customer'
      }, '15m');
      
      const context = await resolveContext(accessToken);
      expect(context.appType).toBe('customer');
      expect(context.identityId).toBe(identity.id);
      expect(context.sessionId).toBe(session.id);
      expect(context.applicationId).toBe('com.laundry.customer');
      expect(context.washerId).toBeUndefined();
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
        sessionType: 'provisional'
      }, '15m');
      
      await expect(resolveContext(accessToken)).rejects.toThrow('Invalid access token');
      await prisma.session.delete({ where: { id: provisionalSession.id } });
    });

    it('should reject revoked session', async () => {
      await redis.set(`session-state:${session.id}`, 'revoked', 'EX', 60);
      const accessToken = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        applicationId: 'com.laundry.customer', appType: 'customer',
        appType: 'customer'
      }, '15m');
      
      await expect(resolveContext(accessToken)).rejects.toThrow('Session is revoked');
    });

    it('should reject expired token', async () => {
      const accessToken = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: identity.id,
        sessionType: 'operational',
        applicationId: 'com.laundry.customer', appType: 'customer',
        appType: 'customer'
      }, '-15m'); // Expired
      
      await expect(resolveContext(accessToken)).rejects.toThrow('Access token expired');
    });
  });

  describe('Trust Boundary and Application Scope', () => {
    it('1. Tampering UserDevice.applicationId breaks the session due to mismatch', async () => {
      const dev = await prisma.userDevice.create({ data: { identityId: identity.id, applicationId: 'com.laundry.customer', appType: 'customer', platform: 'ios', installationId: 'test-1' } });
      const sess = await prisma.session.create({ data: { identityId: identity.id, userDeviceId: dev.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
      
      const token = TokenService.signAccessToken({
        sessionId: sess.id, identityId: identity.id, sessionType: 'operational',
        applicationId: 'com.laundry.customer', appType: 'customer'
      }, '15m');
      
      await prisma.userDevice.update({ where: { id: dev.id }, data: { applicationId: 'com.hacker.app' } });
      
      await expect(resolveContext(token)).rejects.toThrow('Token application scope does not match session canonical scope');
    });


    it('2. Unknown bundle identifier is rejected', async () => {
      const dev = await prisma.userDevice.create({ data: { identityId: identity.id, applicationId: 'com.hacker.app', appType: 'customer', platform: 'ios', installationId: 'test-2' } });
      const sess = await prisma.session.create({ data: { identityId: identity.id, userDeviceId: dev.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
      const token = TokenService.signAccessToken({ sessionId: sess.id, identityId: identity.id, sessionType: 'operational', applicationId: 'com.hacker.app', appType: 'customer' }, '15m');
      await expect(resolveContext(token)).rejects.toThrow('Unknown bundle identifier');
    });

    it('3. Disabled application identifier is rejected', async () => {
      const dev = await prisma.userDevice.create({ data: { identityId: identity.id, applicationId: 'com.disabled', appType: 'customer', platform: 'ios', installationId: 'test-3' } });
      const sess = await prisma.session.create({ data: { identityId: identity.id, userDeviceId: dev.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
      const token = TokenService.signAccessToken({ sessionId: sess.id, identityId: identity.id, sessionType: 'operational', applicationId: 'com.disabled', appType: 'customer' }, '15m');
      await expect(resolveContext(token)).rejects.toThrow('Disabled application identifier');
    });

    it('4. Customer bundle with staff appType is rejected', async () => {
      const dev = await prisma.userDevice.create({ data: { identityId: identity.id, applicationId: 'com.laundry.customer', appType: 'dashboard', platform: 'ios', installationId: 'test-4' } });
      const sess = await prisma.session.create({ data: { identityId: identity.id, userDeviceId: dev.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
      const token = TokenService.signAccessToken({ sessionId: sess.id, identityId: identity.id, sessionType: 'operational', applicationId: 'com.laundry.customer', appType: 'dashboard' }, '15m');
      await expect(resolveContext(token)).rejects.toThrow('Session application scope mismatch');
    });


    it('5. Staff bundle with customer appType is rejected', async () => {
      const dev = await prisma.userDevice.create({ data: { identityId: identity.id, applicationId: 'com.staff', appType: 'customer', platform: 'ios', installationId: 'test-5' } });
      const sess = await prisma.session.create({ data: { identityId: identity.id, userDeviceId: dev.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
      const token = TokenService.signAccessToken({ sessionId: sess.id, identityId: identity.id, sessionType: 'operational', applicationId: 'com.staff', appType: 'customer' }, '15m');
      await expect(resolveContext(token)).rejects.toThrow('Session application scope mismatch');
    });


    it('6. Socket Context uses the canonical session application scope', async () => {
      const dev = await prisma.userDevice.create({ data: { identityId: identity.id, applicationId: 'com.tenant.customer', appType: 'customer', platform: 'ios', installationId: 'test-6' } });
      const sess = await prisma.session.create({ data: { identityId: identity.id, userDeviceId: dev.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
      const token = TokenService.signAccessToken({ sessionId: sess.id, identityId: identity.id, sessionType: 'operational', applicationId: 'com.tenant.customer', appType: 'customer' }, '15m');
      const ctx = await resolveContext(token);
      expect(ctx.applicationId).toBe('com.tenant.customer');
      expect(ctx.appType).toBe('customer');
    });
  });

  describe('Room Policy', () => {
    it('should enforce customer room policy', () => {
      const mockSocket = {
        data: {
          context: {
            appType: 'customer',
            sessionId: 'session-123',
            identityId: 'ident-123',
            applicationId: 'com.laundry.customer', appType: 'customer',
            washerId: 'washer-123'
          }
        },
        joinedRooms: [],
        join(room) {
          this.joinedRooms.push(room);
        }
      };

      SocketRoomService.applyJoiningPolicy(mockSocket);
      expect(mockSocket.joinedRooms).toContain('session:session-123');
      expect(mockSocket.joinedRooms).toContain('app_identity:com.laundry.customer:ident-123');
      expect(mockSocket.joinedRooms).not.toContain('washer:washer-123');
      expect(mockSocket.joinedRooms).not.toContain('identity:ident-123');
    });

    it('should build app identity room safely and validate ids strictly', () => {
      // Allow Bundle IDs with dots
      expect(SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident1')).toBe('app_identity:com.laundry.customer:ident1');
      expect(SocketRoomFactory.buildAppIdentityRoom('com.tenant.customer', 'ident1')).toBe('app_identity:com.tenant.customer:ident1');
      expect(SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident1')).toBe('app_identity:com.laundry.customer:ident1');
      
      // Delimiter injection tests (colon)
      expect(() => SocketRoomFactory.buildAppIdentityRoom('app:customer', 'ident1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident:1')).toThrow('invalid characters');
      
      // Whitespace and newlines, unicode space, tab, carriage return, null byte
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident 1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident\n1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident\u200B1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident\t1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident\r1')).toThrow('invalid characters');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'ident\x001')).toThrow('invalid characters');
      
      // Empty values and non-strings
      expect(() => SocketRoomFactory.buildAppIdentityRoom('', 'ident1')).toThrow('non-empty string');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', null)).toThrow('non-empty string');
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 123)).toThrow('non-empty string');
      
      // Excessive length (>64 chars)
      const exactMax = 'a'.repeat(64);
      const aboveMax = 'a'.repeat(65);
      
      // Identity maximum length
      expect(SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', exactMax)).toBe(`app_identity:com.laundry.customer:${exactMax}`);
      expect(() => SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', aboveMax)).toThrow('too long');
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
        data: { context: { appType: 'customer', sessionId: 's1', identityId: 'id1', applicationId: 'com.laundry.customer' } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };
      const staffSocket = {
        data: { context: { appType: 'staff', sessionId: 's2', identityId: 'id1', applicationId: 'com.staff' } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };

      SocketRoomService.applyJoiningPolicy(customerSocket);
      SocketRoomService.applyJoiningPolicy(staffSocket);

      expect(customerSocket.joinedRooms).toContain('app_identity:com.laundry.customer:id1');
      expect(staffSocket.joinedRooms).not.toContain('app_identity:com.laundry.customer:id1');
      expect(staffSocket.joinedRooms).toContain('identity:id1');
      expect(customerSocket.joinedRooms).not.toContain('identity:id1');
    });

    it('should route customer broadcasts to multiple devices simultaneously without affecting staff', async () => {
      // Simulate two Customer devices and one Staff session
      const customerSocketDev1 = {
        data: { context: { appType: 'customer', sessionId: 's-cust1', identityId: 'id-alpha', applicationId: 'com.laundry.customer' } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };
      const customerSocketDev2 = {
        data: { context: { appType: 'customer', sessionId: 's-cust2', identityId: 'id-alpha', applicationId: 'com.laundry.customer' } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };
      const staffSocket = {
        data: { context: { appType: 'staff', sessionId: 's-staff1', identityId: 'id-alpha', applicationId: 'com.staff' } },
        joinedRooms: [], join(r) { this.joinedRooms.push(r); }
      };

      SocketRoomService.applyJoiningPolicy(customerSocketDev1);
      SocketRoomService.applyJoiningPolicy(customerSocketDev2);
      SocketRoomService.applyJoiningPolicy(staffSocket);

      // Customer broadcasts logic goes to app_identity:com.laundry.customer:id-alpha
      const targetCustomerRoom = SocketRoomFactory.buildAppIdentityRoom('com.laundry.customer', 'id-alpha');
      
      expect(customerSocketDev1.joinedRooms).toContain(targetCustomerRoom);
      expect(customerSocketDev2.joinedRooms).toContain(targetCustomerRoom);
      expect(staffSocket.joinedRooms).not.toContain(targetCustomerRoom);
      
      // Staff broadcasts logic goes to identity:id-alpha
      const targetStaffRoom = SocketRoomFactory.buildIdentityRoom('id-alpha');
      expect(staffSocket.joinedRooms).toContain(targetStaffRoom);
      expect(customerSocketDev1.joinedRooms).not.toContain(targetStaffRoom);
      expect(customerSocketDev2.joinedRooms).not.toContain(targetStaffRoom);
    });
  });
});
