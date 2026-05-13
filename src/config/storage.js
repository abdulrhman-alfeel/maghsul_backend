import { S3Client } from '@aws-sdk/client-s3';
import multerS3 from 'multer-s3';
import multer from 'multer';
import path from 'path';
import logger from './logger.js';

const s3Config = {
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT, // e.g. https://<id>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
};

const isConfigured = !!(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);

export const s3 = isConfigured ? new S3Client(s3Config) : null;

if (!isConfigured) {
  logger.warn('S3 Storage: Credentials not found. Falling back to local disk storage.');
}

export const getStorage = () => {
  if (s3) {
    return multerS3({
      s3,
      bucket: process.env.S3_BUCKET || 'laundry-uploads',
      acl: 'public-read',
      metadata: (req, file, cb) => {
        cb(null, { fieldName: file.fieldname });
      },
      key: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, name);
      },
    });
  }

  // Fallback to local disk
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = process.env.UPLOAD_DIR || 'uploads';
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      cb(null, name);
    },
  });
};
