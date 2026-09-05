import { Router } from 'express';
import { contextGuard, requireStaffSession } from '../../middlewares/contextGuard.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import validate from '../../middlewares/validate.js';
import WashersController from './washers.controller.js';
import { washerSchemas } from '../../utils/schemas.js';

const router = Router();

// Branch coverage management (requires staff session with branch access)
router.get('/:branchId/coverage', contextGuard, requireStaffSession, asyncHandler(WashersController.getBranchCoverage));
router.put('/:branchId/coverage', contextGuard, requireStaffSession, validate({ body: washerSchemas.zonesBody }), asyncHandler(WashersController.replaceBranchCoverage));
router.put('/:branchId/coverage/neighborhoods', contextGuard, requireStaffSession, validate({ body: washerSchemas.neighborhoodCoverageBody }), asyncHandler(WashersController.saveBranchNeighborhoodCoverage));
router.delete('/:branchId/coverage', contextGuard, requireStaffSession, asyncHandler(WashersController.clearBranchCoverage));

export default router;
