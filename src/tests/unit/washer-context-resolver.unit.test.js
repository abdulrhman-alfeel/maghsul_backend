import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import washerContextResolver from '../../middlewares/washerContextResolver.js';
import prisma from '../../config/db.js';

function makeReq(headers = {}) {
  return {
    headers: { ...headers }
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _data: null
  };
  res.status = function(code) {
    res._status = code;
    return res;
  };
  res.json = function(data) {
    res._data = data;
    return res;
  };
  return res;
}

describe('Washer Context Resolver Unit Suite (Strict X-Washer-Id)', () => {
  let activeWasher;
  let inactiveWasher;

  beforeEach(async () => {
    // Upsert test washers directly in DB
    activeWasher = await prisma.washer.upsert({
      where: { id: 'test_washer_unit_active' },
      update: { status: 'active', name: 'Active Unit Washer' },
      create: { id: 'test_washer_unit_active', status: 'active', name: 'Active Unit Washer' }
    });

    inactiveWasher = await prisma.washer.upsert({
      where: { id: 'test_washer_unit_inactive' },
      update: { status: 'inactive', name: 'Inactive Unit Washer' },
      create: { id: 'test_washer_unit_inactive', status: 'inactive', name: 'Inactive Unit Washer' }
    });
  });

  it('1. Resolves valid active X-Washer-Id and attaches req.washerContext', async () => {
    const req = makeReq({ 'x-washer-id': activeWasher.id });
    const res = makeRes();
    const next = jest.fn();

    await washerContextResolver(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.washerContext).toBeDefined();
    expect(req.washerContext.washerId).toBe(activeWasher.id);
    expect(req.washerContext.washerName).toBe('Active Unit Washer');
    expect(req.appClient).toBeDefined();
    expect(req.appClient.washerId).toBe(activeWasher.id);
  });

  it('2. Rejects missing X-Washer-Id header with 400 WASHER_HEADER_REQUIRED', async () => {
    const req = makeReq({});
    const res = makeRes();
    const next = jest.fn();

    await washerContextResolver(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    expect(err.code).toBe('WASHER_HEADER_REQUIRED');
  });

  it('3. Rejects empty or whitespace X-Washer-Id header with 400 WASHER_HEADER_REQUIRED', async () => {
    const req = makeReq({ 'x-washer-id': '   ' });
    const res = makeRes();
    const next = jest.fn();

    await washerContextResolver(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    expect(err.code).toBe('WASHER_HEADER_REQUIRED');
  });

  it('4. Rejects overly long X-Washer-Id header with 400 WASHER_HEADER_INVALID', async () => {
    const longId = 'a'.repeat(65);
    const req = makeReq({ 'x-washer-id': longId });
    const res = makeRes();
    const next = jest.fn();

    await washerContextResolver(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    expect(err.code).toBe('WASHER_HEADER_INVALID');
  });

  it('5. Rejects nonexistent washer ID with 404 WASHER_NOT_FOUND', async () => {
    const req = makeReq({ 'x-washer-id': 'nonexistent_washer_999' });
    const res = makeRes();
    const next = jest.fn();

    await washerContextResolver(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
    expect(err.code).toBe('WASHER_NOT_FOUND');
  });

  it('6. Rejects inactive washer ID with 403 WASHER_INACTIVE', async () => {
    const req = makeReq({ 'x-washer-id': inactiveWasher.id });
    const res = makeRes();
    const next = jest.fn();

    await washerContextResolver(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(403);
    expect(err.code).toBe('WASHER_INACTIVE');
  });

  it('7. Zero fallback: Does NOT accept X-Application-Id or X-App-Client-Key without X-Washer-Id', async () => {
    const req = makeReq({
      'x-application-id': activeWasher.id,
      'x-app-client-key': 'some-client-key'
    });
    const res = makeRes();
    const next = jest.fn();

    await washerContextResolver(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    expect(err.code).toBe('WASHER_HEADER_REQUIRED');
  });
});
