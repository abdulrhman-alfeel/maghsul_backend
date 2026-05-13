import { fail } from '../helpers/apiResponse.js';
import logger from '../config/logger.js';

export default function errorHandler(err, req, res, next) {
  // سجّل التفاصيل الكاملة داخلياً فقط
  logger.error({
    requestId: req.requestId || '-',
    message: err.message,
    stack: err.stack,
    status: err.status,
  });

  const status = err.status || 500;

  // رسالة آمنة للعميل — لا كودات داخلية ولا stack traces
  let clientMessage = err.message || 'حدث خطأ، يرجى المحاولة مرة أخرى';

  // إذا كان خطأ Prisma أو خطأ داخلي غير متوقع، أظهر رسالة عامة فقط
  if (
    status === 500 ||
    err.name === 'PrismaClientKnownRequestError' ||
    err.name === 'PrismaClientValidationError' ||
    err.name === 'PrismaClientUnknownRequestError'
  ) {
    clientMessage = 'حدث خطأ في الخادم، يرجى المحاولة لاحقاً';
  }

  return fail(res, clientMessage, status);
}
