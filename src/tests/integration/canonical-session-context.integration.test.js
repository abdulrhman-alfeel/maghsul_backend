import request from 'supertest';
import { app } from '../../../src/app.js';
import prisma from '../../../src/config/db.js';
import { createTestIdentity, createCustomerMembership, setupTestDb, teardownTestDb } from './test-utils.js';
import { SessionService } from '../../../src/modules/auth/services/session.service.js';

describe('Canonical Session Context & Middleware', () => {
  let customerIdentity, washer, branch, customerMembership, sessionData;

  beforeAll(async () => {
    await setupTestDb();
    
    // Washer
    washer = await prisma.washer.create({
      data: { name: 'Context Guard Washer', status: 'active', phone: '999' }
    });
    branch = await prisma.branch.create({
      data: { washerId: washer.id, name: 'Main Branch', status: 'active', acceptingOrders: true }
    });
    customerIdentity = await createTestIdentity('+966500000021');
    customerMembership = await createCustomerMembership(customerIdentity.id, washer.id);
    
    const userDevice = await prisma.userDevice.create({
      data: {
        identityId: customerIdentity.id,
        applicationId: 'com.laundry.customer',
        appType: 'customer',
        installationId: 'test-install-123',
        platform: 'ios',
        appVersion: '1.0.0',
        osVersion: '16.0'
      }
    });

    sessionData = await SessionService.createOperationalSession(
      customerIdentity.id,
      {
        purpose: 'client',
        customerMembershipId: customerMembership.id,
        washerId: washer.id
      },
      userDevice.id
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('should successfully build frozen canonical authContext and customerContext', async () => {
    // We add a dummy route to test the context
    app.post('/api/test/context-guard', 
      (await import('../../../src/middlewares/canonicalContextGuard.js')).canonicalContextGuard, 
      (await import('../../../src/middlewares/canonicalContextGuard.js')).requireCanonicalCustomerContext, 
      (req, res) => {
        // Assert req.authContext shape
        const authKeys = Object.keys(req.authContext).sort();
        const customerKeys = Object.keys(req.customerContext).sort();
        
        const isAuthFrozen = Object.isFrozen(req.authContext);
        const isCustomerFrozen = Object.isFrozen(req.customerContext);
        
        res.json({
          authKeys,
          customerKeys,
          isAuthFrozen,
          isCustomerFrozen,
          authContext: req.authContext,
          customerContext: req.customerContext
        });
      }
    );

    const res = await request(app)
      .post('/api/test/context-guard')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', washer.id)
      .send({});
      
    expect(res.status).toBe(200);
    expect(res.body.isAuthFrozen).toBe(true);
    expect(res.body.isCustomerFrozen).toBe(true);
    
    const authExpectedKeys = ['appType', 'identityId', 'sessionId'];
    const customerExpectedKeys = ['appType', 'identityId', 'sessionId', 'washerId'];
    expect(res.body.authKeys.sort()).toEqual(authExpectedKeys.sort());
    expect(res.body.customerKeys.sort()).toEqual(customerExpectedKeys.sort());
    
    expect(res.body.authContext.appType).toBe('customer');
    expect(res.body.authContext.applicationId).toBeUndefined();
    expect(res.body.customerContext.applicationId).toBeUndefined();
    expect(res.body.customerContext.washerId).toBe(washer.id);
  });
});
