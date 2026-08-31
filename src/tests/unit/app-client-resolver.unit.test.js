import appClientResolver from '../../middlewares/appClientResolver.js';
import prisma from '../../config/db.js';
import { setupTestDb } from '../integration/test-utils.js';

function makeReq(headers = {}) {
  return { headers };
}

function makeRes() {
  const res = {};
  res.status = () => res;
  res.json = () => res;
  return res;
}

describe('AppClient Resolver Dual-Mode Resolution Unit Suite', () => {
  let testWasher;
  const testAppId = 'com.resolver.test.customer';
  const testClientKey = 'resolver-db-key';

  beforeAll(async () => {
    await setupTestDb();
    testWasher = await prisma.washer.create({
      data: { name: 'AppClient Resolver Washer', status: 'active' }
    });

    await prisma.appClient.upsert({
      where: { appKey: testAppId },
      update: { washerId: testWasher.id, isActive: true },
      create: {
        washerId: testWasher.id,
        appKey: testAppId,
        appName: 'Resolver Customer App',
        isActive: true
      }
    });

    await prisma.appClient.upsert({
      where: { appKey: testClientKey },
      update: { washerId: testWasher.id, isActive: true },
      create: {
        washerId: testWasher.id,
        appKey: testClientKey,
        appName: 'DB Key App',
        isActive: true
      }
    });
  });

  it('1. Rejects request with missing headers', async () => {
    const req = makeReq({});
    let nextError = null;
    const next = (err) => { nextError = err; };

    await appClientResolver(req, makeRes(), next);
    expect(nextError).not.toBeNull();
    expect(nextError.code).toBe('APP_CLIENT_KEY_MISSING');
  });

  it('2. Resolves valid canonical X-Application-Id via Database AppClient', async () => {
    const req = makeReq({ 'x-application-id': testAppId });
    let nextError = null;
    const next = (err) => { nextError = err; };

    await appClientResolver(req, makeRes(), next);
    expect(nextError).toBeUndefined();
    expect(req.appClient).toBeDefined();
    expect(req.appClient.appKey).toBe(testAppId);
    expect(req.appClient.washerId).toBe(testWasher.id);
    expect(req.appClient.isActive).toBe(true);
  });

  it('3. Resolves valid canonical X-App-Client-Key via Database AppClient', async () => {
    const req = makeReq({ 'x-app-client-key': testClientKey });
    let nextError = null;
    const next = (err) => { nextError = err; };

    await appClientResolver(req, makeRes(), next);
    expect(nextError).toBeUndefined();
    expect(req.appClient).toBeDefined();
    expect(req.appClient.washerId).toBe(testWasher.id);
    expect(req.appClient.isActive).toBe(true);
  });

  it('4. Rejects unknown X-Application-Id', async () => {
    const req = makeReq({ 'x-application-id': 'com.unknown.fake' });
    let nextError = null;
    const next = (err) => { nextError = err; };

    await appClientResolver(req, makeRes(), next);
    expect(nextError).not.toBeNull();
    expect(nextError.code).toBe('APPLICATION_NOT_FOUND');
  });

  it('5. Rejects disabled application identifier', async () => {
    const req = makeReq({ 'x-application-id': 'com.disabled' });
    let nextError = null;
    const next = (err) => { nextError = err; };

    await appClientResolver(req, makeRes(), next);
    expect(nextError).not.toBeNull();
    expect(nextError.code).toBe('APPLICATION_INACTIVE');
  });
});
