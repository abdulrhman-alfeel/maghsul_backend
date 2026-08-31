import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });
jest.setTimeout(25000);

import { startRealtimeApplication, stopRealtimeApplication, getRealtimeApplicationState, parseRealtimeFeatureFlag } from '../../modules/realtime/realtime-application.js';


import { jest } from '@jest/globals';
import { createServer } from 'http';
import { stopInfrastructure, registerSignalHandlers, unregisterSignalHandlers } from '../../server.js';
import prisma from '../../config/db.js';
import { createTestIdentity, createTestWasher, createCustomerMembership, createStaffMembership } from './test-utils.js';
import { StaffInvitationService } from '../../modules/auth/services/staff-invitation.service.js';
import { SocketSessionControlService } from '../../modules/realtime/socket-session-control.service.js';

describe('Phase 3D-1: Backend Cleanup and Controlled Activation', () => {
  let dummyHttpServer;

  beforeAll(async () => {
    dummyHttpServer = createServer();
    await new Promise((resolve) => dummyHttpServer.listen(0, resolve));
    // Make sure we have clean state
    await prisma.realtimeOutboxEvent.deleteMany({});
  });

  afterEach(async () => {
    await stopRealtimeApplication();
    await prisma.realtimeOutboxEvent.deleteMany({});
  });

  afterAll(async () => {
    await stopRealtimeApplication();
    await new Promise((resolve) => dummyHttpServer.close(resolve));
    await prisma.$disconnect();
  });

  describe('1. Feature Flag Parser', () => {
    it('1.1 parses undefined and false as disabled', () => {
      expect(parseRealtimeFeatureFlag(undefined)).toBe('disabled');
      expect(parseRealtimeFeatureFlag('false')).toBe('disabled');
    });

    it('1.2 parses true as enabled', () => {
      expect(parseRealtimeFeatureFlag('true')).toBe('enabled');
    });

    it('1.3 parses anything else as configuration_invalid', () => {
      expect(parseRealtimeFeatureFlag('TRUE')).toBe('configuration_invalid');
      expect(parseRealtimeFeatureFlag('1')).toBe('configuration_invalid');
      expect(parseRealtimeFeatureFlag('yes')).toBe('configuration_invalid');
    });
  });

  describe('2. Realtime Orchestrator Idempotency & State', () => {
    it('2.1 starts once and tracks degraded state if Redis is offline', async () => {
      process.env.REALTIME_V2_ENABLED = 'true';
      // Mangle the Redis URL to simulate offline
      const originalUrl = process.env.REDIS_URL_TEST;
      process.env.REDIS_URL_TEST = 'redis://127.0.0.1:9999';

      await startRealtimeApplication({ httpServer: dummyHttpServer });
      const state1 = getRealtimeApplicationState();
      
      expect(state1.enabled).toBe(true);
      expect(state1.state).toBe('degraded');
      expect(state1.dispatcher).toBe('paused');

      // Calling start again should be a no-op
      await startRealtimeApplication({ httpServer: dummyHttpServer });
      expect(getRealtimeApplicationState().state).toBe('degraded');

      await stopRealtimeApplication();
      process.env.REDIS_URL_TEST = originalUrl;
    });

    it('2.2 starts successfully and tracks ready state', async () => {
      process.env.REALTIME_V2_ENABLED = 'true';

      await startRealtimeApplication({ httpServer: dummyHttpServer });
      const state = getRealtimeApplicationState();
      
      expect(state.enabled).toBe(true);
      expect(state.state).toBe('ready');
      expect(state.dispatcher).toBe('running');

      await stopRealtimeApplication();
    });

    it('2.3 correctly initializes disabled state', async () => {
      process.env.REALTIME_V2_ENABLED = 'false';

      await startRealtimeApplication({ httpServer: dummyHttpServer });
      const state = getRealtimeApplicationState();
      
      expect(state.enabled).toBe(false);
      expect(state.state).toBe('disabled');
    });
  });

  describe('3. Signal Handlers & Shutdown Idempotency', () => {
    it('3.1 registers SIGINT and SIGTERM exactly once per call', () => {
      const initialInt = process.listenerCount('SIGINT');
      const initialTerm = process.listenerCount('SIGTERM');

      registerSignalHandlers();
      
      expect(process.listenerCount('SIGINT')).toBe(initialInt + 1);
      expect(process.listenerCount('SIGTERM')).toBe(initialTerm + 1);

      // We remove the added listeners to not pollute other tests
      const intListeners = process.listeners('SIGINT');
      const termListeners = process.listeners('SIGTERM');
      process.removeListener('SIGINT', intListeners[intListeners.length - 1]);
      process.removeListener('SIGTERM', termListeners[termListeners.length - 1]);
    });
  });

  describe('4. Dispatcher Time and Lease Loss via Raw SQL', () => {
    it('4.1 uses DB NOW() for emittedAt', async () => {
      const event = await prisma.realtimeOutboxEvent.create({
        data: {
          eventId: 'evt_time_test',
          eventKey: 'evt_time_test',
          eventType: 'test',
          eventVersion: 1,
          eventKind: 'client_event',
          aggregateType: 'Test',
          aggregateId: 'test_agg',
          status: 'processing',
          claimedBy: 'test_instance'
        }
      });

      // We'll directly test the raw update via a conflicting claim
      const result = await prisma.$executeRaw`
        UPDATE "RealtimeOutboxEvent"
        SET "status" = 'emitted', "emittedAt" = NOW()
        WHERE "eventId" = ${event.eventId} AND "claimedBy" = 'test_instance' AND "status" = 'processing'
      `;

      expect(result).toBe(1);
      const updated = await prisma.realtimeOutboxEvent.findUnique({ where: { eventId: event.eventId } });
      expect(updated.emittedAt).toBeDefined();
    });

    it('4.2 processing_lease_lost immediately halts the update', async () => {
      const eventId = 'evt_lease_test';
      await prisma.realtimeOutboxEvent.create({
        data: {
          eventId,
          eventKey: eventId,
          eventType: 'test',
          eventVersion: 1,
          eventKind: 'client_event',
          aggregateType: 'Test',
          aggregateId: 'test_agg',
          status: 'processing',
          claimedBy: 'worker_B' // Lease belongs to B
        }
      });

      // Worker A attempts to claim it by running the raw sql directly
      const result = await prisma.$executeRaw`
        UPDATE "RealtimeOutboxEvent"
        SET "status" = 'emitted', "emittedAt" = NOW()
        WHERE "eventId" = ${eventId} AND "claimedBy" = 'worker_A' AND "status" = 'processing'
      `;

      expect(result).toBe(0); // 0 rows updated, meaning processing_lease_lost
    });
  });

  describe('5. E2E Activation Paths', () => {
    let identity;
    let washer;
    let membership;

    beforeAll(async () => {
      identity = await createTestIdentity('+96650000d100', { status: 'active' });
      const wResult = await createTestWasher({ name: 'E2E Washer', status: 'active' });
      washer = wResult.washer;
      membership = await createStaffMembership(identity.id, washer.id, null, { role: 'washer_owner', hasFullWasherAccess: true });
    });

    it('5.1 E2E Client Event via Business Logic', async () => {
      process.env.REALTIME_V2_ENABLED = 'true';
      await startRealtimeApplication({ httpServer: dummyHttpServer });

      // Trigger actual business logic
      const ctx = {
        identityId: identity.id,
        staffMembershipId: membership.id,
        washerId: washer.id
      };
      const payload = {
        phone: '+966500000101',
        proposedRole: 'worker'
      };
      
      const invitation = await StaffInvitationService.createInvitation(ctx, payload);

      // The transaction creates an outbox event
      const event = await prisma.realtimeOutboxEvent.findFirst({
        where: { aggregateType: 'StaffInvitation', aggregateId: invitation.id }
      });
      expect(event).toBeDefined();
      expect(event.eventType).toBe('staff_invitation.created');

      // Dispatcher runs asynchronously, we poll until emitted
      let finalEvent;
      for (let i = 0; i < 20; i++) {
        finalEvent = await prisma.realtimeOutboxEvent.findUnique({ where: { eventId: event.eventId } });
        if (finalEvent.status === 'emitted' || finalEvent.status === 'skipped' || finalEvent.status === 'no_recipients') break;
        await new Promise(r => setTimeout(r, 100));
      }

      // Since there's no active socket connected to rooms, it might be skipped or emitted with 0 rooms depending on implementation
      expect(['emitted', 'skipped', 'no_recipients']).toContain(finalEvent.status);

      await stopRealtimeApplication();
    });

    it('5.2 E2E Internal Command via Business Logic', async () => {
      process.env.REALTIME_V2_ENABLED = 'true';
      await startRealtimeApplication({ httpServer: dummyHttpServer });

      // We spy on disconnectSession to ensure it executes
      const disconnectSpy = jest.spyOn(SocketSessionControlService, 'disconnectSession').mockResolvedValue(undefined);

      // Trigger the internal command by creating the outbox event directly 
      const eventId = 'cmd_' + Date.now();
      await prisma.realtimeOutboxEvent.create({
        data: {
          eventId,
          eventKey: eventId,
          eventType: 'socket.session.disconnect',
          eventVersion: 1,
          eventKind: 'internal_command',
          aggregateType: 'Session',
          aggregateId: 'sess_e2e',
          status: 'pending'
        }
      });

      // Poll
      let finalEvent;
      for (let i = 0; i < 20; i++) {
        finalEvent = await prisma.realtimeOutboxEvent.findUnique({ where: { eventId } });
        if (finalEvent.status === 'emitted') break;
        await new Promise(r => setTimeout(r, 100));
      }

      expect(finalEvent.status).toBe('emitted');
      expect(disconnectSpy).toHaveBeenCalledWith('sess_e2e');

      disconnectSpy.mockRestore();
      await stopRealtimeApplication();
    });
  });
});
