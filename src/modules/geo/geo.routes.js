import { Router } from 'express';
import asyncHandler from '../../helpers/asyncHandler.js';
import GeoController from './geo.controller.js';

const router = Router();

// Public / client-accessible cached geo catalogs
router.get('/riyadh-neighborhoods', asyncHandler((req, res) => GeoController.getRiyadhNeighborhoods(req, res)));
router.get('/neighborhoods', asyncHandler((req, res) => GeoController.getNeighborhoodsByCity(req, res)));

export default router;
