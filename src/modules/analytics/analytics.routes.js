import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import role from '../../middlewares/role.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import AnalyticsController from './analytics.controller.js';

const router = Router();

// GET /api/analytics/summary
router.get(
  '/summary',
  auth,
  role('washer_admin', 'washer_owner', 'washer_manager', 'branch_manager'),
  asyncHandler(AnalyticsController.getSummary)
);

export default router;
