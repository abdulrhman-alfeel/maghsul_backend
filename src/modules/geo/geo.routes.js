import { Router } from 'express';
import asyncHandler from '../../helpers/asyncHandler.js';
import GeoController from './geo.controller.js';

const router = Router();

// Canonical generic multi-city route
router.get('/cities/:cityCode/neighborhoods', asyncHandler(GeoController.getCityNeighborhoods));

// Backward-compatible routes delegating internally to riyadh
router.get('/riyadh-neighborhoods', asyncHandler(GeoController.getRiyadhNeighborhoods));
router.get('/neighborhoods', asyncHandler(GeoController.getRiyadhNeighborhoods));

export default router;
