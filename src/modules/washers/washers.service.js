import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';
import { signToken } from '../../utils/jwt.js';
import { toWesternDigits } from '../../utils/digits.js';

function _isWasherAdmin(user, washerId) {
  if (!user?.washerId || user.washerId !== washerId) return false;
  return ['washer_admin', 'washer_owner', 'washer_manager', 'branch_manager', 'admin'].includes(user.role);
}

function normalizePhone(raw) {
  if (!raw) return raw;
  let phone = toWesternDigits(String(raw).trim());
  if (phone.startsWith('+966')) phone = phone.slice(4);
  else if (phone.startsWith('00966')) phone = phone.slice(5);
  if (phone.startsWith('0')) phone = phone.slice(1);
  return phone;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function _formatOrder(order) {
  if (!order) return order;
  const identity = order.customerMembership?.identity;
  return {
    ...order,
    customer: identity
      ? {
          id: identity.id,
          name: identity.name || 'عميل',
          phone: identity.phone || '',
        }
      : null,
  };
}

async function pagedOrders(whereClause, orderBySpec, opts = {}) {
  const limitRaw = Number(opts.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = opts.afterId ? String(opts.afterId).trim() : null;
  const orderBy = Array.isArray(orderBySpec) ? orderBySpec : [orderBySpec];
  const hasId = orderBy.some((o) => 'id' in o);
  const finalOrderBy = hasId ? orderBy : [...orderBy, { id: 'asc' }];

  const rows = await prisma.order.findMany({
    where: whereClause,
    include: {
      items: true,
      customerMembership: {
        include: { identity: true }
      }
    },
    orderBy: finalOrderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
  });

  const hasMore = rows.length > limit;
  const rawItems = hasMore ? rows.slice(0, limit) : rows;
  const items = rawItems.map(_formatOrder);
  const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
  return { items, nextCursor };
}

import CacheService from '../../services/cache.service.js';
import GeoService from '../geo/geo.service.js';
import { PermissionService } from '../auth/services/permission.service.js';

/**
 * Strictly validates coverage mutation authorization under Auth v2.
 * - Enforces washer ownership: authContext.washerId === branch.washerId
 * - Allows washer_owner and washer_manager (washer-level management)
 * - Allows branch_manager ONLY if assigned to this branch AND PermissionService grants 'manage_coverage'
 * - Strictly denies worker, driver, and any cross-washer access.
 */
async function _assertCoverageStaffAuthorization(authContext, branch) {
  if (!authContext?.washerId || authContext.washerId !== branch.washerId) {
    throw new ApiError(403, 'FORBIDDEN', 'Forbidden: Cross-washer coverage access denied');
  }

  const role = authContext.staffRole || authContext.role;

  // 1. washer_owner and washer_manager have washer-wide coverage authority
  if (role === 'washer_owner' || role === 'washer_manager') {
    return true;
  }

  // 2. branch_manager is strictly scoped to assigned branch AND requires 'manage_coverage'
  if (role === 'branch_manager') {
    if (!authContext.branchId || authContext.branchId !== branch.id) {
      throw new ApiError(403, 'FORBIDDEN', 'Forbidden: Branch managers can only manage their assigned branch');
    }
    if (authContext.staffMembershipId) {
      const perms = await PermissionService.resolvePermissions(
        authContext.washerId,
        authContext.staffMembershipId,
        branch.id
      );
      if (perms.has('manage_coverage')) {
        return true;
      }
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Forbidden: Missing canonical manage_coverage permission');
  }

  // 3. All other roles (worker, driver, etc.) are strictly denied
  throw new ApiError(403, 'FORBIDDEN', 'Forbidden: Staff role is not authorized to manage coverage');
}

const WashersService = {
  /**
   * إنشاء مستخدم جديد بصفة أدمن ثم إنشاء المغسلة وربطها به — كل ذلك في استدعاء واحد.
   * body: adminPhone (إجباري), adminName (اختياري), name (اسم المغسلة إجباري), phone (هاتف المغسلة اختياري)
   */
  async createWasher(body) {
    const { adminPhone, adminName, name: washerName, phone: washerPhone, address, lat, lng } = body;
    const normalizedAdminPhone = normalizePhone(adminPhone);
    const normalizedWasherPhone = washerPhone ? normalizePhone(washerPhone) : null;

    const washer = await prisma.washer.create({
      data: {
        name: washerName,
        phone: normalizedWasherPhone,
        address: address || null,
        serviceLat: lat ? Number(lat) : null,
        serviceLng: lng ? Number(lng) : null,
      }
    });

    // إنشاء الفرع الرئيسي تلقائياً للمغسلة
    const mainBranch = await prisma.branch.create({
      data: {
        name: 'الفرع الرئيسي',
        washerId: washer.id,
        address: address || null,
        lat: lat ? Number(lat) : null,
        lng: lng ? Number(lng) : null,
        status: 'active',
        isOpen: true,
        acceptingOrders: true,
      }
    });

    const identity = await prisma.identity.upsert({
      where: { phone: normalizedAdminPhone },
      update: { name: adminName || undefined },
      create: { phone: normalizedAdminPhone, name: adminName || null }
    });

    const staffMembership = await prisma.staffMembership.upsert({
      where: { identityId_washerId: { identityId: identity.id, washerId: washer.id } },
      update: { role: 'washer_owner', status: 'active', hasFullWasherAccess: true },
      create: { identityId: identity.id, washerId: washer.id, role: 'washer_owner', status: 'active', hasFullWasherAccess: true }
    });

    // ربط الفرع بصلاحيات الوصول
    await prisma.branchAccess.upsert({
      where: { staffMembershipId_branchId: { staffMembershipId: staffMembership.id, branchId: mainBranch.id } },
      update: {},
      create: { staffMembershipId: staffMembership.id, branchId: mainBranch.id }
    });

    const user = {
      id: identity.id,
      phone: identity.phone,
      name: identity.name,
      role: staffMembership.role,
      washerId: washer.id,
      branchId: mainBranch.id
    };

    const token = signToken({ userId: user.id, role: user.role, washerId: user.washerId, branchId: mainBranch.id });
    return { washer, branch: mainBranch, user, token };
  },

  /** جلب كل المغاسل مع Pagination بالـ cursor */
  async listWashersPaged(query = {}) {
    const limitRaw = Number(query.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
    const cursor = query.cursor ? String(query.cursor) : null;

    const rows = await prisma.washer.findMany({
      where: { status: 'active' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? String(items[items.length - 1]?.id ?? '') : null;

    return { items, nextCursor };
  },

  /**
   * List active branches for a washer (public — used by customer app for branch selection).
   */
  async listBranches(washerId) {
    const cacheKey = `branches:${washerId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const branches = await prisma.branch.findMany({
      where: { washerId, status: 'active' },
      select: { id: true, name: true, status: true, address: true, lat: true, lng: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });

    await CacheService.set(cacheKey, branches, 600); // cache 10 min
    return branches;
  },

  /**
   * Get coverage zones for a specific branch.
   * Requires staff context with access to the branch's washer.
   * Strictly READ-ONLY with ZERO side effects.
   * Resolves mode deterministically from active inclusion zones.
   */
  async getBranchCoverage(authContext, branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new ApiError(404, 'branch_not_found', 'Branch not found');

    // Authorization: user must belong to the branch's washer
    if (!authContext.washerId || authContext.washerId !== branch.washerId) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const isOwnerOrManager = ['washer_owner', 'washer_manager'].includes(authContext.staffRole || authContext.role);
    if (!isOwnerOrManager && authContext.branchId && authContext.branchId !== branchId) {
      throw new ApiError(403, 'forbidden', 'Forbidden: Scope restricted to assigned branch');
    }

    const cacheKey = `coverage:branch:${branchId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const zones = await prisma.coverageZone.findMany({
      where: { branchId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }]
    });

    // Determine mode ONLY from active INCLUSION zones:
    // Exclusions remain independent and do not count as competing configuration modes.
    const activeInclusions = zones.filter((z) => z.isActive && z.zoneType === 'inclusion');
    const activeCircles = activeInclusions.filter((z) => z.coverageType === 'circle');
    const activePolygons = activeInclusions.filter((z) =>
      ['polygon', 'multi_polygon'].includes(z.coverageType)
    );

    let mode = 'none';
    if (activeCircles.length > 0 && activePolygons.length === 0) {
      mode = 'circle';
    } else if (activeCircles.length === 0 && activePolygons.length > 0) {
      mode = 'neighborhoods';
    } else if (activeCircles.length === 0 && activePolygons.length === 0) {
      mode = 'none';
    } else if (activeCircles.length > 0 && activePolygons.length > 0) {
      mode = 'mixed_conflict';
    }

    const isConflict = mode === 'mixed_conflict';
    const conflictNotice = isConflict
      ? 'يوجد إعداد نطاق قديم غير متوافق، اختر طريقة النطاق واحفظها'
      : null;

    const result = {
      mode,
      isConflict,
      conflictNotice,
      zones
    };

    await CacheService.set(cacheKey, result, 3600);
    return result;
  },

  /**
   * Save Circle coverage zones for a branch.
   * Atomically deactivates active neighborhood INCLUSION zones while preserving exclusion zones.
   * Atomically commits new circle zones and invalidates cache.
   */
  async replaceBranchCoverage(authContext, branchId, zones) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new ApiError(404, 'branch_not_found', 'Branch not found');

    await _assertCoverageStaffAuthorization(authContext, branch);

    // Validate each zone
    if (!Array.isArray(zones)) throw new ApiError(400, 'invalid_zones', 'zones must be an array');

    const validZoneTypes = ['inclusion', 'exclusion'];
    const validCoverageTypes = ['circle', 'polygon', 'multi_polygon'];

    for (const z of zones) {
      if (z.zoneType && !validZoneTypes.includes(z.zoneType)) {
        throw new ApiError(400, 'invalid_zone_type', `Invalid zoneType: ${z.zoneType}`);
      }
      const ct = z.coverageType || 'circle';
      if (!validCoverageTypes.includes(ct)) {
        throw new ApiError(400, 'invalid_coverage_type', `Invalid coverageType: ${ct}`);
      }

      if (ct === 'circle') {
        if (z.centerLat === undefined || z.centerLat === null || z.centerLng === undefined || z.centerLng === null) {
          throw new ApiError(400, 'invalid_circle', 'Circle zones require centerLat and centerLng');
        }
        if (typeof z.centerLat !== 'number' || z.centerLat < -90 || z.centerLat > 90) {
          throw new ApiError(400, 'invalid_coordinates', 'centerLat must be a number between -90 and 90');
        }
        if (typeof z.centerLng !== 'number' || z.centerLng < -180 || z.centerLng > 180) {
          throw new ApiError(400, 'invalid_coordinates', 'centerLng must be a number between -180 and 180');
        }
        if (z.radiusMeters !== undefined && (typeof z.radiusMeters !== 'number' || z.radiusMeters <= 0)) {
          throw new ApiError(400, 'invalid_radius', 'radiusMeters must be a positive number');
        }
      }

      if (ct === 'polygon' || ct === 'multi_polygon') {
        if (!z.geoJson) {
          throw new ApiError(400, 'invalid_polygon', 'Polygon/MultiPolygon zones require geoJson');
        }
        const raw = typeof z.geoJson === 'string' ? JSON.parse(z.geoJson) : z.geoJson;
        const coords = raw.coordinates || raw;
        if (!Array.isArray(coords)) {
          throw new ApiError(400, 'invalid_polygon', 'geoJson must contain coordinates array');
        }
        if (ct === 'polygon') {
          if (!Array.isArray(coords[0]) || coords[0].length < 4) {
            throw new ApiError(400, 'invalid_polygon', 'Polygon outer ring must have at least 4 coordinate pairs');
          }
        }
      }
    }

    // Atomic switch to Circle:
    // 1. Deactivate active neighborhood INCLUSION zones (preserve exclusions!)
    // 2. Deactivate previous circle INCLUSION zones (preserve exclusions!)
    // 3. Create new circle zones
    await prisma.$transaction(async (tx) => {
      await tx.coverageZone.updateMany({
        where: {
          branchId,
          zoneType: 'inclusion',
          coverageType: { in: ['polygon', 'multi_polygon'] },
          isActive: true
        },
        data: { isActive: false }
      });

      await tx.coverageZone.updateMany({
        where: {
          branchId,
          zoneType: 'inclusion',
          coverageType: 'circle',
          isActive: true
        },
        data: { isActive: false }
      });

      if (zones.length > 0) {
        await tx.coverageZone.createMany({
          data: zones.map((z) => ({
            branchId,
            name: z.name || 'نطاق دائري',
            zoneType: z.zoneType || 'inclusion',
            coverageType: z.coverageType || 'circle',
            bbMinLat: z.bbMinLat ?? null,
            bbMaxLat: z.bbMaxLat ?? null,
            bbMinLng: z.bbMinLng ?? null,
            bbMaxLng: z.bbMaxLng ?? null,
            centerLat: z.centerLat ?? null,
            centerLng: z.centerLng ?? null,
            radiusMeters: z.radiusMeters ?? null,
            geoJson: z.geoJson ?? null,
            isActive: z.isActive !== undefined ? z.isActive : true,
            priority: z.priority ?? 10
          }))
        });
      }
    });

    // Invalidate cache
    await CacheService.del(`coverage:branch:${branchId}`);

    return prisma.coverageZone.findMany({
      where: { branchId, isActive: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }]
    });
  },

  /**
   * Save Neighborhood (precise polygon) coverage for a branch.
   * Resolves canonical geometry from authoritative dataset.
   * Atomically deactivates active circle INCLUSION zones (preserves exclusions).
   * Creates exact canonical CoverageZone snapshots.
   */
  async saveBranchNeighborhoodCoverage(authContext, branchId, { cityCode, districtCodes }) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new ApiError(404, 'branch_not_found', 'Branch not found');

    await _assertCoverageStaffAuthorization(authContext, branch);

    const targetCity = String(cityCode || '').trim().toLowerCase();
    if (targetCity !== 'riyadh') {
      throw new ApiError(400, 'unsupported_city', 'Only cityCode "riyadh" is currently supported');
    }

    // Lookup canonical polygons from GeoService (validates all districtCodes against authoritative dataset)
    const canonicalFeatures = GeoService.getCanonicalFeaturesByDistrictCodes(targetCity, districtCodes);

    const snapshotZones = canonicalFeatures.map((feature) => {
      const coords = feature.geometry.coordinates;
      const bbox = GeoService.computeBoundingBox(coords);
      const districtCode = String(feature.properties.districtCode || feature.id);
      const nameAr = feature.properties.nameAr || `حي ${districtCode}`;

      return {
        branchId,
        name: nameAr,
        zoneType: 'inclusion',
        coverageType: 'polygon',
        bbMinLat: bbox.bbMinLat,
        bbMaxLat: bbox.bbMaxLat,
        bbMinLng: bbox.bbMinLng,
        bbMaxLng: bbox.bbMaxLng,
        geoJson: {
          type: 'Polygon',
          coordinates: coords,
          properties: {
            districtCode,
            nameAr,
            nameEn: feature.properties.nameEn || null,
            municipalityNameAr: feature.properties.municipalityNameAr || null,
            cityCode: targetCity,
            snapshottedAt: new Date().toISOString()
          }
        },
        isActive: true,
        priority: 10
      };
    });

    // Atomic transaction:
    // 1. Deactivate active circle INCLUSION zones (preserve exclusions!)
    // 2. Deactivate previous polygon INCLUSION zones (preserve exclusions!)
    // 3. Insert new canonical snapshot zones
    await prisma.$transaction(async (tx) => {
      await tx.coverageZone.updateMany({
        where: {
          branchId,
          zoneType: 'inclusion',
          coverageType: 'circle',
          isActive: true
        },
        data: { isActive: false }
      });

      await tx.coverageZone.updateMany({
        where: {
          branchId,
          zoneType: 'inclusion',
          coverageType: { in: ['polygon', 'multi_polygon'] },
          isActive: true
        },
        data: { isActive: false }
      });

      if (snapshotZones.length > 0) {
        await tx.coverageZone.createMany({
          data: snapshotZones
        });
      }
    });

    // Invalidate Redis cache
    await CacheService.del(`coverage:branch:${branchId}`);

    return prisma.coverageZone.findMany({
      where: { branchId, isActive: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }]
    });
  },

  /**
   * Clear all coverage zones for a branch.
   * Deactivates all active coverage zones (sets isActive: false) and invalidates cache.
   */
  async clearBranchCoverage(authContext, branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new ApiError(404, 'branch_not_found', 'Branch not found');

    await _assertCoverageStaffAuthorization(authContext, branch);

    await prisma.coverageZone.updateMany({
      where: { branchId, isActive: true },
      data: { isActive: false }
    });
    await CacheService.del(`coverage:branch:${branchId}`);

    return { cleared: true };
  },

  async getPaymentMethods(user, washerId) {
    if (!_isWasherAdmin(user, washerId)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }

    const allowed = ['visa', 'apple_pay', 'mada', 'bank_transfer', 'cash', 'tabby', 'tamara'];
    const existing = await prisma.washerPaymentMethod.findMany({ where: { washerId } });
    const map = new Map(existing.map((m) => [m.method, m.enabled]));

    return allowed.map((method) => ({
      method,
      enabled: map.get(method) ?? false
    }));
  },

  async savePaymentMethods(user, washerId, body) {
    if (!_isWasherAdmin(user, washerId)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const methods = Array.isArray(body.methods) ? body.methods : [];

    await prisma.washerPaymentMethod.deleteMany({ where: { washerId } });

    if (methods.length) {
      await prisma.washerPaymentMethod.createMany({
        data: methods.map((m) => ({
          washerId,
          method: m.method,
          enabled: m.enabled !== false
        }))
      });
    }

    return this.getPaymentMethods(user, washerId);
  },

  async getLocation(user, washerId) {
    if (!_isWasherAdmin(user, washerId)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const cacheKey = `washer:location:${washerId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const washer = await prisma.washer.findUnique({ where: { id: washerId } });
    if (!washer) throw new ApiError(404, 'Washer not found');
    const result = {
      lat: washer.serviceLat,
      lng: washer.serviceLng,
      radiusMeters: washer.serviceRadiusMeters ?? 1500
    };
    await CacheService.set(cacheKey, result, 3600);
    return result;
  },

  async saveLocation(user, washerId, body) {
    if (!_isWasherAdmin(user, washerId)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const { lat, lng, radiusMeters } = body;
    const washer = await prisma.washer.update({
      where: { id: washerId },
      data: {
        serviceLat: lat,
        serviceLng: lng,
        serviceRadiusMeters: radiusMeters ?? 1500
      }
    });

    // Invalidate cache
    await CacheService.del(`washer:location:${washerId}`);

    return {
      lat: washer.serviceLat,
      lng: washer.serviceLng,
      radiusMeters: washer.serviceRadiusMeters ?? 1500
    };
  },

  async pendingOrders(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['pending_pickup'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات وصلت للمغسلة — للاستلام (سائق سلّم أو في الطريق) */
  async ordersToReceive(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['driver_arrived_pickup', 'delivered_to_laundry'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات جاهزة للفرز — فقط بعد وصول الطلب للمغسلة أو بدء الفرز */
  async ordersToSort(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      {
        washerId,
        status: {
          in: ['delivered_to_laundry', 'received_in_laundry', 'sorting_in_progress']
        }
      },
      { createdAt: 'asc' },
      opts
    );
  },

  /**
   * طلبات بانتظار إيداع المغسلة: من إنشاء الطلب حتى قبل `delivered_to_laundry`.
   */
  async ordersAwaitingDriverPickup(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    const preHandoffToLaundry = [
      'pending_pickup',
      'pickup_assigned',
      'driver_heading_to_pickup',
      'driver_arrived_pickup'
    ];
    return pagedOrders(
      {
        washerId,
        status: { in: preHandoffToLaundry }
      },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات تم تنفيذها (status = delivered) */
  async ordersCompleted(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: 'delivered' },
      [{ createdAt: 'desc' }, { id: 'desc' }],
      opts
    );
  },

  /** طلبات تم الفرز انتظار السداد */
  async ordersSortedAwaitingPayment(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['sorting_confirmed', 'invoice_generated', 'payment_pending'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** جاري الغسيل */
  async ordersInWash(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['payment_confirmed', 'drying', 'ironing', 'packaging'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات قيد انتظار التوصيل */
  async ordersAwaitingDelivery(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['ready_for_delivery', 'delivery_assigned', 'driver_heading_to_delivery', 'driver_arrived_delivery'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات تم توصيلها للمغسلة (delivered_to_laundry) مع Pagination بالـ cursor */
  async deliveredToLaundryPaged(user, washerId, query = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const limitRaw = Number(query.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
    const cursor = query.cursor ? String(query.cursor) : null;

    const rows = await prisma.order.findMany({
      where: { washerId, status: 'delivered_to_laundry' },
      include: {
        items: true,
        customerMembership: {
          include: { identity: true }
        }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasMore = rows.length > limit;
    const rawItems = hasMore ? rows.slice(0, limit) : rows;
    const items = rawItems.map(_formatOrder);
    const nextCursor = hasMore ? String(items[items.length - 1]?.id ?? '') : null;

    return { items, nextCursor };
  },

  /** طلبات منجزة (تم توصيلها للعميل) status=delivered مع Pagination بالـ cursor */
  async completedPaged(user, washerId, query = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const limitRaw = Number(query.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
    const cursor = query.cursor ? String(query.cursor) : null;

    const rows = await prisma.order.findMany({
      where: { washerId, status: 'delivered' },
      include: {
        items: true,
        customerMembership: {
          include: { identity: true }
        }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasMore = rows.length > limit;
    const rawItems = hasMore ? rows.slice(0, limit) : rows;
    const items = rawItems.map(_formatOrder);
    const nextCursor = hasMore ? String(items[items.length - 1]?.id ?? '') : null;

    return { items, nextCursor };
  },

  async createStaff(user, washerId, body) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    const { phone, name, role } = body;
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) throw new ApiError(400, 'phone_required', 'phone is required');

    const mappedRole = role === 'washer_admin' ? 'washer_manager' : role;
    const identity = await prisma.identity.upsert({
      where: { phone: normalizedPhone },
      update: { name: name || undefined },
      create: { phone: normalizedPhone, name: name || null }
    });

    const staffMembership = await prisma.staffMembership.upsert({
      where: { identityId_washerId: { identityId: identity.id, washerId } },
      update: { role: mappedRole, status: 'active' },
      create: { identityId: identity.id, washerId, role: mappedRole, status: 'active' }
    });

    return {
      id: identity.id,
      phone: identity.phone,
      name: identity.name,
      role: staffMembership.role,
      washerId
    };
  },

  async getSchedule(user, washerId) {
    if (!_isWasherAdmin(user, washerId)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const cacheKey = `washer:schedule:${washerId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const schedule = await prisma.washerSchedule.findMany({
      where: { washerId },
      orderBy: [{ day: 'asc' }, { fromTime: 'asc' }],
    });
    await CacheService.set(cacheKey, schedule, 3600);
    return schedule;
  },

  async saveSchedule(user, washerId, rows) {
    if (!_isWasherAdmin(user, washerId)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }

    await prisma.washerSchedule.deleteMany({ where: { washerId } });

    if (Array.isArray(rows) && rows.length) {
      await prisma.washerSchedule.createMany({
        data: rows.map((r) => ({
          washerId,
          day: r.day,
          fromTime: r.fromTime,
          toTime: r.toTime,
          enabled: r.enabled !== false,
        })),
      });
    }

    // Invalidate cache
    await CacheService.del(`washer:schedule:${washerId}`);

    return prisma.washerSchedule.findMany({
      where: { washerId },
      orderBy: [{ day: 'asc' }, { fromTime: 'asc' }],
    });
  },

  async getProfile(user, washerId) {
    if (!user.washerId || user.washerId !== washerId) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const washer = await prisma.washer.findUnique({ where: { id: washerId } });
    if (!washer) throw new ApiError(404, 'Washer not found');
    return washer;
  },

  async updateProfile(user, washerId, body) {
    if (!_isWasherAdmin(user, washerId)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const {
      name,
      phone,
      email,
      address,
      logoUrl,
      isOpen,
      deliveryEnabled,
      minimumOrderAmount,
      deliveryFee,
      notes
    } = body;

    const normalizedPhone = phone ? normalizePhone(phone) : undefined;

    const washer = await prisma.washer.update({
      where: { id: washerId },
      data: {
        name: name !== undefined ? name : undefined,
        phone: normalizedPhone,
        email: email !== undefined ? email : undefined,
        address: address !== undefined ? address : undefined,
        logoUrl: logoUrl !== undefined ? logoUrl : undefined,
        isOpen: isOpen !== undefined ? !!isOpen : undefined,
        deliveryEnabled: deliveryEnabled !== undefined ? !!deliveryEnabled : undefined,
        minimumOrderAmount: minimumOrderAmount !== undefined ? Number(minimumOrderAmount) : undefined,
        deliveryFee: deliveryFee !== undefined ? Number(deliveryFee) : undefined,
        notes: notes !== undefined ? notes : undefined
      }
    });

    await CacheService.del(`washer:profile:${washerId}`);
    return washer;
  }
};

export default WashersService;
