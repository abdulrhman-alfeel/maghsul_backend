import prisma from '../../config/db.js';
import OrderService from '../../modules/orders/order.service.js';
import WashersService from '../../modules/washers/washers.service.js';
import GeoService from '../../modules/geo/geo.service.js';

describe('Phase GEO-2G: Geographic Coverage Dual-Mode Integration Test Suite', () => {
  let washer;
  let branch;
  let otherWasher;
  let otherBranch;
  let customerIdentity;
  let customerMembership;
  let appClient;
  let customerContext;

  // Staff Contexts
  let ownerContext;
  let managerContext;
  let branchManagerWithPermContext;
  let branchManagerWithoutPermContext;
  let workerContext;
  let crossWasherContext;

  const uniqueSuffix = Date.now().toString().slice(-6);

  beforeAll(async () => {
    // 1. Create Primary Washer & Branch
    washer = await prisma.washer.create({
      data: {
        name: `DualMode Washer ${uniqueSuffix}`,
        status: 'active',
        serviceLat: 24.7136,
        serviceLng: 46.6753,
        serviceRadiusMeters: 100000, // Large washer radius to isolate branch coverage
      },
    });

    branch = await prisma.branch.create({
      data: {
        washerId: washer.id,
        name: 'DualMode Central Branch',
        lat: 24.7136,
        lng: 46.6753,
        status: 'active',
        isOpen: true,
        acceptingOrders: true,
      },
    });

    // 2. Create Foreign Washer & Branch (for cross-washer isolation checks)
    otherWasher = await prisma.washer.create({
      data: {
        name: `Foreign Washer ${uniqueSuffix}`,
        status: 'active',
      },
    });

    otherBranch = await prisma.branch.create({
      data: {
        washerId: otherWasher.id,
        name: 'Foreign Branch',
        lat: 24.8000,
        lng: 46.8000,
        status: 'active',
        isOpen: true,
        acceptingOrders: true,
      },
    });

    // 3. Customer Identity & Client App
    customerIdentity = await prisma.identity.create({
      data: {
        phone: `96650${uniqueSuffix}`,
        name: 'DualMode Customer',
      },
    });

    appClient = await prisma.appClient.create({
      data: {
        washerId: washer.id,
        appKey: `dualmode-app-${uniqueSuffix}`,
        appName: 'DualMode Test App',
      },
    });

    customerMembership = await prisma.customerMembership.create({
      data: {
        identityId: customerIdentity.id,
        washerId: washer.id,
        status: 'active',
      },
    });

    customerContext = {
      identityId: customerIdentity.id,
      washerId: washer.id,
      applicationId: appClient.id,
      sessionType: 'operational',
    };

    // 4. Ensure canonical 'manage_coverage' permission exists in DB
    const manageCoveragePerm = await prisma.permission.upsert({
      where: { code: 'manage_coverage' },
      update: {},
      create: {
        code: 'manage_coverage',
        name: 'إدارة نطاق التغطية',
        scope: 'branch',
      },
    });

    // 5. Setup Staff Identities & Memberships for Auth v2
    // A: Washer Owner
    const ownerIdentity = await prisma.identity.create({
      data: { phone: `96651${uniqueSuffix}`, name: 'Washer Owner' },
    });
    const ownerMem = await prisma.staffMembership.create({
      data: {
        identityId: ownerIdentity.id,
        washerId: washer.id,
        role: 'washer_owner',
        hasFullWasherAccess: true,
        status: 'active',
      },
    });
    ownerContext = {
      identityId: ownerIdentity.id,
      washerId: washer.id,
      staffMembershipId: ownerMem.id,
      staffRole: 'washer_owner',
      role: 'washer_owner',
      sessionType: 'operational',
    };

    // B: Washer Manager
    const managerIdentity = await prisma.identity.create({
      data: { phone: `96652${uniqueSuffix}`, name: 'Washer Manager' },
    });
    const managerMem = await prisma.staffMembership.create({
      data: {
        identityId: managerIdentity.id,
        washerId: washer.id,
        role: 'washer_manager',
        hasFullWasherAccess: true,
        status: 'active',
      },
    });
    managerContext = {
      identityId: managerIdentity.id,
      washerId: washer.id,
      staffMembershipId: managerMem.id,
      staffRole: 'washer_manager',
      role: 'washer_manager',
      sessionType: 'operational',
    };

    // C: Branch Manager with 'manage_coverage'
    const bmWithPermIdentity = await prisma.identity.create({
      data: { phone: `96653${uniqueSuffix}`, name: 'BM With Perm' },
    });
    const bmWithPermMem = await prisma.staffMembership.create({
      data: {
        identityId: bmWithPermIdentity.id,
        washerId: washer.id,
        role: 'branch_manager',
        hasFullWasherAccess: false,
        status: 'active',
      },
    });
    await prisma.branchAccess.create({
      data: {
        staffMembershipId: bmWithPermMem.id,
        branchId: branch.id,
      },
    });
    // Link permission to branch_manager role
    await prisma.rolePermission.upsert({
      where: { role_permissionId: { role: 'branch_manager', permissionId: manageCoveragePerm.id } },
      update: {},
      create: { role: 'branch_manager', permissionId: manageCoveragePerm.id },
    });

    branchManagerWithPermContext = {
      identityId: bmWithPermIdentity.id,
      washerId: washer.id,
      branchId: branch.id,
      staffMembershipId: bmWithPermMem.id,
      staffRole: 'branch_manager',
      role: 'branch_manager',
      sessionType: 'operational',
    };

    // D: Branch Manager with explicitly DENIED 'manage_coverage' override
    const bmWithoutPermIdentity = await prisma.identity.create({
      data: { phone: `96654${uniqueSuffix}`, name: 'BM Without Perm' },
    });
    const bmWithoutPermMem = await prisma.staffMembership.create({
      data: {
        identityId: bmWithoutPermIdentity.id,
        washerId: washer.id,
        role: 'branch_manager',
        hasFullWasherAccess: false,
        status: 'active',
      },
    });
    const bmNoAccess = await prisma.branchAccess.create({
      data: {
        staffMembershipId: bmWithoutPermMem.id,
        branchId: branch.id,
      },
    });
    // Override deny for this branch access
    await prisma.branchPermissionOverride.create({
      data: {
        branchAccessId: bmNoAccess.id,
        permissionId: manageCoveragePerm.id,
        effect: 'deny',
      },
    });

    branchManagerWithoutPermContext = {
      identityId: bmWithoutPermIdentity.id,
      washerId: washer.id,
      branchId: branch.id,
      staffMembershipId: bmWithoutPermMem.id,
      staffRole: 'branch_manager',
      role: 'branch_manager',
      sessionType: 'operational',
    };

    // E: Worker
    const workerIdentity = await prisma.identity.create({
      data: { phone: `96655${uniqueSuffix}`, name: 'Worker Staff' },
    });
    const workerMem = await prisma.staffMembership.create({
      data: {
        identityId: workerIdentity.id,
        washerId: washer.id,
        role: 'worker',
        hasFullWasherAccess: false,
        status: 'active',
      },
    });
    workerContext = {
      identityId: workerIdentity.id,
      washerId: washer.id,
      branchId: branch.id,
      staffMembershipId: workerMem.id,
      staffRole: 'worker',
      role: 'worker',
      sessionType: 'operational',
    };

    // F: Cross Washer Staff
    crossWasherContext = {
      identityId: ownerIdentity.id,
      washerId: otherWasher.id, // Different washer
      staffMembershipId: ownerMem.id,
      staffRole: 'washer_owner',
      role: 'washer_owner',
      sessionType: 'operational',
    };
  });

  afterAll(async () => {
    // Cleanup test data
    await prisma.orderItem.deleteMany();
    await prisma.orderEvent.deleteMany();
    await prisma.driverTask.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.order.deleteMany();
    await prisma.coverageZone.deleteMany({ where: { branchId: { in: [branch.id, otherBranch.id] } } });
    await prisma.branchPermissionOverride.deleteMany();
    await prisma.branchAccess.deleteMany();
    await prisma.staffMembership.deleteMany({ where: { washerId: { in: [washer.id, otherWasher.id] } } });
    await prisma.customerMembership.deleteMany({ where: { washerId: washer.id } });
    await prisma.branch.deleteMany({ where: { id: { in: [branch.id, otherBranch.id] } } });
    await prisma.appClient.deleteMany({ where: { id: appClient.id } });
    await prisma.washer.deleteMany({ where: { id: { in: [washer.id, otherWasher.id] } } });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 1: Mode 1 — Circle Save & Order Evaluation
  // ──────────────────────────────────────────────────────────────────────────
  test('1. Should save Circle coverage and validate orders within circle radius', async () => {
    const circlePayload = [
      {
        name: 'نطاق الفرع الدائري',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 2000, // 2km radius
        isActive: true,
        priority: 10,
      },
    ];

    const savedZones = await WashersService.replaceBranchCoverage(ownerContext, branch.id, circlePayload);
    expect(savedZones).toHaveLength(1);
    expect(savedZones[0].coverageType).toBe('circle');
    expect(savedZones[0].isActive).toBe(true);
    expect(savedZones[0].radiusMeters).toBe(2000);

    // Order within 500m of center (Covered)
    const insideOrder = await OrderService.createOrder(
      {
        washerId: washer.id,
        branchId: branch.id,
        pickup: { lat: 24.7150, lng: 46.6760 },
        pickupAddress: 'Inside Circle Test Address',
        items: [],
      },
      customerContext
    );
    expect(insideOrder.id).toBeDefined();

    // Order 10km away (Outside -> Reject with 422 BRANCH_OUT_OF_COVERAGE)
    await expect(
      OrderService.createOrder(
        {
          washerId: washer.id,
          branchId: branch.id,
          pickup: { lat: 24.8100, lng: 46.7800 },
          pickupAddress: 'Outside Circle Address',
          items: [],
        },
        customerContext
      )
    ).rejects.toMatchObject({
      status: 422,
      code: 'BRANCH_OUT_OF_COVERAGE',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 2: Mode Switch — Circle -> Neighborhoods
  // ──────────────────────────────────────────────────────────────────────────
  test('2. Should atomically switch from Circle to Neighborhoods, deactivating circle zones', async () => {
    // Al Khuzama ('3802') and Dahiat Namar ('3401')
    const neighborhoodPayload = {
      cityCode: 'riyadh',
      districtCodes: ['3802', '3401'],
    };

    const savedZones = await WashersService.saveBranchNeighborhoodCoverage(
      ownerContext,
      branch.id,
      neighborhoodPayload
    );

    expect(savedZones).toHaveLength(2);
    expect(savedZones[0].coverageType).toBe('polygon');
    expect(savedZones[0].isActive).toBe(true);
    expect(savedZones[1].coverageType).toBe('polygon');
    expect(savedZones[1].isActive).toBe(true);

    // Verify canonical snapshot properties
    const districtCodesInDb = savedZones.map((z) => z.geoJson?.properties?.districtCode);
    expect(districtCodesInDb).toContain('3802');
    expect(districtCodesInDb).toContain('3401');

    // Verify that the previous circle zone is NOT deleted, but transitioned to isActive = false
    const allDbZones = await prisma.coverageZone.findMany({ where: { branchId: branch.id } });
    const circleZones = allDbZones.filter((z) => z.coverageType === 'circle');
    expect(circleZones.length).toBeGreaterThan(0);
    expect(circleZones.every((z) => z.isActive === false)).toBe(true);

    // Verify order evaluation:
    // Get canonical feature for 3802 to extract an inside coordinate
    const feature3802 = GeoService.getCanonicalIndex().get('3802');
    const firstCoord = feature3802.geometry.coordinates[0][0]; // [lng, lat]
    // Point inside Al Khuzama:
    const insidePickup = { lat: firstCoord[1], lng: firstCoord[0] };

    const orderInDistrict = await OrderService.createOrder(
      {
        washerId: washer.id,
        branchId: branch.id,
        pickup: insidePickup,
        pickupAddress: 'Inside Al Khuzama Address',
        items: [],
      },
      customerContext
    );
    expect(orderInDistrict.id).toBeDefined();

    // Verify order in old circle location (which is NOT in 3802 or 3401) is now REJECTED
    // (Prevents unintended coverage union!)
    await expect(
      OrderService.createOrder(
        {
          washerId: washer.id,
          branchId: branch.id,
          pickup: { lat: 24.7136, lng: 46.6753 }, // Olaya center (not Al Khuzama or Namar)
          pickupAddress: 'Old Circle Center Address',
          items: [],
        },
        customerContext
      )
    ).rejects.toMatchObject({
      status: 422,
      code: 'BRANCH_OUT_OF_COVERAGE',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 3: Mode Switch — Neighborhoods -> Circle
  // ──────────────────────────────────────────────────────────────────────────
  test('3. Should atomically switch back from Neighborhoods to Circle, deactivating polygon zones', async () => {
    const circlePayload = [
      {
        name: 'نطاق دائري مستعاد',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 3000,
        isActive: true,
        priority: 10,
      },
    ];

    const savedZones = await WashersService.replaceBranchCoverage(ownerContext, branch.id, circlePayload);
    expect(savedZones).toHaveLength(1);
    expect(savedZones[0].coverageType).toBe('circle');
    expect(savedZones[0].isActive).toBe(true);

    // Verify all polygon zones for this branch transitioned to isActive = false (preserved!)
    const allDbZones = await prisma.coverageZone.findMany({ where: { branchId: branch.id } });
    const polygonZones = allDbZones.filter((z) => z.coverageType === 'polygon');
    expect(polygonZones.length).toBe(2);
    expect(polygonZones.every((z) => z.isActive === false)).toBe(true);

    // Old circle center is covered again:
    const restoredCircleOrder = await OrderService.createOrder(
      {
        washerId: washer.id,
        branchId: branch.id,
        pickup: { lat: 24.7136, lng: 46.6753 },
        pickupAddress: 'Restored Circle Address',
        items: [],
      },
      customerContext
    );
    expect(restoredCircleOrder.id).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 4: Auth v2 Role Enforcement
  // ──────────────────────────────────────────────────────────────────────────
  test('4. Should strictly enforce Auth v2 roles and permissions on coverage mutation', async () => {
    const payload = {
      cityCode: 'riyadh',
      districtCodes: ['3802'],
    };

    // A: Washer Manager -> ALLOW
    const mgrResult = await WashersService.saveBranchNeighborhoodCoverage(managerContext, branch.id, payload);
    expect(mgrResult).toBeDefined();

    // B: Branch Manager with 'manage_coverage' permission -> ALLOW
    const bmResult = await WashersService.saveBranchNeighborhoodCoverage(
      branchManagerWithPermContext,
      branch.id,
      payload
    );
    expect(bmResult).toBeDefined();

    // C: Branch Manager with explicitly DENIED 'manage_coverage' -> DENY (403)
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(branchManagerWithoutPermContext, branch.id, payload)
    ).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });

    // D: Worker -> DENY (403)
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(workerContext, branch.id, payload)
    ).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });

    // E: Cross-Washer Staff -> DENY (403)
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(crossWasherContext, branch.id, payload)
    ).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 5: Mixed Legacy State Automatic Normalization
  // ──────────────────────────────────────────────────────────────────────────
  test('5. Should automatically normalize mixed legacy state (simultaneous active circle and polygon)', async () => {
    // Manually force a mixed legacy state in DB:
    // Circle updated at T0 (older)
    const olderDate = new Date(Date.now() - 60000);
    // Polygon updated at T1 (newer)
    const newerDate = new Date();

    await prisma.coverageZone.deleteMany({ where: { branchId: branch.id } });

    await prisma.coverageZone.create({
      data: {
        branchId: branch.id,
        name: 'Legacy Circle',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 1500,
        isActive: true,
        updatedAt: olderDate,
      },
    });

    await prisma.coverageZone.create({
      data: {
        branchId: branch.id,
        name: 'Legacy Polygon',
        zoneType: 'inclusion',
        coverageType: 'polygon',
        geoJson: { type: 'Polygon', coordinates: [[[46.6, 24.7], [46.7, 24.7], [46.7, 24.8], [46.6, 24.8], [46.6, 24.7]]] },
        isActive: true,
        updatedAt: newerDate,
      },
    });

    // Both are currently active:
    const preCheck = await prisma.coverageZone.findMany({ where: { branchId: branch.id, isActive: true } });
    expect(preCheck).toHaveLength(2);

    // Call getBranchCoverage -> triggers automatic normalization:
    const normalized = await WashersService.getBranchCoverage(ownerContext, branch.id);

    // Newer mode (polygon) was kept active, older circle was deactivated:
    expect(normalized).toHaveLength(1);
    expect(normalized[0].coverageType).toBe('polygon');

    const postCheck = await prisma.coverageZone.findMany({ where: { branchId: branch.id, isActive: true } });
    expect(postCheck).toHaveLength(1);
    expect(postCheck[0].coverageType).toBe('polygon');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 6: FAIL_CLOSED on Clear Coverage
  // ──────────────────────────────────────────────────────────────────────────
  test('6. Should fail closed with 422 when branch coverage is cleared', async () => {
    await WashersService.clearBranchCoverage(ownerContext, branch.id);

    const activeZones = await prisma.coverageZone.findMany({ where: { branchId: branch.id, isActive: true } });
    expect(activeZones).toHaveLength(0);

    await expect(
      OrderService.createOrder(
        {
          washerId: washer.id,
          branchId: branch.id,
          pickup: { lat: 24.7136, lng: 46.6753 },
          pickupAddress: 'Any Address When Cleared',
          items: [],
        },
        customerContext
      )
    ).rejects.toMatchObject({
      status: 422,
      code: 'BRANCH_OUT_OF_COVERAGE',
    });
  });
});
