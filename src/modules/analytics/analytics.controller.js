import AnalyticsService from './analytics.service.js';

class AnalyticsController {
  async getSummary(req, res) {
    const { washerId: queryWasherId, branchId, startDate, endDate } = req.query;

    // Enforce tenant security from authenticated user or req.user / req.washerId
    const targetWasherId = req.user?.washerId || req.washerId || queryWasherId;

    if (!targetWasherId) {
      return res.status(400).json({
        ok: false,
        error: 'WASHER_ID_REQUIRED',
        message: 'washerId is required for analytics reporting',
      });
    }

    // Tenant access guard: If user has washerId, prevent unauthorized cross-washer query
    if (req.user?.washerId && req.user.washerId !== targetWasherId) {
      return res.status(403).json({
        ok: false,
        error: 'FORBIDDEN_WASHER_SCOPE',
        message: 'Access denied: Analytics restricted to authorized washer context',
      });
    }

    const data = await AnalyticsService.getWasherAnalyticsSummary({
      washerId: targetWasherId,
      branchId,
      startDate,
      endDate,
    });

    return res.json({
      ok: true,
      data,
    });
  }
}

export default new AnalyticsController();
