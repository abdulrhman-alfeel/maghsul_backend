import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import role from '../../middlewares/role.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import DriversController from './drivers.controller.js';

const router = Router();

const DRIVER_OR_ADMIN = ['driver', 'washer_admin', 'worker'];
router.get('/me/active', auth, role(...DRIVER_OR_ADMIN), asyncHandler(DriversController.activeOrders));
router.get('/me/cart', auth, role(...DRIVER_OR_ADMIN), asyncHandler(DriversController.cart));
router.get('/me/available-pickup', auth, role(...DRIVER_OR_ADMIN), asyncHandler(DriversController.availablePickup));
router.get('/me/available-delivery', auth, role(...DRIVER_OR_ADMIN), asyncHandler(DriversController.availableDelivery));
router.post('/tasks/:taskId/claim-pickup', auth, role(...DRIVER_OR_ADMIN), asyncHandler(DriversController.claimPickupTask));
router.post('/tasks/:taskId/claim-delivery', auth, role(...DRIVER_OR_ADMIN), asyncHandler(DriversController.claimDeliveryTask));
router.post('/claim-delivery', auth, role(...DRIVER_OR_ADMIN), asyncHandler(DriversController.claimDeliveryByOrderId));
router.post('/order/:orderId/mark-ready', auth, role(...DRIVER_OR_ADMIN), asyncHandler(DriversController.markReady));

export default router;
