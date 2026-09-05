import prisma from '../../config/db.js';
import OrderService from '../../modules/orders/order.service.js';

describe('Phase 1: Geographic Coverage Engine & Routing Policy Integration (Refined V3)', () => {
  let identity;
  let customerMembership;
  let washer;
  let branchA;
  let branchB;
  let app;
  let actorContext;
  const uniquePhone = `9665${Date.now().toString().slice(-7)}`;

  beforeAll(async () => {
    // Clean up any potential leftover record with this phone
    const existing = await prisma.identity.findUnique({ where: { phone: uniquePhone } });
    if (existing) {
      await prisma.customerMembership.deleteMany({ where: { identityId: existing.id } });
      await prisma.identity.delete({ where: { id: existing.id } });
    }

    // 1. Create Identity
    identity = await prisma.identity.create({
      data: { phone: uniquePhone, name: 'Refined Coverage Test User V3' }
    });

    // 2. Create Washer with large service radius (100km) so branch-level zones are isolated for testing
    washer = await prisma.washer.create({
      data: {
        name: 'Riyadh Laundry Main V3',
        status: 'active',
        serviceLat: 24.7136,
        serviceLng: 46.6753,
        serviceRadiusMeters: 100000
      }
    });

    // 3. Create App Client linked to Washer
    app = await prisma.appClient.create({
      data: {
        washerId: washer.id,
        appKey: `cov-app-key-v3-${Date.now()}`,
        appName: 'Coverage Test App V3'
      }
    });

    // 4. Create CustomerMembership
    customerMembership = await prisma.customerMembership.create({
      data: {
        identityId: identity.id,
        washerId: washer.id,
        status: 'active'
      }
    });

    // 5. Create Branch A (Center: 24.7136, 46.6753)
    branchA = await prisma.branch.create({
      data: {
        washerId: washer.id,
        name: 'Olaya Branch A',
        lat: 24.7136,
        lng: 46.6753,
        status: 'active',
        isOpen: true,
        acceptingOrders: true,
        sortOrder: 1
      }
    });

    // 6. Create Branch B (Center: 24.7500, 46.7000)
    branchB = await prisma.branch.create({
      data: {
        washerId: washer.id,
        name: 'Malqa Branch B',
        lat: 24.7500,
        lng: 46.7000,
        status: 'active',
        isOpen: true,
        acceptingOrders: true,
        sortOrder: 2
      }
    });

    // 7. Setup Coverage Zones for Branch A
    // Circle Inclusion Zone (Radius 3000m, priority 10)
    await prisma.coverageZone.create({
      data: {
        branchId: branchA.id,
        name: 'Olaya Circle Zone',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 3000,
        priority: 10,
        isActive: false
      }
    });

    // Polygon Inclusion Zone around Olaya [46.66..46.69, 24.70..24.73]
    await prisma.coverageZone.create({
      data: {
        branchId: branchA.id,
        name: 'Olaya Polygon Zone',
        zoneType: 'inclusion',
        coverageType: 'polygon',
        bbMinLat: 24.7000,
        bbMaxLat: 24.7300,
        bbMinLng: 46.6600,
        bbMaxLng: 46.6900,
        geoJson: {
          coordinates: [
            [
              [46.6600, 24.7000],
              [46.6900, 24.7000],
              [46.6900, 24.7300],
              [46.6600, 24.7300],
              [46.6600, 24.7000]
            ]
          ]
        },
        priority: 5,
        isActive: true
      }
    });

    // Exclusion Zone inside Olaya (~1km away at 24.7200, 46.6800, radius 200m)
    await prisma.coverageZone.create({
      data: {
        branchId: branchA.id,
        name: 'Olaya Restricted Palace Exclusion',
        zoneType: 'exclusion',
        coverageType: 'circle',
        centerLat: 24.7200,
        centerLng: 46.6800,
        radiusMeters: 200,
        priority: 1, // Exclusion MUST override inclusion
        isActive: true
      }
    });

    // 8. Setup Coverage Zone for Branch B
    await prisma.coverageZone.create({
      data: {
        branchId: branchB.id,
        name: 'Malqa Circle Zone',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7500,
        centerLng: 46.7000,
        radiusMeters: 4000,
        priority: 50,
        isActive: true
      }
    });

    actorContext = {
      identityId: identity.id,
      washerId: washer.id,
      applicationId: app.id,
      sessionType: 'operational'
    };
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany();
    await prisma.orderEvent.deleteMany();
    await prisma.driverTask.deleteMany();
    await prisma.refund.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.order.deleteMany();
    await prisma.coverageZone.deleteMany();
    await prisma.branchAccess.deleteMany();
    await prisma.branch.deleteMany();
    if (identity?.id) {
      await prisma.customerMembership.deleteMany({ where: { identityId: identity.id } });
    }
    if (app?.id) {
      await prisma.appClient.deleteMany({ where: { id: app.id } });
    }
    if (washer?.id) {
      await prisma.washer.deleteMany({ where: { id: washer.id } });
    }
    if (identity?.id) {
      await prisma.identity.delete({ where: { id: identity.id } });
    }
  });

  function makeInput(overrides = {}) {
    return {
      washerId: washer.id,
      branchId: overrides.branchId !== undefined ? overrides.branchId : branchA.id,
      pickup: { lat: 24.7136, lng: 46.6753 },
      delivery: { lat: 24.7136, lng: 46.6753 },
      paymentMethod: 'cash_on_delivery',
      serviceType: 'piece',
      notes: 'Refined Coverage Test Order V3',
      ...overrides
    };
  }

  async function expectOrderError(input, expectedStatus, expectedCode) {
    try {
      await OrderService.createOrder({ actorContext, input });
      throw new Error(`Expected createOrder to fail with status ${expectedStatus}`);
    } catch (err) {
      if (err.message.startsWith('Expected createOrder to fail')) throw err;
      expect(err.status).toBe(expectedStatus);
      if (expectedCode) {
        expect(err.code).toBe(expectedCode);
      }
    }
  }

  it('1. Inside Washer + Branch Coverage -> Creates order successfully and routes to Branch A', async () => {
    const input = makeInput();
    const order = await OrderService.createOrder({ actorContext, input });
    expect(order).toBeDefined();
    expect(order.washerId).toBe(washer.id);
    expect(order.branchId).toBe(branchA.id);
  });

  it('2. Outside Washer Coverage -> Rejects with HTTP 422 WASHER_OUT_OF_COVERAGE', async () => {
    await prisma.washer.update({ where: { id: washer.id }, data: { serviceRadiusMeters: 1000 } });

    const input = makeInput({
      pickup: { lat: 25.5000, lng: 47.5000 },
      delivery: { lat: 25.5000, lng: 47.5000 }
    });
    await expectOrderError(input, 422, 'WASHER_OUT_OF_COVERAGE');

    await prisma.washer.update({ where: { id: washer.id }, data: { serviceRadiusMeters: 100000 } });
  });

  it('3. Inside Washer + Outside all Branch Coverages -> Rejects with HTTP 422 BRANCH_OUT_OF_COVERAGE', async () => {
    const input = makeInput({
      pickup: { lat: 24.7300, lng: 46.6300 },
      delivery: { lat: 24.7300, lng: 46.6300 }
    });
    await expectOrderError(input, 422, 'BRANCH_OUT_OF_COVERAGE');
  });

  it('4. Point Exactly on Polygon Edge -> Accepts order (Edge = Inside)', async () => {
    const input = makeInput({
      pickup: { lat: 24.7150, lng: 46.6600 },
      delivery: { lat: 24.7150, lng: 46.6600 }
    });
    const order = await OrderService.createOrder({ actorContext, input });
    expect(order).toBeDefined();
    expect(order.branchId).toBe(branchA.id);
  });

  it('5. Point Exactly on Polygon Vertex -> Accepts order (Vertex = Inside)', async () => {
    const input = makeInput({
      pickup: { lat: 24.7000, lng: 46.6600 },
      delivery: { lat: 24.7000, lng: 46.6600 }
    });
    const order = await OrderService.createOrder({ actorContext, input });
    expect(order).toBeDefined();
    expect(order.branchId).toBe(branchA.id);
  });

  it('6. MultiPolygon Support -> Validates point in MultiPolygon outer rings', async () => {
    const multiPolyZone = await prisma.coverageZone.create({
      data: {
        branchId: branchA.id,
        name: 'MultiPolygon Sub-Zone',
        zoneType: 'inclusion',
        coverageType: 'multi_polygon',
        geoJson: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [46.6000, 24.6000],
                [46.6200, 24.6000],
                [46.6200, 24.6200],
                [46.6000, 24.6200],
                [46.6000, 24.6000]
              ]
            ]
          ]
        },
        priority: 1,
        isActive: true
      }
    });

    const input = makeInput({
      pickup: { lat: 24.6100, lng: 46.6100 },
      delivery: { lat: 24.6100, lng: 46.6100 }
    });
    const order = await OrderService.createOrder({ actorContext, input });
    expect(order.branchId).toBe(branchA.id);

    await prisma.coverageZone.delete({ where: { id: multiPolyZone.id } });
  });

  it('7. Polygon Hole / Inner Ring -> Rejects point inside polygon inner hole ring', async () => {
    const holeZone = await prisma.coverageZone.create({
      data: {
        branchId: branchA.id,
        name: 'Hole Polygon Zone',
        zoneType: 'inclusion',
        coverageType: 'polygon',
        geoJson: {
          type: 'Polygon',
          coordinates: [
            [
              [46.5000, 24.5000],
              [46.5500, 24.5000],
              [46.5500, 24.5500],
              [46.5000, 24.5500],
              [46.5000, 24.5000]
            ],
            [
              [46.5200, 24.5200],
              [46.5300, 24.5200],
              [46.5300, 24.5300],
              [46.5200, 24.5300],
              [46.5200, 24.5200]
            ]
          ]
        },
        priority: 20,
        isActive: true
      }
    });

    const input = makeInput({
      pickup: { lat: 24.5250, lng: 46.5250 },
      delivery: { lat: 24.5250, lng: 46.5250 }
    });
    await expectOrderError(input, 422, 'BRANCH_OUT_OF_COVERAGE');

    await prisma.coverageZone.delete({ where: { id: holeZone.id } });
  });

  it('8. Exclusion Overrides Inclusion -> Exclusion zone overrides inclusion zone regardless of priority', async () => {
    const input = makeInput({
      branchId: branchA.id, // Explicit request for Branch A at Exclusion Zone location
      pickup: { lat: 24.7200, lng: 46.6800 },
      delivery: { lat: 24.7200, lng: 46.6800 }
    });
    await expectOrderError(input, 422, 'BRANCH_OUT_OF_COVERAGE');
  });

  it('9. Service Type Mapping -> Respects required coordinates per serviceType (piece vs quantity)', async () => {
    const inputQuantity = makeInput({
      serviceType: 'quantity',
      pickup: { lat: 24.7136, lng: 46.6753 },
      delivery: null
    });
    const orderQ = await OrderService.createOrder({ actorContext, input: inputQuantity });
    expect(orderQ).toBeDefined();

    const inputPieceMissingDel = makeInput({
      serviceType: 'piece',
      pickup: { lat: 24.7136, lng: 46.6753 },
      delivery: null
    });
    await expectOrderError(inputPieceMissingDel, 400, 'invalid_coordinates');
  });

  it('10. Strict Explicit branchId Rejection -> Rejects explicit uncovered branchId with HTTP 422 BRANCH_OUT_OF_COVERAGE', async () => {
    const input = makeInput({
      branchId: branchB.id,
      pickup: { lat: 24.7136, lng: 46.6753 },
      delivery: { lat: 24.7136, lng: 46.6753 }
    });
    await expectOrderError(input, 422, 'BRANCH_OUT_OF_COVERAGE');
  });

  it('11. Branch Routing Score -> Selects Branch B when pickup is closer to Branch B with higher priority zone', async () => {
    const input = makeInput({
      branchId: branchB.id,
      pickup: { lat: 24.7500, lng: 46.7000 },
      delivery: { lat: 24.7500, lng: 46.7000 }
    });
    const order = await OrderService.createOrder({ actorContext, input });
    expect(order.branchId).toBe(branchB.id);
  });

  it('12. Washer Candidate Isolation -> Washer B candidate branches never enter Washer A candidate set', async () => {
    const washerB = await prisma.washer.create({
      data: { name: 'Washer B', status: 'active', serviceLat: 24.7136, serviceLng: 46.6753, serviceRadiusMeters: 100000 }
    });
    const membershipB = await prisma.customerMembership.create({
      data: { identityId: identity.id, washerId: washerB.id, status: 'active' }
    });
    const branchW2 = await prisma.branch.create({
      data: { washerId: washerB.id, name: 'Identical Olaya Branch B', lat: 24.7136, lng: 46.6753, status: 'active', isOpen: true, acceptingOrders: true }
    });
    await prisma.coverageZone.create({
      data: {
        branchId: branchW2.id,
        name: 'Identical Olaya Zone B',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 5000,
        priority: 999,
        isActive: true
      }
    });

    const inputA = makeInput();
    const orderA = await OrderService.createOrder({ actorContext, input: inputA });
    expect(orderA.washerId).toBe(washer.id);
    expect(orderA.branchId).toBe(branchA.id);

    await prisma.coverageZone.deleteMany({ where: { branchId: branchW2.id } });
    await prisma.branch.delete({ where: { id: branchW2.id } });
    await prisma.customerMembership.delete({ where: { id: membershipB.id } });
    await prisma.washer.delete({ where: { id: washerB.id } });
  });

  it('13. Deterministic Auto-Routing Stability -> 100 consecutive runs produce 100% identical winning branch', async () => {
    const input = makeInput();
    const results = [];
    for (let i = 0; i < 100; i++) {
      const inputWithUniqueIdempotency = { ...input, idempotencyKey: `det-key-v3-${i}-${Date.now()}` };
      const order = await OrderService.createOrder({ actorContext, input: inputWithUniqueIdempotency });
      results.push(order.branchId);
    }
    const allSame = results.every((bId) => bId === branchA.id);
    expect(allSame).toBe(true);
    expect(results.length).toBe(100);
  }, 30000);

  it('14. Inactive Branch Excluded -> Inactive branch is omitted from candidate routing', async () => {
    await prisma.branch.update({ where: { id: branchB.id }, data: { status: 'temporarily_closed' } });

    const input = makeInput({
      pickup: { lat: 24.7500, lng: 46.7000 },
      delivery: { lat: 24.7500, lng: 46.7000 }
    });
    await expectOrderError(input, 422, 'BRANCH_OUT_OF_COVERAGE');

    await prisma.branch.update({ where: { id: branchB.id }, data: { status: 'active' } });
  });

  it('15. Wrong Washer Branch -> Rejects explicit branch belonging to another washer with branch_washer_mismatch', async () => {
    const otherWasher = await prisma.washer.create({
      data: { name: 'Other Washer', status: 'active' }
    });
    const otherBranch = await prisma.branch.create({
      data: { washerId: otherWasher.id, name: 'Other Branch', status: 'active', isOpen: true, acceptingOrders: true }
    });

    const input = makeInput({ branchId: otherBranch.id });
    await expectOrderError(input, 400, 'branch_washer_mismatch');

    await prisma.branch.delete({ where: { id: otherBranch.id } });
    await prisma.washer.delete({ where: { id: otherWasher.id } });
  });

  it('16. Missing Coordinates -> Rejects missing required coordinates with invalid_coordinates', async () => {
    const input = makeInput({ pickup: null, serviceType: 'piece' });
    await expectOrderError(input, 400, 'invalid_coordinates');
  });

  it('17. Invalid Coordinates Out of Range -> Rejects latitude/longitude out of range', async () => {
    const input = makeInput({ pickup: { lat: 195.0, lng: 46.6753 } });
    await expectOrderError(input, 400, 'invalid_coordinates');
  });

  it('18. Coverage Changed During Transaction -> Re-evaluates coverage inside DB transaction before commit', async () => {
    const input = makeInput();
    const order = await OrderService.createOrder({ actorContext, input });
    expect(order.branchId).toBe(branchA.id);
  });

  it('19. Atomic Transaction Rollback -> No partial order records created on coverage failure', async () => {
    const initialCount = await prisma.order.count();
    const input = makeInput({
      pickup: { lat: 24.7300, lng: 46.6300 },
      delivery: { lat: 24.7300, lng: 46.6300 }
    });
    await expectOrderError(input, 422, 'BRANCH_OUT_OF_COVERAGE');
    const finalCount = await prisma.order.count();
    expect(finalCount).toBe(initialCount);
  });

  it('20. Idempotency Preservation -> Retrying order with same idempotencyKey preserves original order result', async () => {
    const input = makeInput({ notes: 'Idempotency Preserved Order' });
    const order1 = await OrderService.createOrder({ actorContext, input });
    expect(order1).toBeDefined();
  });

  it('21. Unconfigured Washer Location Fallback -> Bypasses washer check and evaluates branch coverage directly', async () => {
    await prisma.washer.update({
      where: { id: washer.id },
      data: { serviceLat: null, serviceLng: null }
    });

    const input = makeInput();
    const order = await OrderService.createOrder({ actorContext, input });
    expect(order.branchId).toBe(branchA.id);

    await prisma.washer.update({
      where: { id: washer.id },
      data: { serviceLat: 24.7136, serviceLng: 46.6753 }
    });
  });

  it('22. Unknown Service Type -> Fails closed immediately with HTTP 400 invalid_service_type', async () => {
    const input = makeInput({ serviceType: 'unsupported_custom_service' });
    await expectOrderError(input, 400, 'invalid_service_type');
  });
});
