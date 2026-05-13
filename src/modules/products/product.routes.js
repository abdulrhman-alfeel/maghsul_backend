import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import role from '../../middlewares/role.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import validate from '../../middlewares/validate.js';
import upload from '../../middlewares/upload.js';
import ProductController from './product.controller.js';
import { productSchemas } from '../../utils/schemas.js';
import { uploadFile } from '../../../bucketClooud.js';

const router = Router();

router.get('/defaults', asyncHandler(ProductController.defaults));
router.get('/washer/:washerId', asyncHandler(ProductController.washerProducts));
router.post('/washer/:washerId', auth, role('washer_admin'), validate({ body: productSchemas.washerProductBody }), asyncHandler(ProductController.saveWasherProduct));

router.post('/upload-image', auth, role('washer_admin'), upload.single('image'),  async (req, res) => {
  console.log("upload-image 000000",req.file);
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No image file provided. Please attach a file with the key "image".' });
  };
  const nameFile = `sorting/${req.user.washerId}/${req.file.filename}`;
  await uploadFile(nameFile,req.file.path);
  res.json({
    ok: true,
    message: 'Image uploaded',
    data: {
      filename: req.file.filename,
      path: nameFile
    }
  });
});

export default router;
