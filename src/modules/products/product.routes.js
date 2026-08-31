import { Router } from 'express';
import asyncHandler from '../../helpers/asyncHandler.js';
import validate from '../../middlewares/validate.js';
import upload from '../../middlewares/upload.js';
import { contextGuard, requireStaffSession } from '../../middlewares/contextGuard.js';
import ProductController from './product.controller.js';
import { productSchemas } from '../../utils/schemas.js';
import { uploadFile } from '../../../bucketClooud.js';
import ApiError from '../../helpers/apiError.js';

const router = Router();

/**
 * Middleware: Enforces that the staff member is washer_owner or washer_manager
 * and that their washerId matches req.params.washerId (anti-IDOR).
 */
function requireWasherProductManager(req, res, next) {
  const ctx = req.authContext;
  if (!ctx || !ctx.staffMembershipId) {
    return next(new ApiError(403, 'STAFF_SESSION_REQUIRED', 'Staff operational session required'));
  }

  // Cross-washer IDOR protection
  if (req.params.washerId && ctx.washerId !== req.params.washerId) {
    return next(new ApiError(403, 'MEMBERSHIP_WASHER_MISMATCH', 'Cannot modify products for a different washer'));
  }

  const role = ctx.staffRole || ctx.role;
  if (!['washer_owner', 'washer_manager'].includes(role)) {
    return next(new ApiError(403, 'PERMISSION_DENIED', 'Only washer owner or manager can manage products'));
  }

  next();
}

router.get('/defaults', asyncHandler(ProductController.defaults));
router.get('/washer/:washerId', asyncHandler(ProductController.washerProducts));

router.post(
  '/washer/:washerId',
  contextGuard,
  requireStaffSession,
  requireWasherProductManager,
  validate({ body: productSchemas.washerProductBody }),
  asyncHandler(ProductController.saveWasherProduct)
);

router.post(
  '/upload-image',
  contextGuard,
  requireStaffSession,
  requireWasherProductManager,
  upload.single('image'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No image file provided. Please attach a file with the key "image".' });
    }
    const washerId = req.authContext.washerId;
    const nameFile = `sorting/${washerId}/${req.file.filename}`;
    await uploadFile(nameFile, req.file.path);
    res.json({
      ok: true,
      message: 'Image uploaded',
      data: {
        filename: req.file.filename,
        path: nameFile
      }
    });
  })
);

export default router;
