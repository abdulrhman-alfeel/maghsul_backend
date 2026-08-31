import { jest } from '@jest/globals';
import errorHandler from '../../middlewares/errorHandler.js';
import ApiError from '../../helpers/apiError.js';

// Mocks
jest.mock('../../config/logger.js', () => ({
  error: jest.fn()
}));

function makeRes() {
  const r = { _data: null, _status: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (d) => { r._data = d; return r; };
  return r;
}

describe('Error Handler Middleware', () => {
  let res, req, next;

  beforeEach(() => {
    res = makeRes();
    req = { requestId: 'test-req-123' };
    next = jest.fn();
    // Reset NODE_ENV to standard
    process.env.NODE_ENV = 'development';
  });

  test('1. handles standard ApiError correctly', () => {
    const err = new ApiError(400, 'CUSTOM_ERROR', 'A custom message');
    errorHandler(err, req, res, next);
    
    expect(res._status).toBe(400);
    expect(res._data).toMatchObject({
      ok: false,
      code: 'CUSTOM_ERROR',
      error: 'A custom message'
    });
  });

  test('2. maps Prisma P2002 (Unique constraint) to 409 DUPLICATE_RESOURCE', () => {
    const err = new Error('Prisma error');
    err.name = 'PrismaClientKnownRequestError';
    err.code = 'P2002';

    errorHandler(err, req, res, next);

    expect(res._status).toBe(409);
    expect(res._data.code).toBe('DUPLICATE_RESOURCE');
  });

  test('3. maps Prisma P2003 (Foreign key) to 400 INVALID_REFERENCE', () => {
    const err = new Error('Prisma error');
    err.name = 'PrismaClientKnownRequestError';
    err.code = 'P2003';

    errorHandler(err, req, res, next);

    expect(res._status).toBe(400);
    expect(res._data.code).toBe('INVALID_REFERENCE');
  });

  test('4. maps Prisma Client Validation errors to 500 DATABASE_ERROR', () => {
    const err = new Error('Validation error');
    err.name = 'PrismaClientValidationError';

    errorHandler(err, req, res, next);

    expect(res._status).toBe(500);
    expect(res._data.code).toBe('DATABASE_ERROR');
  });

  test('5. maps JWT TokenExpiredError to 401 TOKEN_EXPIRED', () => {
    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';

    errorHandler(err, req, res, next);

    expect(res._status).toBe(401);
    expect(res._data.code).toBe('TOKEN_EXPIRED');
  });

  test('6. masks 500 errors in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Super secret DB internal logic failed');
    err.status = 500;

    errorHandler(err, req, res, next);

    expect(res._status).toBe(500);
    expect(res._data.code).toBe('INTERNAL_ERROR');
    expect(res._data.error).toBe('حدث خطأ في الخادم، يرجى المحاولة لاحقاً');
  });

  test('7. handles validation middleware errors correctly', () => {
    const err = new Error('Validation Error');
    err.isValidationError = true;
    err.details = [{ message: 'Phone is required' }];

    errorHandler(err, req, res, next);

    expect(res._status).toBe(400);
    expect(res._data.code).toBe('VALIDATION_ERROR');
    expect(res._data.details).toEqual([{ message: 'Phone is required' }]);
  });
});
