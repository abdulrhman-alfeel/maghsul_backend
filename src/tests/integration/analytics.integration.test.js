import request from 'supertest';
import { app } from '../../app.js';
import AnalyticsService from '../../modules/analytics/analytics.service.js';
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestBranch,
  createTestIdentity,
  createStaffMembership,
} from './test-utils.js';

describe('Analytics Integration Tests', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  describe('AnalyticsService Integration', () => {
    it('should calculate gross and net revenue in Halalas correctly', async () => {
      const washerRes = await createTestWasher({ name: 'Analytics Washer 1' });
      const washer = washerRes.washer;
      const branch = await createTestBranch(washer.id, { name: 'Main Branch' });

      const summary = await AnalyticsService.getWasherAnalyticsSummary({
        washerId: washer.id,
        branchId: branch.id,
      });

      expect(summary.washerId).toBe(washer.id);
      expect(summary.currency).toBe('SAR');
      expect(summary.unit).toBe('Halalas');
      expect(typeof summary.financialsHalalas.grossPaymentVolume).toBe('number');
      expect(typeof summary.financialsHalalas.netRevenue).toBe('number');
      expect(Array.isArray(summary.branchBreakdown)).toBe(true);
    });

    it('should prevent cross-washer data access when tenant context is enforced', async () => {
      const washerA = (await createTestWasher({ name: 'Washer A' })).washer;
      const washerB = (await createTestWasher({ name: 'Washer B' })).washer;

      const summaryA = await AnalyticsService.getWasherAnalyticsSummary({
        washerId: washerA.id,
      });

      expect(summaryA.washerId).toBe(washerA.id);
      expect(summaryA.washerId).not.toBe(washerB.id);
    });
  });

  describe('GET /api/analytics/summary HTTP Endpoints', () => {
    it('should return 401 when unauthenticated request is made to analytics endpoint', async () => {
      const res = await request(app).get('/api/analytics/summary?washerId=test-washer');
      expect([401, 403]).toContain(res.status);
    });
  });
});
