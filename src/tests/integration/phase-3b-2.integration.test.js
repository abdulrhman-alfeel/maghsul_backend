import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });
jest.setTimeout(15000);
import { createServer } from 'http';
import { io as Client } from 'socket.io-client';
import { startSocketInfrastructure, stopSocketInfrastructure, getSocketInfrastructureState, getSocketServer } from '../../modules/realtime/socket-infrastructure.js';
import { SOCKET_CONNECTION_STATE, SOCKET_PATH } from '../../modules/realtime/socket.constants.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import { SocketSessionControlService } from '../../modules/realtime/socket-session-control.service.js';
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';
import { jest } from '@jest/globals';

describe('Phase 3B-2: Socket Authentication and Local Room Infrastructure', () => {
  let httpServer;
  let port;
  let clientSocket, clientSocket2, clientSocket3;

  // DB entities
  let identity, identity2, washerA, washerB, branchA, branchB;
  let membership, membership2;
  let sessionOp, sessionProv, sessionCustomer, sessionRevoked, sessionExpired;
  let validOpToken, validProvToken, validCustomerToken, revokedToken, expiredDbToken;

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
        await prisma.userDevice.deleteMany({ where: { identityId: existingIdentity.id } });
        await prisma.staffMembership.deleteMany({ where: { identityId: existingIdentity.id } });
        await prisma.identity.delete({ where: { id: existingIdentity.id } });
      }
    }
    const washersToDelete = await prisma.washer.findMany({ where: { name: { in: ['P3B2 Washer A', 'P3B2 Washer B'] } } });
    const washerIdsToDelete = washersToDelete.map(w => w.id);
    if (washerIdsToDelete.length > 0) {
      const branchesToDelete = await prisma.branch.findMany({ where: { washerId: { in: washerIdsToDelete } } });
      const branchIdsToDelete = branchesToDelete.map(b => b.id);
      if (branchIdsToDelete.length > 0) {
        await prisma.order.deleteMany({ where: { branchId: { in: branchIdsToDelete } } });
        await prisma.branch.deleteMany({ where: { id: { in: branchIdsToDelete } } });
      }
      await prisma.appClient.deleteMany({ where: { washerId: { in: washerIdsToDelete } } });
      await prisma.staffMembership.deleteMany({ where: { washerId: { in: washerIdsToDelete } } });
      await prisma.washer.deleteMany({ where: { id: { in: washerIdsToDelete } } });
    }

    identity = await prisma.identity.create({ data: { phone: testPhone, status: 'active' } });
    identity2 = await prisma.identity.create({ data: { phone: testPhone2, status: 'active' } });
    
    washerA = await prisma.washer.create({ data: { name: 'P3B2 Washer A', status: 'active' } });
    washerB = await prisma.washer.create({ data: { name: 'P3B2 Washer B', status: 'active' } });
    
    branchA = await prisma.branch.create({ data: { name: 'P3B2 Branch A', washerId: washerA.id, status: 'active' } });
    branchB = await prisma.branch.create({ data: { name: 'P3B2 Branch B', washerId: washerA.id, status: 'active' } });
    
    membership = await prisma.staffMembership.create({
      data: { identityId: identity.id, washerId: washerA.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
    });

    const opRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchA.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
    sessionOp = opRes.session;
    validOpToken = opRes.accessToken;
    await prisma.session.update({ where: { id: sessionOp.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'dashboard', installationId: 'dev1', platform: 'web', identityId: identity.id } } } });

    const provRes = await SessionService.createProvisionalSession(identity.id, { washerId: washerA.id, applicationId: 'com.staff', appType: 'dashboard' });
    sessionProv = provRes.session;
    validProvToken = provRes.accessToken;

    sessionCustomer = await prisma.session.create({ data: { identityId: identity.id, sessionType: 'customer', expiresAt: new Date(Date.now() + 86400000) } });
    validCustomerToken = TokenService.signAccessToken({ sessionId: sessionCustomer.id, identityId: identity.id, sessionType: 'customer' }, '1h');

    const revRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchA.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
    sessionRevoked = revRes.session;
    revokedToken = revRes.accessToken;
    await SessionService.revokeSession(sessionRevoked.id);

    const expRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchA.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
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
      await prisma.userDevice.deleteMany({ where: { identityId: idty.id } });
      await prisma.staffMembership.deleteMany({ where: { identityId: idty.id } });
      await prisma.identity.delete({ where: { id: idty.id } });
    }
    const washerIds = [washerA?.id, washerB?.id].filter(Boolean);
    if (washerIds.length > 0) {
      const branchesToDelete = await prisma.branch.findMany({ where: { washerId: { in: washerIds } } });
      const branchIdsToDelete = branchesToDelete.map(b => b.id);
      if (branchIdsToDelete.length > 0) {
        await prisma.order.deleteMany({ where: { branchId: { in: branchIdsToDelete } } });
        await prisma.branch.deleteMany({ where: { id: { in: branchIdsToDelete } } });
      }
      await prisma.appClient.deleteMany({ where: { washerId: { in: washerIds } } });
      await prisma.staffMembership.deleteMany({ where: { washerId: { in: washerIds } } });
      await prisma.washer.deleteMany({ where: { id: { in: washerIds } } });
    }
    redis.disconnect();
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
    await stopSocketInfrastructure();
    if (httpServer) {
      await new Promise(resolve => httpServer.close(resolve));
    }
    jest.restoreAllMocks();
  });

  function waitForConnect(client) {
    return new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onConnectError = (err) => { cleanup(); reject(err); };
      const cleanup = () => { client.off('connect', onConnect); client.off('connect_error', onConnectError); };
      client.once('connect', onConnect);
      client.once('connect_error', onConnectError);
    });
  }

  function waitForConnectError(client) {
    return new Promise((resolve, reject) => {
      const onConnectError = (err) => { cleanup(); resolve(err); };
      const onConnect = () => { cleanup(); reject(new Error('Socket unexpectedly connected')); };
      const cleanup = () => { client.off('connect_error', onConnectError); client.off('connect', onConnect); };
      client.once('connect_error', onConnectError);
      client.once('connect', onConnect);
    });
  }

  function waitForConnect(client) {
    return new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onConnectError = (err) => { cleanup(); reject(err); };
      const cleanup = () => { client.off('connect', onConnect); client.off('connect_error', onConnectError); };
      client.once('connect', onConnect);
      client.once('connect_error', onConnectError);
    });
  }

  function waitForConnectError(client) {
    return new Promise((resolve, reject) => {
      const onConnectError = (err) => { cleanup(); resolve(err); };
      const onConnect = () => { cleanup(); reject(new Error('Socket unexpectedly connected')); };
      const cleanup = () => { client.off('connect_error', onConnectError); client.off('connect', onConnect); };
      client.once('connect_error', onConnectError);
      client.once('connect', onConnect);
    });
  }

  function createClient(auth, options = {}) {
    return Client(`http://127.0.0.1:${port}`, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth,
      reconnection: false,
      autoConnect: false,
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
    it('start() twice safely ignores second call', async () => {
      await startSocketInfrastructure(httpServer);
      await startSocketInfrastructure(httpServer);
      expect(getSocketInfrastructureState()).toBe(SOCKET_CONNECTION_STATE.READY);
    });

    it('stop() twice and while stopped is safe', async () => {
      await stopSocketInfrastructure();
      await stopSocketInfrastructure();
      expect(getSocketInfrastructureState()).toBe(SOCKET_CONNECTION_STATE.STOPPED);
    });

    it('Configuration forces WebSocket and denies polling', async () => {
      await startSocketInfrastructure(httpServer);
      const pollClient = Client(`http://127.0.0.1:${port}`, {
        path: SOCKET_PATH,
        transports: ['polling'],
        auth: { accessToken: validOpToken },
        autoConnect: false
      });
      const errPromise = waitForConnectError(pollClient);
      pollClient.connect();
      const err = await errPromise;
      expect(err.message).toMatch(/websocket|xhr poll error|server error/);
      pollClient.disconnect();
    });
    
    it('Restart after stop works', async () => {
      await startSocketInfrastructure(httpServer);
      await stopSocketInfrastructure();
      
      // Recreate HTTP server since io.close() destroyed it
      httpServer = createServer();
      await new Promise((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => {
          port = httpServer.address().port;
          resolve();
        });
      });

      await startSocketInfrastructure(httpServer);
      const io = getSocketServer();
      expect(io).not.toBeNull();
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
    });
  });

  describe('3. Session Types and DB Expiry', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Session not found', async () => {
      const notFoundToken = TokenService.signAccessToken({ sessionId: 'cuidNotFound123', identityId: identity.id, sessionType: 'operational' }, '1h');
      clientSocket = createClient({ accessToken: notFoundToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
    });

    it('Session revoked in database', async () => {
      clientSocket = createClient({ accessToken: revokedToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
    });

    it('Session expired in database (expiresAt)', async () => {
      clientSocket = createClient({ accessToken: expiredDbToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
    });

    it('Provisional session rejected', async () => {
      clientSocket = createClient({ accessToken: validProvToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
    });

    it('Customer session rejected', async () => {
      clientSocket = createClient({ accessToken: validCustomerToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
    });

    it('Operational session accepted', async () => {
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
    });
  });

  describe('4. Origin Policy', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer, { allowedOrigins: ['https://admin.maghsul.com'] }); });

    it('No Origin + Valid Token -> Accepts (Mobile App Pattern)', async () => {
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
    });

    it('Allowed Origin + Valid Token -> Accepts', async () => {
      clientSocket = createClient({ accessToken: validOpToken }, { extraHeaders: { origin: 'https://admin.maghsul.com' } });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
    });

    it('Disallowed Origin -> Rejects immediately', async () => {
      clientSocket = createClient({ accessToken: validOpToken }, { extraHeaders: { origin: 'https://hacker.com' } });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err).toBeDefined();
    });
  });

  describe('5. Identity, Membership, and Branch Validation', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Inactive Identity rejected', async () => {
      await prisma.identity.update({ where: { id: identity.id }, data: { status: 'suspended' } });
      clientSocket = createClient({ accessToken: validOpToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_IDENTITY_INACTIVE');
      await prisma.identity.update({ where: { id: identity.id }, data: { status: 'active' } });
    });

    it('Inactive Membership rejected', async () => {
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
      clientSocket = createClient({ accessToken: validOpToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_MEMBERSHIP_INVALID');
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { status: 'active' } });
    });

    it('Missing Branch Access rejected', async () => {
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { hasFullWasherAccess: false } });
      clientSocket = createClient({ accessToken: validOpToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { hasFullWasherAccess: true } });
    });
  });

  describe('6. PostgreSQL Fallback (Redis Failure Simulation)', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Succeeds even if Redis throws an error', async () => {
      jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Redis is down'));
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
      expect(redis.get).toHaveBeenCalled();
    });
  });

  describe('7. Immutable Context and Rooms Policy', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Socket.data.context is deeply frozen', async () => {
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
      
      const serverSocket = getSocketServer().sockets.sockets.get(clientSocket.id);
      const ctx = serverSocket.data.context;
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(Object.isFrozen(ctx.permissions)).toBe(true);
      expect(() => { ctx.washerId = 'hacked'; }).toThrow();
      expect(() => { ctx.permissions.push('admin'); }).toThrow();
      
      const rooms = Array.from(serverSocket.rooms);
      expect(rooms).toContain(serverSocket.id);
      expect(rooms).toContain(`session:${sessionOp.id}`);
      expect(rooms).toContain(`identity:${identity.id}`);
      expect(rooms).toContain(`washer:${washerA.id}`);
      expect(rooms).toContain(`branch:${branchA.id}`);
    });
  });

  describe('8. Cross-Washer and Branch Isolation', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Event emitted to Washer A does not reach Washer B', async () => {
      const memb2 = await prisma.staffMembership.create({
        data: { identityId: identity2.id, washerId: washerB.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
      });
      const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerB.id, staffMembershipId: memb2.id , applicationId: 'com.staff', appType: 'dashboard' });
      await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'dashboard', installationId: 'dev_wb', platform: 'web', identityId: identity2.id } } } });
      
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket2 = createClient({ accessToken: res2.accessToken });
      
      const conn1 = waitForConnect(clientSocket);
      const conn2 = waitForConnect(clientSocket2);
      clientSocket.connect();
      clientSocket2.connect();
      await Promise.all([conn1, conn2]);

      await new Promise((resolve, reject) => {
        clientSocket.once('test-event', resolve);
        clientSocket2.once('test-event', () => reject(new Error('Washer B received event meant for Washer A')));
        getSocketServer().to(`washer:${washerA.id}`).emit('test-event');
      });
    });
  });

  describe('9. Session Control Disconnects', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('disconnectSession only disconnects the target session', async () => {
      const memb2 = await prisma.staffMembership.create({
        data: { identityId: identity2.id, washerId: washerA.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
      });
      const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, staffMembershipId: memb2.id , applicationId: 'com.staff', appType: 'dashboard' });
      await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'dashboard', installationId: 'dev_wa', platform: 'web', identityId: identity2.id } } } });
      
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket3 = createClient({ accessToken: res2.accessToken });
      
      const conn1 = waitForConnect(clientSocket);
      const conn3 = waitForConnect(clientSocket3);
      clientSocket.connect();
      clientSocket3.connect();
      await Promise.all([conn1, conn3]);

      await new Promise(async (resolve, reject) => {
        clientSocket.once('disconnect', () => { resolve(); });
        clientSocket3.once('disconnect', () => reject(new Error('Client 3 disconnected unexpectedly')));
        await SocketSessionControlService.disconnectSession(sessionOp.id);
      });
    });

    it('disconnectIdentity disconnects all sessions for identity', async () => {
      const res2 = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
      await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'dashboard', installationId: 'dev_b2', platform: 'web', identityId: identity.id } } } });
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket2 = createClient({ accessToken: res2.accessToken });
      
      const conn1 = waitForConnect(clientSocket);
      const conn2 = waitForConnect(clientSocket2);
      clientSocket.connect();
      clientSocket2.connect();
      await Promise.all([conn1, conn2]);

      await new Promise(async (resolve) => {
        let disconnected = 0;
        clientSocket.once('disconnect', () => { if (++disconnected === 2) resolve(); });
        clientSocket2.once('disconnect', () => { if (++disconnected === 2) resolve(); });
        await SocketSessionControlService.disconnectIdentity(identity.id);
      });
    });
  });

  describe('10. Client Business Logic Blocked', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Client events do not trigger business actions', async () => {
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;

      const spy = jest.spyOn(prisma.staffInvitation, 'create');
      clientSocket.emit('createInvitation', { phone: '123' }, () => {});
      await new Promise(r => setTimeout(r, 100));
      expect(spy).not.toHaveBeenCalled();
    });
  });


  describe('11. Advanced Token Validation', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Missing Access Token', async () => {
      const client = createClient({});
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_AUTH_REQUIRED');
    });

    it('Access Token is not a string', async () => {
      const client = createClient({ accessToken: { token: '123' } });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
    });

    it('Empty Access Token', async () => {
      const client = createClient({ accessToken: '' });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_AUTH_REQUIRED');
    });

    it('Oversized Access Token', async () => {
      const client = createClient({ accessToken: 'a'.repeat(10000) });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
    });

    it('Access Token inside query is ignored', async () => {
      const client = Client(`http://127.0.0.1:${port}`, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        query: { accessToken: validOpToken },
        auth: {},
        reconnection: false,
        autoConnect: false
      });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
      client.disconnect();
    });

    it('Context injection through auth is ignored', async () => {
      const client = createClient({ 
        accessToken: validOpToken, 
        context: { permissions: ['ALL_ACCESS'] } 
      });
      const connectPromise = waitForConnect(client);
      client.connect();
      await connectPromise;
      client.disconnect();
    });

    it('Invalid JWT signature', async () => {
      const jwt = await import('jsonwebtoken');
      const badToken = jwt.default.sign({ sessionId: sessionOp.id, identityId: identity.id, sessionType: 'operational' }, 'wrongsecret');
      const client = createClient({ accessToken: badToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
      expect(err.message).not.toContain('wrongsecret');
    });

    it('Expired JWT', async () => {
      const jwt = await import('jsonwebtoken');
      const badToken = jwt.default.sign({ sessionId: sessionOp.id, identityId: identity.id, sessionType: 'operational' }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '-1h' });
      const client = createClient({ accessToken: badToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_EXPIRED');
    });
  });

  describe('12. Application Validation', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Application not found (no device)', async () => {
      const opNoDeviceRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, staffMembershipId: membership.id });
      const client = createClient({ accessToken: opNoDeviceRes.accessToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_APPLICATION_NOT_FOUND');
    });
    
    it('appType mismatch / Forbidden application type', async () => {
      const custAppRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
      await prisma.session.update({ where: { id: custAppRes.session.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'customer', installationId: 'devX', platform: 'web', identityId: identity.id } } } });
      const client = createClient({ accessToken: custAppRes.accessToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
    });
  });

  describe('13. Server-Side Rooms Verification', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Server-side rooms are correctly assigned', async () => {
      const client = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(client);
      client.connect();
      await connectPromise;

      const io = getSocketServer();
      const serverSocket = Array.from(io.sockets.sockets.values())[0];
      const rooms = Array.from(serverSocket.rooms);
      
      expect(rooms).toContain(`session:${sessionOp.id}`);
      expect(rooms).toContain(`identity:${identity.id}`);
      expect(rooms).toContain('application:com.staff');
      expect(rooms).toContain(`washer:${washerA.id}`);
      expect(rooms).toContain(`branch:${branchA.id}`);
      
      client.disconnect();
    });
  });


  describe('14. Strict Branch Access and Cross-Branch Isolation', () => {
    beforeEach(async () => { await startSocketInfrastructure(httpServer); });

    it('Branch access belongs to another washer / Revoked access', async () => {
      const wrongBranch = await prisma.branch.create({ data: { name: 'Branch Wrong P3B2', washerId: washerB.id, status: 'active' } });
      const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: wrongBranch.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
      await prisma.session.update({ where: { id: weirdSessionRes.session.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'dashboard', installationId: 'dev_w1', platform: 'web', identityId: identity.id } } } });
      const client = createClient({ accessToken: weirdSessionRes.accessToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
    });

    it('Membership belongs to another washer', async () => {
      const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerB.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
      await prisma.session.update({ where: { id: weirdSessionRes.session.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'dashboard', installationId: 'dev_w2', platform: 'web', identityId: identity.id } } } });
      const client = createClient({ accessToken: weirdSessionRes.accessToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_MEMBERSHIP_INVALID');
    });

    it('Cross-Branch Isolation (Branch A vs B vs C)', async () => {
      const branchC = await prisma.branch.create({ data: { name: 'P3B2 Branch C', washerId: washerA.id, status: 'active' } });
      const resB = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
      await prisma.session.update({ where: { id: resB.session.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'dashboard', installationId: 'dev_bB', platform: 'web', identityId: identity2.id } } } });
      const resC = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchC.id, staffMembershipId: membership.id , applicationId: 'com.staff', appType: 'dashboard' });
      await prisma.session.update({ where: { id: resC.session.id }, data: { device: { create: { applicationId: 'com.staff', appType: 'dashboard', installationId: 'dev_bC', platform: 'web', identityId: identity2.id } } } });
      
      const clientA = createClient({ accessToken: validOpToken });
      const clientB = createClient({ accessToken: resB.accessToken });
      const clientC = createClient({ accessToken: resC.accessToken });
      
      const conn1 = waitForConnect(clientA);
      const conn2 = waitForConnect(clientB);
      const conn3 = waitForConnect(clientC);
      clientA.connect();
      clientB.connect();
      clientC.connect();
      await Promise.all([conn1, conn2, conn3]);

      await new Promise((resolve, reject) => {
        clientA.once('test-branch-event', resolve);
        clientB.once('test-branch-event', () => reject(new Error('Branch B received event for Branch A')));
        clientC.once('test-branch-event', () => reject(new Error('Branch C received event for Branch A')));
        getSocketServer().to(`branch:${branchA.id}`).emit('test-branch-event');
      });
      
      clientA.disconnect();
      clientB.disconnect();
      clientC.disconnect();
    });
  });

  describe('15. Lifecycle Expiry and Config Verification', () => {
    it('Server-side configuration is strictly locked down', async () => {
      await startSocketInfrastructure(httpServer);
      const io = getSocketServer();
      // serveClient = false
      expect(io._serveClient).toBe(false);
      // transports = ['websocket']
      expect(io.eio.opts.transports).toEqual(['websocket']);
      // allowUpgrades = false
      expect(io.eio.opts.allowUpgrades).toBe(false);
      // connectionStateRecovery = false
      expect(io.opts.connectionStateRecovery).toBeFalsy();
    });

    it('Stop with active expiry timers and clients', async () => {
      await startSocketInfrastructure(httpServer);
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
      clientSocket.disconnect();
      await stopSocketInfrastructure();
    });
  });

});
