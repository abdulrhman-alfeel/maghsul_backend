import { jest } from "@jest/globals";
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestIdentity,
  createCustomerMembership
} from './test-utils.js';
import prisma from '../../config/db.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import SessionController from '../../modules/auth/v2/session.controller.js';

let identity, washer, membership;

function makeReq(body = {}) {
  return { body };
}
function makeRes() {
  const r = { _data: null, _status: 200 };
  r.status = (s) => { r._status = s; return r; };
  r.json = (d) => { r._data = d; return r; };
  return r;
}

beforeAll(async () => {
  await setupTestDb();
  const w = await createTestWasher({ name: 'Refresh Washer' });
  washer = w.washer;
  identity = await createTestIdentity('500000040');
  membership = await createCustomerMembership(identity.id, washer.id);
});

afterAll(async () => { await teardownTestDb(); });

describe('Session Controller — refresh', () => {
  test('1. requires refreshToken in body', async () => {
    // Note: the validation middleware does this before the controller
    // but we can test the controller's safety check here
    const req = makeReq({});
    const next = jest.fn();
    await SessionController.refresh(req, makeRes(), next).catch(e => next(e));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'REFRESH_TOKEN_MISSING' }));
  });

  test('2. successfully rotates a valid refresh token', async () => {
    const result1 = await SessionService.createOperationalSession(identity.id, {
      washerId: washer.id, customerMembershipId: membership.id
    });
    const oldRefreshToken = result1.refreshToken;

    const req = makeReq({ refreshToken: oldRefreshToken });
    const res = makeRes();
    await SessionController.refresh(req, res, jest.fn());

    expect(res._data.ok).toBe(true);
    expect(res._data.data.accessToken).toBeTruthy();
    expect(res._data.data.refreshToken).toBeTruthy();
    expect(res._data.data.refreshToken).not.toBe(oldRefreshToken); // token changed
  });
});
