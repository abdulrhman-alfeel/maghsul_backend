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
  let driverContext;
  let crossWasherContext;

  const uniqueSuffix = Date.now().toString().slice(-6);

  function makeInput(overrides = {}) {
    return {
      washerId: washer.id,
      branchId: overrides.branchId !== undefined ? overrides.branchId : branch.id,
      pickup: { lat: 24.7136, lng: 46.6753 },
      delivery: { lat: 24.7136, lng: 46.6753 },
      paymentMethod: 'cash_on_delivery',
      serviceType: 'piece',
      notes: 'Dual Mode Coverage Test Order',
      ...overrides,
    };
  }

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

    await prisma.rolePermission.upsert({
      where: {
        role_permissionId: {
          role: 'branch_manager',
          permissionId: manageCoveragePerm.id,
        },
      },
      update: {},
      create: {
        role: 'branch_manager',
        permissionId: manageCoveragePerm.id,
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

    // C: Branch Manager with 'manage_coverage' granted
    const bmWithPermIdentity = await prisma.identity.create({
      data: { phone: `96653${uniqueSuffix}`, name: 'Branch Manager With Perm' },
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
    const bmWithPermAccess = await prisma.branchAccess.create({
      data: {
        staffMembershipId: bmWithPermMem.id,
        branchId: branch.id,
      },
    });
    await prisma.branchPermissionOverride.create({
      data: {
        branchAccessId: bmWithPermAccess.id,
        permissionId: manageCoveragePerm.id,
        effect: 'allow',
      },
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

    // D: Branch Manager without 'manage_coverage'
    const bmWithoutPermIdentity = await prisma.identity.create({
      data: { phone: `96654${uniqueSuffix}`, name: 'Branch Manager Without Perm' },
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
    const bmWithoutPermAccess = await prisma.branchAccess.create({
      data: {
        staffMembershipId: bmWithoutPermMem.id,
        branchId: branch.id,
      },
    });
    await prisma.branchPermissionOverride.create({
      data: {
        branchAccessId: bmWithoutPermAccess.id,
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

    // E: Worker Staff
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
    await prisma.branchAccess.create({
      data: {
        staffMembershipId: workerMem.id,
        branchId: branch.id,
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

    // F: Driver Staff
    const driverIdentity = await prisma.identity.create({
      data: { phone: `96656${uniqueSuffix}`, name: 'Driver Staff' },
    });
    const driverMem = await prisma.staffMembership.create({
      data: {
        identityId: driverIdentity.id,
        washerId: washer.id,
        role: 'driver',
        hasFullWasherAccess: false,
        status: 'active',
      },
    });
    driverContext = {
      identityId: driverIdentity.id,
      washerId: washer.id,
      staffMembershipId: driverMem.id,
      staffRole: 'driver',
      role: 'driver',
      sessionType: 'operational',
    };

    // G: Cross Washer Staff
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
    // Cleanup test data in strict foreign-key order
    await prisma.refund.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.orderEvent.deleteMany();
    await prisma.driverTask.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.order.deleteMany();
    await prisma.coverageZone.deleteMany({ where: { branchId: { in: [branch.id, otherBranch.id] } } });
    await prisma.rolePermission.deleteMany({
      where: { role: 'branch_manager', permission: { code: 'manage_coverage' } },
    });
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
        radiusMeters: 2000,
        isActive: true,
        priority: 10,
      },
    ];

    const savedZones = await WashersService.replaceBranchCoverage(ownerContext, branch.id, circlePayload);
    expect(savedZones).toHaveLength(1);
    expect(savedZones[0].coverageType).toBe('circle');
    expect(savedZones[0].isActive).toBe(true);

    // Read coverage and verify pure circle mode
    const coverageRes = await WashersService.getBranchCoverage(ownerContext, branch.id);
    expect(coverageRes.mode).toBe('circle');
    expect(coverageRes.isConflict).toBe(false);

    // Order within 500m (Covered)
    const insideInput = makeInput({
      pickup: { lat: 24.7150, lng: 46.6760 },
      delivery: { lat: 24.7150, lng: 46.6760 },
    });
    const insideOrder = await OrderService.createOrder({ actorContext: customerContext, input: insideInput });
    expect(insideOrder.id).toBeDefined();

    // Order 10km away (Outside -> Reject with 422)
    const outsideInput = makeInput({
      pickup: { lat: 24.8100, lng: 46.7800 },
      delivery: { lat: 24.8100, lng: 46.7800 },
    });
    await expect(
      OrderService.createOrder({ actorContext: customerContext, input: outsideInput })
    ).rejects.toMatchObject({
      status: 422,
      code: 'BRANCH_OUT_OF_COVERAGE',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 2: Mode Switch — Circle -> Neighborhoods (With Exclusion Preservation)
  // ──────────────────────────────────────────────────────────────────────────
  test('2. Should switch from Circle to Neighborhoods, preserving active exclusion zones', async () => {
    // Configure an independent exclusion zone
    const exclusionZone = await prisma.coverageZone.create({
      data: {
        branchId: branch.id,
        name: 'Permanent Military Restricted Exclusion',
        zoneType: 'exclusion',
        coverageType: 'circle',
        centerLat: 24.7150,
        centerLng: 46.6750,
        radiusMeters: 300,
        isActive: true,
        priority: 99,
      },
    });

    const neighborhoodPayload = {
      cityCode: 'riyadh',
      districtCodes: ['3802', '3401'],
    };

    const savedZones = await WashersService.saveBranchNeighborhoodCoverage(
      ownerContext,
      branch.id,
      neighborhoodPayload
    );

    expect(savedZones).toHaveLength(3);
    const activeInclusions = savedZones.filter((z) => z.zoneType === 'inclusion');
    expect(activeInclusions).toHaveLength(2);
    expect(activeInclusions.every((z) => z.coverageType === 'polygon')).toBe(true);

    // CRITICAL: Verify exclusion zone remains active and was NOT deactivated
    const currentExclusion = await prisma.coverageZone.findUnique({ where: { id: exclusionZone.id } });
    expect(currentExclusion.isActive).toBe(true);

    // Verify mode is 'neighborhoods' (exclusion does not cause mixed_conflict)
    const coverageRes = await WashersService.getBranchCoverage(ownerContext, branch.id);
    expect(coverageRes.mode).toBe('neighborhoods');
    expect(coverageRes.isConflict).toBe(false);

    // Verify canonical snapshot is persisted, NOT display geometry
    const z1 = activeInclusions[0];
    expect(z1.geoJson.properties.snapshottedAt).toBeDefined();
    expect(z1.geoJson.properties.cityCode).toBe('riyadh');
    expect(z1.geoJson.properties.districtCode).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 3: Mode Switch — Neighborhoods -> Circle (Preserving Exclusion Zones)
  // ──────────────────────────────────────────────────────────────────────────
  test('3. Should switch from Neighborhoods back to Circle, preserving active exclusion zones', async () => {
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
    expect(savedZones).toHaveLength(2);
    const activeInclusions = savedZones.filter((z) => z.zoneType === 'inclusion');
    expect(activeInclusions).toHaveLength(1);
    expect(activeInclusions[0].coverageType).toBe('circle');

    // Verify exclusion zones remain untouched and active
    const activeExclusions = await prisma.coverageZone.findMany({
      where: { branchId: branch.id, zoneType: 'exclusion', isActive: true },
    });
    expect(activeExclusions.length).toBeGreaterThan(0);

    // Verify mode is 'circle' (exclusion does not cause mixed_conflict)
    const coverageRes = await WashersService.getBranchCoverage(ownerContext, branch.id);
    expect(coverageRes.mode).toBe('circle');
    expect(coverageRes.isConflict).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 4: Auth v2 Coverage Management Permissions
  // ──────────────────────────────────────────────────────────────────────────
  test('4. Should enforce Auth v2 authorization matrix on coverage mutations', async () => {
    const payload = { cityCode: 'riyadh', districtCodes: ['3802'] };

    // A: Washer Owner -> ALLOW
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(ownerContext, branch.id, payload)
    ).resolves.toBeDefined();

    // B: Washer Manager -> ALLOW
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(managerContext, branch.id, payload)
    ).resolves.toBeDefined();

    // C: Branch Manager with 'manage_coverage' permission -> ALLOW
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(branchManagerWithPermContext, branch.id, payload)
    ).resolves.toBeDefined();

    // D: Branch Manager WITHOUT 'manage_coverage' -> DENY (403 PERMISSION_DENIED)
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(branchManagerWithoutPermContext, branch.id, payload)
    ).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });

    // E: Worker Staff -> DENY (403 FORBIDDEN)
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(workerContext, branch.id, payload)
    ).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });

    // F: Driver Staff -> DENY (403 FORBIDDEN)
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(driverContext, branch.id, payload)
    ).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });

    // G: Cross-Washer Staff -> DENY (403 FORBIDDEN)
    await expect(
      WashersService.saveBranchNeighborhoodCoverage(crossWasherContext, branch.id, payload)
    ).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 5: GET Side-Effects ZERO & Mixed Conflict Fail-Closed
  // ──────────────────────────────────────────────────────────────────────────
  test('5. GET coverage causes ZERO writes, detects mixed_conflict, and fails closed during orders', async () => {
    // Manually force an ambiguous mixed inclusion state in DB:
    // Both active circle INCLUSION and active polygon INCLUSION
    await prisma.coverageZone.deleteMany({ where: { branchId: branch.id } });

    await prisma.coverageZone.create({
      data: {
        branchId: branch.id,
        name: 'Simultaneous Circle Inclusion',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 1500,
        isActive: true,
      },
    });

    await prisma.coverageZone.create({
      data: {
        branchId: branch.id,
        name: 'Simultaneous Polygon Inclusion',
        zoneType: 'inclusion',
        coverageType: 'polygon',
        geoJson: { type: 'Polygon', coordinates: [[[46.6, 24.7], [46.7, 24.7], [46.7, 24.8], [46.6, 24.8], [46.6, 24.7]]] },
        isActive: true,
      },
    });

    // Snapshot pre-state:
    const preZones = await prisma.coverageZone.findMany({ where: { branchId: branch.id } });
    expect(preZones).toHaveLength(2);
    expect(preZones.every((z) => z.isActive === true)).toBe(true);

    // Call GET /api/branches/:branchId/coverage
    const getRes = await WashersService.getBranchCoverage(ownerContext, branch.id);

    // Verify GET response:
    expect(getRes.mode).toBe('mixed_conflict');
    expect(getRes.isConflict).toBe(true);
    expect(getRes.conflictNotice).toBe('يوجد إعداد نطاق قديم غير متوافق، اختر طريقة النطاق واحفظها');

    // CRITICAL: Verify ZERO DB WRITES occurred during GET
    const postZones = await prisma.coverageZone.findMany({ where: { branchId: branch.id } });
    expect(postZones).toHaveLength(2);
    expect(postZones.every((z) => z.isActive === true)).toBe(true);
    expect(postZones[0].updatedAt.getTime()).toBe(preZones[0].updatedAt.getTime());
    expect(postZones[1].updatedAt.getTime()).toBe(preZones[1].updatedAt.getTime());

    // CRITICAL: Order placement during mixed conflict must FAIL CLOSED
    const conflictedInput = makeInput({
      pickup: { lat: 24.7136, lng: 46.6753 },
      delivery: { lat: 24.7136, lng: 46.6753 },
    });
    await expect(
      OrderService.createOrder({ actorContext: customerContext, input: conflictedInput })
    ).rejects.toMatchObject({
      status: 422,
      code: 'BRANCH_OUT_OF_COVERAGE',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 6: Clear Coverage & None Mode
  // ──────────────────────────────────────────────────────────────────────────
  test('6. Should transition to mode none and fail closed when coverage is cleared', async () => {
    await WashersService.clearBranchCoverage(ownerContext, branch.id);

    const activeZones = await prisma.coverageZone.findMany({ where: { branchId: branch.id, isActive: true } });
    expect(activeZones).toHaveLength(0);

    const coverageRes = await WashersService.getBranchCoverage(ownerContext, branch.id);
    expect(coverageRes.mode).toBe('none');
    expect(coverageRes.isConflict).toBe(false);

    const clearedInput = makeInput({
      pickup: { lat: 24.7136, lng: 46.6753 },
      delivery: { lat: 24.7136, lng: 46.6753 },
    });
    await expect(
      OrderService.createOrder({ actorContext: customerContext, input: clearedInput })
    ).rejects.toMatchObject({
      status: 422,
      code: 'BRANCH_OUT_OF_COVERAGE',
    });
  });
});
