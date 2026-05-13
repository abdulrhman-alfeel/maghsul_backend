import multer from 'multer';
import { getStorage } from '../config/storage.js';

const storage = getStorage();

const maxFileSize = Number(process.env.MAX_FILE_SIZE_MB || 5) * 1024 * 1024;

const upload = multer({
  storage,
  limits: { fileSize: maxFileSize }
});

export default upload;
