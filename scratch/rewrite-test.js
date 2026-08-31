import fs from 'fs';
import path from 'path';

const content = `import { createServer } from 'http';
import { io as Client } from 'socket.io-client';
import { startSocketInfrastructure, stopSocketInfrastructure, getSocketInfrastructureState, getSocketServer } from '../../modules/realtime/socket-infrastructure.js';
import { SOCKET_CONNECTION_STATE, SOCKET_PATH } from '../../modules/realtime/socket.constants.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import { SocketSessionControlService } from '../../modules/realtime/socket-session-control.service.js';
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';

describe('Phase 3B-2: Socket Authentication and Local Room Infrastructure', () => {
  let httpServer;
  let port;
  let clientSocket, clientSocket2, clientSocket3;

  // DB entities
  let identity, identity2, washerA, washerB, branchA, branchB, app;
  let membership, membership2;
  let sessionOp, sessionProv, sessionContext, sessionRevoked, sessionExpired;
  let validOpToken, validProvToken, validContextToken, revokedToken, expiredDbToken;

  beforeAll(async () => {
    process.env.ACCESS_TOKEN_SECRET = 'testsecret123';
    process.env.ACCESS_TOKEN_ISSUER = 'laundry-api';
    process.env.ACCESS_TOKEN_AUDIENCE = 'laundry-app';

    const testPhone = '+966599999991';
    const testPhone2 = '+966599999992';
    
    // Cleanup first
    const phones = [testPhone, testPhone2];
    for (const phone of phones) {
      const existingIdentity = await prisma.identity.findUnique({ where: { phone } });
      if (existingIdentity) {
        await prisma.refreshToken.deleteMany({ where: { session: { identityId: existingIdentity.id } } });
        await prisma.session.deleteMany({ where: { identityId: existingIdentity.id } });
        await prisma.staffMembership.deleteMany({ where: { identityId: existingIdentity.id } });
        await prisma.identity.delete({ where: { id: existingIdentity.id } });
      }
    }
    await prisma.branch.deleteMany({ where: { name: { in: ['Branch A', 'Branch B'] } } });
    await prisma.washer.deleteMany({ where: { name: { in: ['Washer A', 'Washer B'] } } });
    await prisma.application.deleteMany({ where: { name: 'Socket App' } });

    app = await prisma.application.create({ data: { name: 'Socket App', type: 'dashboard', status: 'active', platform: 'web' } });
    identity = await prisma.identity.create({ data: { phone: testPhone, status: 'active' } });
    identity2 = await prisma.identity.create({ data: { phone: testPhone2, status: 'active' } });
    
    washerA = await prisma.washer.create({ data: { name: 'Washer A', status: 'active' } });
    washerB = await prisma.washer.create({ data: { name: 'Washer B', status: 'active' } });
    
    branchA = await prisma.branch.create({ data: { name: 'Branch A', washerId: washerA.id, status: 'active' } });
    branchB = await prisma.branch.create({ data: { name: 'Branch B', washerId: washerA.id, status: 'active' } });
    
    membership = await prisma.staffMembership.create({
      data: { identityId: identity.id, washerId: washerA.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
    });

    const opRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchA.id, staffMembershipId: membership.id });
    sessionOp = opRes.session;
    validOpToken = opRes.accessToken;
    await prisma.session.update({ where: { id: sessionOp.id }, data: { device: { create: { applicationId: app.id, appType: 'dashboard', deviceId: 'dev1' } } } });

    const provRes = await SessionService.createProvisionalSession(identity.id, { washerId: washerA.id });
    sessionProv = provRes.session;
    validProvToken = provRes.accessToken;

    const ctxRes = await SessionService.createContextSelectionSession(identity.id);
    sessionContext = ctxRes.session;
    validContextToken = ctxRes.accessToken;

    const revRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchA.id, staffMembershipId: membership.id });
    sessionRevoked = revRes.session;
    revokedToken = revRes.accessToken;
    await SessionService.revokeSession(sessionRevoked.id);

    const expRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchA.id, staffMembershipId: membership.id });
    sessionExpired = expRes.session;
    expiredDbToken = expRes.accessToken;
    await prisma.session.update({ where: { id: sessionExpired.id }, data: { expiresAt: new Date(Date.now() - 10000) } });
  });

  afterAll(async () => {
    // Delete data safely
    const identities = await prisma.identity.findMany({ where: { phone: { in: ['+966599999991', '+966599999992'] } } });
    for (const idty of identities) {
      await prisma.refreshToken.deleteMany({ where: { session: { identityId: idty.id } } });
      await prisma.session.deleteMany({ where: { identityId: idty.id } });
      await prisma.staffMembership.deleteMany({ where: { identityId: idty.id } });
      await prisma.identity.delete({ where: { id: idty.id } });
    }
    await prisma.branch.deleteMany({ where: { washerId: { in: [washerA?.id, washerB?.id] } } });
    await prisma.washer.deleteMany({ where: { id: { in: [washerA?.id, washerB?.id] } } });
    await prisma.application.deleteMany({ where: { id: app?.id } });
    await redis.quit();
  });

  beforeEach(async () => {
    httpServer = createServer();
    await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (clientSocket && clientSocket.connected) clientSocket.disconnect();
    if (clientSocket2 && clientSocket2.connected) clientSocket2.disconnect();
    if (clientSocket3 && clientSocket3.connected) clientSocket3.disconnect();
    stopSocketInfrastructure();
    if (httpServer) {
      await new Promise(resolve => httpServer.close(resolve));
    }
    jest.restoreAllMocks();
  });

  function createClient(auth, options = {}) {
    return Client(\`http://127.0.0.1:\${port}\`, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth,
      reconnection: false,
      ...options
    });
  }

  describe('1. No Side Effects on Import', () => {
    it('Importing socket modules does not create servers or connect to redis automatically', () => {
      // Demonstrated by getSocketInfrastructureState() being STOPPED before start
      expect(getSocketInfrastructureState()).toBe(SOCKET_CONNECTION_STATE.STOPPED);
    });
  });

  describe('2. Lifecycle and Configuration Settings', () => {
    it('start() twice safely ignores second call', () => {
      startSocketInfrastructure(httpServer);
      startSocketInfrastructure(httpServer);
      expect(getSocketInfrastructureState()).toBe(SOCKET_CONNECTION_STATE.READY);
    });

    it('stop() twice and while stopped is safe', () => {
      stopSocketInfrastructure();
      stopSocketInfrastructure();
      expect(getSocketInfrastructureState()).toBe(SOCKET_CONNECTION_STATE.STOPPED);
    });

    it('Configuration forces WebSocket and denies polling', (done) => {
      startSocketInfrastructure(httpServer);
      const pollClient = Client(\`http://127.0.0.1:\${port}\`, {
        path: SOCKET_PATH,
        transports: ['polling'],
        auth: { accessToken: validOpToken },
        reconnection: false
      });
      pollClient.on('connect_error', (err) => {
        expect(err.message).toMatch(/websocket|xhr poll error/);
        pollClient.disconnect();
        done();
      });
    });
    
    it('Restart after stop works', (done) => {
      startSocketInfrastructure(httpServer);
      stopSocketInfrastructure();
      startSocketInfrastructure(httpServer);
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => done());
    });
  });

  describe('3. Session Types and DB Expiry', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Session not found', (done) => {
      const notFoundToken = TokenService.signAccessToken({ sessionId: 'cuidNotFound123', identityId: identity.id, sessionType: 'operational' }, '1h');
      clientSocket = createClient({ accessToken: notFoundToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_SESSION_NOT_FOUND');
        done();
      });
    });

    it('Session revoked in database', (done) => {
      clientSocket = createClient({ accessToken: revokedToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
        done();
      });
    });

    it('Session expired in database (expiresAt)', (done) => {
      clientSocket = createClient({ accessToken: expiredDbToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
        done();
      });
    });

    it('Provisional session rejected', (done) => {
      clientSocket = createClient({ accessToken: validProvToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_TOKEN_INVALID'); // verifyAccessToken rejects it early
        done();
      });
    });

    it('Context-selection session rejected', (done) => {
      clientSocket = createClient({ accessToken: validContextToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
        done();
      });
    });

    it('Operational session accepted', (done) => {
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => done());
    });
  });

  describe('4. Origin Policy', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer, { allowedOrigins: ['https://admin.maghsul.com'] }); });

    it('No Origin + Valid Token -> Accepts (Mobile App Pattern)', (done) => {
      clientSocket = createClient({ accessToken: validOpToken }); // Default has no Origin header in Node.js
      clientSocket.on('connect', () => done());
    });

    it('Allowed Origin + Valid Token -> Accepts', (done) => {
      clientSocket = createClient({ accessToken: validOpToken }, { extraHeaders: { origin: 'https://admin.maghsul.com' } });
      clientSocket.on('connect', () => done());
    });

    it('Disallowed Origin -> Rejects immediately', (done) => {
      clientSocket = createClient({ accessToken: validOpToken }, { extraHeaders: { origin: 'https://hacker.com' } });
      clientSocket.on('connect_error', (err) => {
        expect(err).toBeDefined(); // allowRequest(false) causes a websocket error
        done();
      });
    });
  });

  describe('5. Identity, Membership, and Branch Validation', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Inactive Identity rejected', async () => {
      await prisma.identity.update({ where: { id: identity.id }, data: { status: 'suspended' } });
      clientSocket = createClient({ accessToken: validOpToken });
      await new Promise(r => clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_IDENTITY_INACTIVE');
        r();
      }));
      await prisma.identity.update({ where: { id: identity.id }, data: { status: 'active' } });
    });

    it('Inactive Membership rejected', async () => {
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
      clientSocket = createClient({ accessToken: validOpToken });
      await new Promise(r => clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_MEMBERSHIP_INVALID');
        r();
      }));
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { status: 'active' } });
    });

    it('Missing Branch Access rejected', async () => {
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { hasFullWasherAccess: false } });
      clientSocket = createClient({ accessToken: validOpToken });
      await new Promise(r => clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
        r();
      }));
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { hasFullWasherAccess: true } });
    });
  });

  describe('6. PostgreSQL Fallback (Redis Failure Simulation)', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Succeeds even if Redis throws an error', (done) => {
      jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Redis is down'));
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => {
        expect(redis.get).toHaveBeenCalled(); // Proves fallback happened!
        done();
      });
    });
  });

  describe('7. Immutable Context and Rooms Policy', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Socket.data.context is deeply frozen', (done) => {
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => {
        const serverSocket = getSocketServer().sockets.sockets.get(clientSocket.id);
        const ctx = serverSocket.data.context;
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.permissions)).toBe(true);
        expect(() => { ctx.washerId = 'hacked'; }).toThrow();
        expect(() => { ctx.permissions.push('admin'); }).toThrow();
        
        // Check actual Server Rooms
        const rooms = Array.from(serverSocket.rooms);
        expect(rooms).toContain(serverSocket.id); // default room
        expect(rooms).toContain(\`session:\${sessionOp.id}\`);
        expect(rooms).toContain(\`identity:\${identity.id}\`);
        expect(rooms).toContain(\`washer:\${washerA.id}\`);
        expect(rooms).toContain(\`branch:\${branchA.id}\`);
        done();
      });
    });
  });

  describe('8. Cross-Washer and Branch Isolation', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Event emitted to Washer A does not reach Washer B', (done) => {
      // Setup Washer B session for identity2
      (async () => {
        const memb2 = await prisma.staffMembership.create({
          data: { identityId: identity2.id, washerId: washerB.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
        });
        const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerB.id, staffMembershipId: memb2.id });
        
        clientSocket = createClient({ accessToken: validOpToken }); // Washer A
        clientSocket2 = createClient({ accessToken: res2.accessToken }); // Washer B

        let connected = 0;
        const startTest = () => {
          if (++connected < 2) return;
          clientSocket.on('test-event', () => done()); // Only Washer A should receive
          clientSocket2.on('test-event', () => done.fail('Washer B received Washer A event'));

          getSocketServer().to(\`washer:\${washerA.id}\`).emit('test-event');
        };

        clientSocket.on('connect', startTest);
        clientSocket2.on('connect', startTest);
      })();
    });
  });

  describe('9. Session Control Disconnects', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('disconnectSession only disconnects the target session', (done) => {
      (async () => {
        // identity2 session
        const memb2 = await prisma.staffMembership.create({
          data: { identityId: identity2.id, washerId: washerA.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
        });
        const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, staffMembershipId: memb2.id });
        
        clientSocket = createClient({ accessToken: validOpToken }); // Target
        clientSocket2 = createClient({ accessToken: validOpToken }); // Same Target Session
        clientSocket3 = createClient({ accessToken: res2.accessToken }); // Different Identity

        let connected = 0;
        const startTest = async () => {
          if (++connected < 3) return;
          let disconnected = 0;
          clientSocket.on('disconnect', () => { if (++disconnected === 2) done(); });
          clientSocket2.on('disconnect', () => { if (++disconnected === 2) done(); });
          clientSocket3.on('disconnect', () => done.fail('Wrong session disconnected!'));

          await SocketSessionControlService.disconnectSession(sessionOp.id);
        };
        clientSocket.on('connect', startTest);
        clientSocket2.on('connect', startTest);
        clientSocket3.on('connect', startTest);
      })();
    });

    it('disconnectIdentity disconnects all sessions for identity', (done) => {
      (async () => {
        const res2 = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id });
        clientSocket = createClient({ accessToken: validOpToken });
        clientSocket2 = createClient({ accessToken: res2.accessToken });

        let connected = 0;
        const startTest = async () => {
          if (++connected < 2) return;
          let disconnected = 0;
          clientSocket.on('disconnect', () => { if (++disconnected === 2) done(); });
          clientSocket2.on('disconnect', () => { if (++disconnected === 2) done(); });
          await SocketSessionControlService.disconnectIdentity(identity.id);
        };
        clientSocket.on('connect', startTest);
        clientSocket2.on('connect', startTest);
      })();
    });
  });

  describe('10. Client Business Logic Blocked', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Client events do not trigger business actions', (done) => {
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => {
        const spy = jest.spyOn(prisma.staffInvitation, 'create');
        clientSocket.emit('createInvitation', { phone: '123' }, () => {
          expect(spy).not.toHaveBeenCalled();
          done();
        });
      });
    });
  });
});
