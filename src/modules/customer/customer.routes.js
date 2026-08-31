import express from 'express';
import { canonicalContextGuard, requireCanonicalCustomerContext } from '../../middlewares/canonicalContextGuard.js';
import CustomerController from './customer.controller.js';

const router = express.Router();

router.use(canonicalContextGuard);
router.use(requireCanonicalCustomerContext);

router.get('/branches', CustomerController.listBranches);

export default router;

