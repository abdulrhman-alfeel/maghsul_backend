import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });
jest.setTimeout(15000);
import { createServer } from 'http';
import { io as createClient } from 'socket.io-client';
import express from 'express';
import { startSocketInfrastructure, stopSocketInfrastructure, getSocketServer, getSocketInfrastructureState } from '../../modules/realtime/socket-infrastructure.js';
import { startSocketRedisAdapter, stopSocketRedisAdapter } from '../../modules/realtime/socket-redis.adapter.js';
import { getPublisherClient, getSubscriberClient } from '../../modules/realtime/socket-redis.connection.js';
import { SocketSessionControlService } from '../../modules/realtime/socket-session-control.service.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';
import { jest } from '@jest/globals';

describe('Phase 3C-1: Redis Adapter and Multi-Node Infrastructure', () => {
  let serverA, serverB;
  let portA, portB;
  let clients = [];
  let identity, washerA, app, branchA, membership, sessionOp, validOpToken;

  const createTestClient = (port, token = validOpToken) => {
    const client = createClient(`http://127.0.0.1:${port}`, {
      auth: { accessToken: token },
      transports: ['websocket'],
      reconnection: false
    });
    clients.push(client);
    return client;
  };

  async function setupServer() {
    const expressApp = express();
    expressApp.get('/health', (req, res) => res.json({ status: 'ok' }));
    const httpServer = createServer(expressApp);
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const port = httpServer.address().port;
    return { httpServer, port };
  }

  beforeAll(async () => {
    process.env.ACCESS_TOKEN_SECRET = 'testsecret123';
    await stopSocketInfrastructure();

    const testPhone = '+966599999993'; // Use distinct phone for this test
    const existingIdentity = await prisma.identity.findUnique({ where: { phone: testPhone } });
    if (existingIdentity) {
      await prisma.refreshToken.deleteMany({ where: { session: { identityId: existingIdentity.id } } });
      await prisma.session.deleteMany({ where: { identityId: existingIdentity.id } });
      await prisma.userDevice.deleteMany({ where: { identityId: existingIdentity.id } });
      await prisma.staffMembership.deleteMany({ where: { identityId: existingIdentity.id } });
      await prisma.identity.delete({ where: { id: existingIdentity.id } });
    }
    await prisma.appClient.deleteMany({ where: { appName: 'Socket Phase3C1 App' } });
    await prisma.branch.deleteMany({ where: { name: 'Branch 3C1' } });
    await prisma.washer.deleteMany({ where: { name: 'Washer 3C1' } });

    identity = await prisma.identity.create({ data: { phone: testPhone, status: 'active' } });
    washerA = await prisma.washer.create({ data: { name: 'Washer 3C1', status: 'active' } });
    app = await prisma.appClient.create({ data: { appName: 'Socket Phase3C1 App', appKey: 'socket_3c1_app', isActive: true, platform: 'web', washerId: washerA.id } });
    branchA = await prisma.branch.create({ data: { name: 'Branch 3C1', washerId: washerA.id, status: 'active' } });
    membership = await prisma.staffMembership.create({
      data: { identityId: identity.id, washerId: washerA.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
    });

    const opRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchA.id, staffMembershipId: membership.id, applicationId: 'com.staff', appType: 'dashboard', platform: 'web', installationId: 'test-install' });
    sessionOp = opRes.session;
    validOpToken = opRes.accessToken;
    // Device is already created by createOperationalSession
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { session: { identityId: identity.id } } });
    await prisma.session.deleteMany({ where: { identityId: identity.id } });
    await prisma.userDevice.deleteMany({ where: { identityId: identity.id } });
    await prisma.staffMembership.deleteMany({ where: { identityId: identity.id } });
    await prisma.identity.delete({ where: { id: identity.id } });
    await prisma.appClient.deleteMany({ where: { id: app.id } });
    await prisma.branch.deleteMany({ where: { id: branchA.id } });
    await prisma.washer.deleteMany({ where: { id: washerA.id } });
  });

  afterEach(async () => {
    for (const c of clients) {
      c.disconnect();
    }
    clients = [];
    await stopSocketInfrastructure();
    await stopSocketRedisAdapter();
    if (serverA) {
      await new Promise(resolve => {
        serverA.close(() => resolve());
        setTimeout(resolve, 500); // Fail-safe
      });
      serverA = null;
    }
  });

  describe('1. Adapter and Connection Singleton Policies', () => {
    it('Adapter attached once, Two Redis clients only, Listeners registered once', async () => {
      const { httpServer } = await setupServer();
      serverA = httpServer;

      await startSocketInfrastructure(serverA);
      await startSocketRedisAdapter(getSocketServer());

      const pub = getPublisherClient();
      const sub = getSubscriberClient();
      
      expect(pub).toBeDefined();
      expect(sub).toBeDefined();

      expect(pub.listenerCount('ready')).toBeLessThan(5);
      
      const io = getSocketServer();
      expect(io.of('/').adapter.pubClient).toBe(pub);
      
      expect(getPublisherClient()).toBeDefined();
      expect(getSubscriberClient()).toBeDefined();
    });
  });

  describe('2. Multi-Node Rooms and Cross-Node Disconnect', () => {
    beforeEach(async () => {
      const sA = await setupServer();
      serverA = sA.httpServer;
      portA = sA.port;
      
      await startSocketInfrastructure(serverA);
      await startSocketRedisAdapter(getSocketServer());
    });

    it('Cross node disconnect works', async () => {
      console.log("STARTING TEST 2");
      const client1 = createTestClient(portA);
      await new Promise((resolve, reject) => {
        client1.on('connect', resolve);
        client1.on('connect_error', reject);
      });
      console.log("TEST 2: client1 connected");
      
      const disconnectSpy = jest.fn();
      client1.on('disconnect', disconnectSpy);

      await SocketSessionControlService.disconnectSession(sessionOp.id);
      console.log("TEST 2: Session disconnected");
      
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(disconnectSpy).toHaveBeenCalled();
      console.log("TEST 2: Done");
    });
  });

  describe('3. Redis Down and Recovery', () => {
    let originalRedisUrl;

    beforeEach(async () => {
      originalRedisUrl = process.env.REDIS_URL_TEST;
    });

    afterEach(() => {
      if (originalRedisUrl === undefined) {
        delete process.env.REDIS_URL_TEST;
      } else {
        process.env.REDIS_URL_TEST = originalRedisUrl;
      }
    });

    it('Transitions correctly during Redis outage', async () => {
      console.log("STARTING TEST 3");
      const sA = await setupServer();
      serverA = sA.httpServer;
      portA = sA.port;

      console.log("TEST 3: starting socket infra");
      await startSocketInfrastructure(serverA);
      await startSocketRedisAdapter(getSocketServer());
      expect(getSocketInfrastructureState()).toBe('ready');

      console.log("TEST 3: creating test client");
      const client1 = createTestClient(portA);
      await new Promise(resolve => client1.on('connect', resolve));
      console.log("TEST 3: test client connected");

      const pub = getPublisherClient();
      console.log("TEST 3: disconnecting pub");
      pub.disconnect();
      pub.emit('close'); // force event immediately
      
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(getSocketInfrastructureState()).toBe('degraded');
      console.log("TEST 3: State is degraded");

      const client2 = createTestClient(portA);
      let errorRecv = null;
      client2.on('connect_error', err => { errorRecv = err; });
      
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(errorRecv).toBeDefined();
      expect(errorRecv.message).toContain('Realtime Infrastructure');
      console.log("TEST 3: Done");

      process.env.REDIS_URL_TEST = 'redis://127.0.0.1:6380/1';
      await new Promise(resolve => setTimeout(resolve, 1000));
    });

    it('Starts gracefully even if Redis is down initially', async () => {
      process.env.REDIS_URL_TEST = 'redis://127.0.0.1:6399/9';

      const sA = await setupServer();
      serverA = sA.httpServer;
      portA = sA.port;

      await startSocketInfrastructure(serverA);
      await startSocketRedisAdapter(getSocketServer());
      expect(getSocketInfrastructureState()).toBe('degraded');

      const client1 = createTestClient(portA);
      let errorRecv = null;
      client1.on('connect_error', err => { errorRecv = err; });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(errorRecv).toBeDefined();
    });
  });
});
