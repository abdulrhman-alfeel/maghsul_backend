import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import { canonicalContextGuard, requireCanonicalCustomerContext } from '../../middlewares/canonicalContextGuard.js';
import role from '../../middlewares/role.js';
import asyncHandler from "../../helpers/asyncHandler.js";

import validate from '../../middlewares/validate.js';
import OrderController from './order.controller.js';
import { orderSchemas } from '../../utils/schemas.js';

const router = Router();

router.post('/create', canonicalContextGuard, requireCanonicalCustomerContext, validate({ body: orderSchemas.createBody }), asyncHandler(OrderController.create));
router.get('/my-orders', canonicalContextGuard, requireCanonicalCustomerContext, asyncHandler(OrderController.myOrders));
router.get('/:id/invoice', canonicalContextGuard, requireCanonicalCustomerContext, asyncHandler(OrderController.getInvoice));
router.get('/staff/:id', auth, role('washer_owner', 'washer_manager', 'worker', 'driver', 'branch_manager'), asyncHandler(OrderController.getOneStaff));
router.get('/:id', canonicalContextGuard, requireCanonicalCustomerContext, asyncHandler(OrderController.getOne));
router.put('/:id/customer-cancel', canonicalContextGuard, requireCanonicalCustomerContext, asyncHandler(OrderController.customerCancel));
router.put('/:id/washer-status', auth, role('washer_admin', 'worker'), validate({ body: orderSchemas.statusBody }), asyncHandler(OrderController.washerStatus));
router.put('/:id/driver-status', auth, role('driver', 'washer_admin', 'worker'), validate({ body: orderSchemas.statusBody }), asyncHandler(OrderController.driverStatus));
router.put('/:id/order-details', auth, role('washer_admin', 'worker'), validate({ body: orderSchemas.setOrderDetailsBody }), asyncHandler(OrderController.setOrderDetails));

export default router;
