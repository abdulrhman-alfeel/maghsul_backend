import { jest } from "@jest/globals";
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher
} from './test-utils.js';
import prisma from '../../config/db.js';
import appClientResolver from '../../middlewares/appClientResolver.js';

function makeReq(headers = {}) {
  return { headers };
}
function makeRes() {
  const res = {};
  res.status = () => res;
  res.json = () => res;
  return res;
}

let washer, appClient;

beforeAll(async () => {
  await setupTestDb();
  ({ washer, appClient } = await createTestWasher({ appKey: 'resolver-test-key' }));
});

afterAll(async () => {
  await teardownTestDb();
});

describe('AppClient Resolver Middleware', () => {
  test('1. rejects missing X-App-Client-Key header', async () => {
    const req = makeReq({});
    const next = jest.fn();
    await appClientResolver(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'APP_CLIENT_KEY_MISSING' }));
  });

  test('2. rejects empty X-App-Client-Key header', async () => {
    const req = makeReq({ 'x-app-client-key': '   ' });
    const next = jest.fn();
    await appClientResolver(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'APP_CLIENT_KEY_MISSING' }));
  });

  test('3. rejects unknown app key', async () => {
    const req = makeReq({ 'x-app-client-key': 'nonexistent-key' });
    const next = jest.fn();
    await appClientResolver(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'APP_CLIENT_NOT_FOUND' }));
  });

  test('4. rejects inactive AppClient', async () => {
    const { appClient: inactive } = await createTestWasher({ appKey: 'inactive-key', isActive: false });
    const req = makeReq({ 'x-app-client-key': 'inactive-key' });
    const next = jest.fn();
    await appClientResolver(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'APP_CLIENT_INACTIVE' }));
  });

  test('5. populates req.appClient with correct fields for valid key', async () => {
    const req = makeReq({ 'x-app-client-key': 'resolver-test-key' });
    const next = jest.fn();
    await appClientResolver(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.appClient).toMatchObject({
      appClientId: appClient.id,
      washerId: washer.id,
      isActive: true
    });
    // Must NOT contain appKey or secrets
    expect(req.appClient).not.toHaveProperty('appKey');
  });

  test('6. washerId in req.appClient matches the DB washer', async () => {
    const req = makeReq({ 'x-app-client-key': 'resolver-test-key' });
    const next = jest.fn();
    await appClientResolver(req, makeRes(), next);
    expect(req.appClient.washerId).toBe(washer.id);
  });
});
