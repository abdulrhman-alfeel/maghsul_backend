
// npx prisma migrate dev --name add_washer_schedule

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { validateEnv } from './utils/envValidator.js';
import { fileURLToPath } from 'url';
import logger from './config/logger.js';

validateEnv();

import requestId from './middlewares/requestId.js';
import requestLogger from './middlewares/logger.js';
import errorHandler from './middlewares/errorHandler.js';

import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/user.routes.js';
import orderRoutes from './modules/orders/order.routes.js';
import productRoutes from './modules/products/product.routes.js';
import washerRoutes from './modules/washers/washers.routes.js';
import driverRoutes from './modules/drivers/drivers.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import paymentRoutes from './modules/payments/payment.routes.js';
import uploadRoutes from './modules/uploads/upload.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');

// إنشاء مجلد الرفع تلقائياً إذا لم يكن موجوداً
import { mkdirSync } from 'fs';
mkdirSync(uploadsDir, { recursive: true });

import { apiLimiter, authLimiter } from './middlewares/rateLimit.js';

import { initSentry, sentryErrorHandler } from './config/sentry.js';

const app = express();
initSentry(app);

const swaggerDocument = YAML.load(path.join(__dirname, '../docs/openapi.yaml'));

// Apply rate limiting to all requests
app.use('/api/', apiLimiter);

// Stricter rate limiting for auth routes
app.use('/api/auth/', authLimiter);

// Disable ETag to avoid 304 responses for JSON APIs (mobile clients may cache unexpectedly).
app.set('etag', false);

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || '').split(',')
}));
app.use(express.json({ limit: '2mb' }));
// معالجة الـ body الذي يصل كـ null بدلاً من إرجاع خطأ 400
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    req.body = {};
    return next();
  }
  return next(err);
});
app.use(morgan('dev'));
app.use(requestId);
app.use(requestLogger);

app.use('/uploads', express.static(uploadsDir));

app.get('/health', (req, res) => res.json({ ok: true, requestId: req.requestId }));
app.get('/docs/openapi.yaml', (req, res) => res.sendFile(path.join(__dirname, '../docs/openapi.yaml')));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/washers', washerRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/uploads', uploadRoutes);

// BullMQ Workers
import './workers/notification.worker.js';
import './workers/accountDeletion.worker.js';


import http from 'http';
import { initSocket } from './config/socket.js';

// Sentry Error Handler
sentryErrorHandler(app);

app.use(errorHandler);

const httpServer = http.createServer(app);
initSocket(httpServer);

const port = Number(process.env.PORT || 8080);
httpServer.listen(port, () => {
  logger.info(`Server running on http://localhost:${port}`);
  logger.info(`Swagger docs on http://localhost:${port}/docs`);
});
