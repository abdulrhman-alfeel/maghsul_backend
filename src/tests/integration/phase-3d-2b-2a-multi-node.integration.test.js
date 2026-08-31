import dotenv from "dotenv";
dotenv.config({ path: ".env.test" });
import { jest } from '@jest/globals';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { io as Client } from 'socket.io-client';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SocketRoomFactory } from '../../modules/realtime/socket-room.factory.js';
import { SocketRoomService } from '../../modules/realtime/socket-room.service.js';
import { createSocketContextResolver } from '../../modules/realtime/socket-context.resolver.js';
import { socketAuthMiddleware } from '../../modules/realtime/socket-auth.middleware.js';
import prisma from '../../config/db.js';

describe('Phase 3D-2B-2A: Multi-Node Real Redis Execution', () => {
  let pubClient, subClient;
  let serverA, serverB;
  let ioA, ioB;
  let clientCustomerA, clientCustomerB, clientStaffA;
  let portA, portB;

  const identityId = 'ident_multi_test';
  const sessionIdA = 'sess_cust_a';
  const sessionIdB = 'sess_cust_b';
  const sessionIdStaff = 'sess_staff_a';
  const applicationId = 'com.laundry.customer';

  beforeAll(async () => {
    // 1. Setup Redis
    pubClient = new Redis(process.env.REDIS_URL_TEST || 'redis://localhost:6380');
    subClient = pubClient.duplicate();

    const startServer = async () => {
      const httpServer = http.createServer();
      const io = new Server(httpServer, {
        adapter: createAdapter(pubClient, subClient),
        transports: ['websocket'],
      });
      const resolver = createSocketContextResolver();
      io.of('/realtime').use(socketAuthMiddleware);
      io.of('/realtime').use(async (socket, next) => {
        try {
          const rawAccessToken = socket.handshake.auth.accessToken;
          const context = await resolver(rawAccessToken);
          socket.data.context = context;
          next();
        } catch (err) {
          next(new Error('Auth failed'));
        }
      });
      io.of('/realtime').on('connection', (socket) => {
        SocketRoomService.applyJoiningPolicy(socket);
      });
      await new Promise(res => {
        httpServer.listen(() => res());
      });
      return { httpServer, io, port: httpServer.address().port };
    };

    const sA = await startServer();
    serverA = sA.httpServer;
    ioA = sA.io;
    portA = sA.port;

    const sB = await startServer();
    serverB = sB.httpServer;
    ioB = sB.io;
    portB = sB.port;
  });

  afterAll(async () => {
    clientCustomerA?.disconnect();
    clientCustomerB?.disconnect();
    clientStaffA?.disconnect();

    ioA?.close();
    ioB?.close();
    
    await pubClient?.quit();
    await subClient?.quit();
  });

  it('1. Connects sockets to different nodes and verifies multi-node isolation', async () => {
    const tokenCustA = TokenService.signAccessToken({ sessionId: sessionIdA, identityId, sessionType: 'operational', applicationId: 'com.laundry.customer', appType: 'customer' }, '1h');
    const tokenCustB = TokenService.signAccessToken({ sessionId: sessionIdB, identityId, sessionType: 'operational', applicationId: 'com.laundry.customer', appType: 'customer' }, '1h');
    const tokenStaff = TokenService.signAccessToken({ sessionId: sessionIdStaff, identityId, sessionType: 'operational', branchId: 'b1', washerId: 'w1', applicationId: 'com.staff', appType: 'dashboard' }, '1h');

    // Setup dummy session data
    await prisma.session.deleteMany({ where: { identityId } });
    await prisma.userDevice.deleteMany({ where: { identityId } });
    await prisma.identity.deleteMany({ where: { id: identityId } });
    
    await prisma.identity.create({ data: { id: identityId, phone: '+966500000000' } });
    const dev1 = await prisma.userDevice.create({ data: { identityId, installationId: 'i1', platform: 'ios', appType: 'customer', applicationId } });
    const dev2 = await prisma.userDevice.create({ data: { identityId, installationId: 'i2', platform: 'ios', appType: 'customer', applicationId } });
    const dev3 = await prisma.userDevice.create({ data: { identityId, installationId: 'i3', platform: 'ios', appType: 'dashboard', applicationId: 'com.staff' } });
    
    await prisma.session.create({ data: { id: sessionIdA, identityId, sessionType: 'operational', expiresAt: new Date(Date.now()+3600000), userDeviceId: dev1.id } });
    await prisma.session.create({ data: { id: sessionIdB, identityId, sessionType: 'operational', expiresAt: new Date(Date.now()+3600000), userDeviceId: dev2.id } });
    await prisma.session.create({ data: { id: sessionIdStaff, identityId, sessionType: 'operational', expiresAt: new Date(Date.now()+3600000), userDeviceId: dev3.id, washerId: 'w1', branchId: 'b1' } });

    clientCustomerA = Client(`ws://localhost:${portA}/realtime`, { transports: ['websocket'], auth: { accessToken: tokenCustA } });
    clientCustomerB = Client(`ws://localhost:${portB}/realtime`, { transports: ['websocket'], auth: { accessToken: tokenCustB } });
    clientStaffA = Client(`ws://localhost:${portA}/realtime`, { transports: ['websocket'], auth: { accessToken: tokenStaff } });

    await Promise.all([
      new Promise(res => clientCustomerA.on('connect', res)),
      new Promise(res => clientCustomerB.on('connect', res)),
      new Promise(res => clientStaffA.on('connect', res)),
    ]);

    // Test Customer Broadcast goes to both customer sockets but not staff
    const custEventReceivedA = jest.fn();
    const custEventReceivedB = jest.fn();
    const custEventReceivedStaff = jest.fn();
    
    clientCustomerA.on('customer_event', custEventReceivedA);
    clientCustomerB.on('customer_event', custEventReceivedB);
    clientStaffA.on('customer_event', custEventReceivedStaff);

    const targetCustomerRoom = SocketRoomFactory.buildAppIdentityRoom(applicationId, identityId);
    
    // Server A emits to customer room
    ioA.of('/realtime').to(targetCustomerRoom).emit('customer_event', { payload: 'hello' });

    // Wait for multi-node propagation
    await new Promise(res => setTimeout(res, 300));

    expect(custEventReceivedA).toHaveBeenCalled();
    expect(custEventReceivedB).toHaveBeenCalled();
    expect(custEventReceivedStaff).not.toHaveBeenCalled();

    // Test Staff Broadcast goes to staff only
    const staffEventReceivedA = jest.fn();
    const staffEventReceivedB = jest.fn();
    const staffEventReceivedStaff = jest.fn();
    
    clientCustomerA.on('staff_event', staffEventReceivedA);
    clientCustomerB.on('staff_event', staffEventReceivedB);
    clientStaffA.on('staff_event', staffEventReceivedStaff);

    const targetStaffRoom = SocketRoomFactory.buildIdentityRoom(identityId);
    
    // Server B emits to staff room
    ioB.of('/realtime').to(targetStaffRoom).emit('staff_event', { payload: 'hello-staff' });

    await new Promise(res => setTimeout(res, 300));

    expect(staffEventReceivedStaff).toHaveBeenCalled();
    expect(staffEventReceivedA).not.toHaveBeenCalled();
    expect(staffEventReceivedB).not.toHaveBeenCalled();

    // Test socket.session.disconnect
    const sessionARoom = SocketRoomFactory.buildSessionRoom(sessionIdA);
    
    // Server B issues native disconnect command to Server A's session
    const disconnectSpyA = jest.fn();
    const disconnectSpyB = jest.fn();
    const disconnectSpyStaff = jest.fn();
    
    clientCustomerA.on('disconnect', disconnectSpyA);
    clientCustomerB.on('disconnect', disconnectSpyB);
    clientStaffA.on('disconnect', disconnectSpyStaff);

    ioB.of('/realtime').in(sessionARoom).disconnectSockets(true);

    await new Promise(res => setTimeout(res, 300));

    expect(disconnectSpyA).toHaveBeenCalled(); // Should be disconnected
    expect(disconnectSpyB).not.toHaveBeenCalled(); // Other customer session alive
    expect(disconnectSpyStaff).not.toHaveBeenCalled(); // Staff session alive
    
    // Cleanup DB
    await prisma.session.deleteMany({ where: { identityId } });
  });
});

describe('Redis Degradation and Recovery', () => {
  let mainApp, mainServer;
  let getSocketInfrastructureState;
  let stopSocketInfrastructure;
  let getPublisherClient, getSubscriberClient;
  let supertest;

  beforeAll(async () => {
    // We dynamically import these to avoid interfering with global state from the first test
    const infra = await import('../../modules/realtime/socket-infrastructure.js');
    const redisConn = await import('../../modules/realtime/socket-redis.connection.js');
    const appModule = await import('../../app.js');
    const request = (await import('supertest')).default;
    
    getSocketInfrastructureState = infra.getSocketInfrastructureState;
    stopSocketInfrastructure = infra.stopSocketInfrastructure;
    getPublisherClient = redisConn.getPublisherClient;
    getSubscriberClient = redisConn.getSubscriberClient;
    supertest = request;
    
    mainApp = appModule.app;
  });

  afterAll(async () => {
    if (mainServer) {
      mainServer.close();
    }
    await stopSocketInfrastructure();
  });

  it('2. Should handle Redis Degradation, keep REST healthy, and recover', async () => {
    // 1. Start Main Server (Server A) with full infrastructure
    mainServer = http.createServer(mainApp);
    const infra = await import('../../modules/realtime/socket-infrastructure.js');
    const realtimeApp = await import('../../modules/realtime/realtime-application.js'); process.env.REALTIME_V2_ENABLED = 'true'; await realtimeApp.startRealtimeApplication({ httpServer: mainServer });
    
    await new Promise(res => mainServer.listen(0, res));

    // Wait for READY
    await new Promise(res => setTimeout(res, 500));
    expect(getSocketInfrastructureState()).toBe('ready');

    // 2. Disconnect Redis to simulate outage
    const pub = getPublisherClient();
    const sub = getSubscriberClient();
    
    pub.disconnect();
    sub.disconnect();

    // Give it a moment to detect disconnect
    await new Promise(res => setTimeout(res, 300));

    // 3. Prove Realtime transitions to degraded
    expect(getSocketInfrastructureState()).toBe('degraded');

    // 4. Prove REST Health Endpoint remains operational
    const res = await supertest(mainApp).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    
    // Recover Redis
    pub.connect();
    sub.connect();
    await new Promise(res => setTimeout(res, 1000));
    expect(getSocketInfrastructureState()).toBe('ready');

    // --- Part 3: Test Event Emission During Degradation ---
    // Degrade again
    pub.disconnect();
    sub.disconnect();

    await new Promise(res => setTimeout(res, 300));
    expect(getSocketInfrastructureState()).toBe('degraded');

    const RealtimePublisher = (await import('../../modules/realtime/realtime-publisher.js')).RealtimePublisher;
    
    // We skip the DB step and just call emitClientEvent to see what it returns
    const event = { eventId: 'test-event-1', eventType: 'test', eventVersion: 1, occurredAt: new Date() };
    const rooms = ['test_room'];
    const payload = { hello: 'world' };
    
    const result = RealtimePublisher.emitClientEvent(event, rooms, payload);
    
    // Outcome should be retryable_unavailable when degraded
    expect(result.outcome).toBe('retryable_unavailable');
    expect(result.reasonCode).toBe('realtime_infrastructure_unavailable');

    // Recover Redis again
    pub.connect();
    sub.connect();
    await new Promise(res => setTimeout(res, 1000));
    expect(getSocketInfrastructureState()).toBe('ready');
  });
});
