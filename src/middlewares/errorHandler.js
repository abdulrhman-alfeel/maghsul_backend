import logger from '../config/logger.js';

/**
 * Centralized Error Handler
 *
 * Converts ApiError and all other errors into a consistent JSON response:
 * {
 *   ok: false,
 *   error: "human-readable message",
 *   code: "MACHINE_READABLE_CODE",
 *   details: null | [...]
 * }
 *
 * Security:
 * - stack is never sent to client.
 * - Prisma errors are never sent raw.
 * - DB/Redis availability errors map to 503.
 */
export default function errorHandler(err, req, res, next) {
  // Always log full details internally
  logger.error({
    requestId: req.requestId || '-',
    message: err.message,
    code: err.code,
    stack: err.stack,
    status: err.status,
  });

  // ── Derive status & code ──────────────────────────────────────────────────

  let status = err.status || 500;
  let code   = err.code   || 'INTERNAL_ERROR';
  let message = err.message || 'حدث خطأ، يرجى المحاولة مرة أخرى';
  let details = err.details || null;

  // ── Prisma Known Errors ───────────────────────────────────────────────────
  if (err.name === 'PrismaClientKnownRequestError') {
    const prismaCode = err.code; // P-codes from Prisma
    if (prismaCode === 'P2002') {
      // Unique constraint violation
      status  = 409;
      code    = 'DUPLICATE_RESOURCE';
      message = 'هذا السجل موجود مسبقاً';
      details = null;
    } else if (prismaCode === 'P2003') {
      // Foreign key constraint violation
      status  = 400;
      code    = 'INVALID_REFERENCE';
      message = 'مرجع غير صالح في البيانات';
      details = null;
    } else if (prismaCode === 'P2025') {
      // Record not found
      status  = 404;
      code    = 'RECORD_NOT_FOUND';
      message = 'السجل المطلوب غير موجود';
      details = null;
    } else {
      status  = 500;
      code    = 'DATABASE_ERROR';
      message = 'حدث خطأ في قاعدة البيانات';
      details = null;
    }
  } else if (
    err.name === 'PrismaClientValidationError' ||
    err.name === 'PrismaClientUnknownRequestError'
  ) {
    status  = 500;
    code    = 'DATABASE_ERROR';
    message = 'حدث خطأ في قاعدة البيانات';
    details = null;
  }

  // ── JWT Errors (direct jwt library throws) ────────────────────────────────
  if (err.name === 'TokenExpiredError') {
    status  = 401;
    code    = 'TOKEN_EXPIRED';
    message = 'انتهت صلاحية الرمز';
    details = null;
  } else if (err.name === 'JsonWebTokenError') {
    status  = 401;
    code    = 'INVALID_TOKEN';
    message = 'الرمز غير صالح';
    details = null;
  }

  // ── Validation Errors (from validate middleware) ──────────────────────────
  if (err.isValidationError) {
    status  = 400;
    code    = 'VALIDATION_ERROR';
    message = 'بيانات الطلب غير صالحة';
    details = err.details;
  }

  // ── Hide 500 internals in production ─────────────────────────────────────
  const isProduction = process.env.NODE_ENV === 'production';
  if (status === 500 && isProduction) {
    message = 'حدث خطأ في الخادم، يرجى المحاولة لاحقاً';
    code    = 'INTERNAL_ERROR';
    details = null;
  }

  return res.status(status).json({
    ok: false,
    error: message,
    code,
    details
  });
}
