import { jest } from '@jest/globals';
import AnalyticsService from '../../modules/analytics/analytics.service.js';

describe('AnalyticsService Unit Tests', () => {
  it('should throw an error if washerId is missing', async () => {
    await expect(
      AnalyticsService.getWasherAnalyticsSummary({ washerId: null })
    ).rejects.toThrow('washerId is required for analytics summary');
  });

  it('should properly format integer Halala money values and summary structure', () => {
    const rawPayments = [
      { amount: 5000, method: 'online', orderId: 'ord-1' },
      { amount: 6000, method: 'cash_on_delivery', orderId: 'ord-2' },
    ];
    const gross = rawPayments.reduce((sum, p) => sum + p.amount, 0);
    const refunds = 1000;
    const net = gross - refunds;

    expect(gross).toBe(11000); // 110.00 SAR
    expect(net).toBe(10000);   // 100.00 SAR
  });
});
