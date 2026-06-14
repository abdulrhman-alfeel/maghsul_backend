import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import role from '../../middlewares/role.js';
import validate from '../../middlewares/validate.js';
import { notificationSchemas, userSchemas } from '../../utils/schemas.js';
import UserController from './user.controller.js';

const router = Router();

// \u2015\u2015 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645 \u0627\u0644\u062d\u0627\u0644\u064a \u2015\u2015
router.get('/me', auth, asyncHandler(UserController.me));
router.patch('/me', auth, validate({ body: userSchemas.updateMeBody }), asyncHandler(UserController.updateMe));

// FCM token (\u0642\u0628\u0644 /:userId \u0644\u062a\u062c\u0646\u0628 \u062a\u0639\u0627\u0631\u0636 \u0627\u0644\u0645\u0633\u0627\u0631\u0627\u062a)
router.put('/me/fcm-token', auth, validate({ body: notificationSchemas.upsertFcmTokenBody }), asyncHandler(UserController.upsertFcmToken));

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Account Deletion \u2014 Apple 5.1.1(v)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// \u062c\u0645\u064a\u0639 \u0645\u0633\u0627\u0631\u0627\u062a /api/me/account \u062a\u0639\u0645\u0644 \u0644\u062d\u0633\u0627\u0628\u0627\u062a active \u0648 pending_deletion (\u062d\u0633\u0628 \u0627\u0644\u0645\u0633\u0627\u0631)
router.delete('/me/account', auth, asyncHandler(UserController.requestDeletion));
router.post('/me/account/restore', auth, asyncHandler(UserController.restoreAccount));
router.get('/me/account/deletion-status', auth, asyncHandler(UserController.getDeletionStatus));

// \u0645\u0648\u0638\u0641\u0648 \u0627\u0644\u0645\u063a\u0633\u0644\u0629 \u0644\u0627\u062e\u062a\u064a\u0627\u0631 \u0645\u062f\u064a\u0631 \u0628\u062f\u064a\u0644 (\u0644\u062a\u0637\u0628\u064a\u0642 \u0627\u0644\u0645\u063a\u0633\u0644\u0629 \u0641\u0642\u0637)
router.get('/me/washer-staff', auth, role('washer_admin'), asyncHandler(UserController.getWasherStaff));

// \u2015\u2015 \u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645\u064a\u0646 (\u0645\u0633\u0624\u0648\u0644 \u0627\u0644\u0645\u063a\u0633\u0644\u0629 \u0641\u0642\u0637) \u2015\u2015
router.post(
  '/',
  auth,
  role('washer_admin'),
  validate({ body: userSchemas.createBody }),
  asyncHandler(UserController.create)
);

router.put(
  '/:userId',
  auth,
  role('washer_admin'),
  validate({ body: userSchemas.updateBody }),
  asyncHandler(UserController.update)
);

router.delete(
  '/:userId',
  auth,
  role('washer_admin'),
  asyncHandler(UserController.remove)
);

export default router;

