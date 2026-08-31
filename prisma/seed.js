import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Start seeding...');

  // 1. Create 3 Washers
  const washersData = [
    { id: 'washer_seed_1', name: 'مغسلة النقاء', phone: '0500000001' },
    { id: 'washer_seed_2', name: 'مغسلة الفجر', phone: '0500000002' },
    { id: 'washer_seed_3', name: 'مغسلة السريع', phone: '0500000003' },
  ];

  for (const w of washersData) {
    await prisma.washer.upsert({
      where: { id: w.id },
      update: {},
      create: w
    });
  }

  // Branches
  const branchesData = [
    { id: 'branch_seed_1', washerId: 'washer_seed_1', name: 'فرع النقاء الرئيسي', lat: 24.7136, lng: 46.6753 },
    { id: 'branch_seed_2', washerId: 'washer_seed_1', name: 'فرع النقاء الشمالي', lat: 24.7500, lng: 46.7000 },
    { id: 'branch_seed_3', washerId: 'washer_seed_2', name: 'فرع الفجر 1', lat: 24.7200, lng: 46.6800 },
    { id: 'branch_seed_4', washerId: 'washer_seed_3', name: 'فرع السريع 1', lat: 24.7300, lng: 46.6900 },
  ];

  for (const b of branchesData) {
    await prisma.branch.upsert({
      where: { id: b.id },
      update: {},
      create: b
    });
  }

  // 2. Create 7 Identities (Mixed roles)
  const identitiesData = [
    { phone: '966500000001', name: 'مالك النقاء', role: 'washer_owner', washerId: 'washer_seed_1' },
    { phone: '966500000002', name: 'مدير فرع النقاء', role: 'branch_manager', washerId: 'washer_seed_1' },
    { phone: '966500000003', name: 'عامل النقاء', role: 'worker', washerId: 'washer_seed_1' },
    { phone: '966500000004', name: 'سائق النقاء', role: 'driver', washerId: 'washer_seed_1' },
    { phone: '966500000005', name: 'مالك الفجر', role: 'washer_owner', washerId: 'washer_seed_2' },
    { phone: '966500000006', name: 'عميل 1', role: 'customer', washerId: 'washer_seed_1' },
    { phone: '966500000007', name: 'عميل 2', role: 'customer', washerId: 'washer_seed_2' },
  ];

  for (const idData of identitiesData) {
    const identity = await prisma.identity.upsert({
      where: { phone: idData.phone },
      update: {},
      create: { phone: idData.phone, name: idData.name }
    });

    if (idData.role === 'customer') {
      await prisma.customerMembership.upsert({
        where: { identityId_washerId: { identityId: identity.id, washerId: idData.washerId } },
        update: {},
        create: {
          identityId: identity.id,
          washerId: idData.washerId,
          displayName: idData.name
        }
      });
    } else {
      await prisma.staffMembership.upsert({
        where: { identityId_washerId: { identityId: identity.id, washerId: idData.washerId } },
        update: {},
        create: {
          identityId: identity.id,
          washerId: idData.washerId,
          role: idData.role,
          hasFullWasherAccess: idData.role === 'washer_owner',
        }
      });
    }
  }

  // 3. Permissions
  const permissions = [
    { code: 'view_orders', name: 'عرض الطلبات', scope: 'branch' },
    { code: 'receive_orders', name: 'استقبال الطلبات', scope: 'branch' },
    { code: 'change_order_status', name: 'تغيير حالة الطلب', scope: 'branch' },
    { code: 'cancel_order', name: 'إلغاء الطلب', scope: 'branch' },
    { code: 'sort_order_items', name: 'فرز بنود الطلب', scope: 'branch' },
    { code: 'set_order_details', name: 'تحديد تفاصيل الطلب', scope: 'branch' },
    { code: 'manage_services', name: 'إدارة الخدمات', scope: 'branch' },
    { code: 'manage_prices', name: 'إدارة الأسعار', scope: 'branch' },
    { code: 'manage_promotions', name: 'إدارة العروض', scope: 'branch' },
    { code: 'manage_staff', name: 'إدارة الموظفين', scope: 'washer' },
    { code: 'invite_staff', name: 'دعوة موظفين', scope: 'washer' },
    { code: 'manage_branch_settings', name: 'إدارة إعدادات الفرع', scope: 'branch' },
    { code: 'manage_branch_hours', name: 'إدارة أوقات العمل', scope: 'branch' },
    { code: 'manage_coverage', name: 'إدارة نطاق التغطية', scope: 'branch' },
    { code: 'manage_payment_methods', name: 'إدارة طرق الدفع', scope: 'branch' },
    { code: 'view_reports', name: 'عرض التقارير', scope: 'branch' },
    { code: 'view_financial_reports', name: 'التقارير المالية', scope: 'washer' },
    { code: 'manage_notifications', name: 'إدارة الإشعارات', scope: 'branch' },
    { code: 'manage_settings', name: 'إدارة الإعدادات', scope: 'branch' },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: {},
      create: perm
    });
  }

  // Role Permissions mapping
  const branchManagerPerms = ['view_orders', 'receive_orders', 'change_order_status', 'manage_branch_settings'];
  for (const pCode of branchManagerPerms) {
    const perm = await prisma.permission.findUnique({ where: { code: pCode } });
    if (perm) {
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role: 'branch_manager', permissionId: perm.id } },
        update: {},
        create: { role: 'branch_manager', permissionId: perm.id }
      });
    }
  }

  // 4. Products & Overrides
  const products = [
    { id: 'prod_seed_1', name: 'قميص', type: 'clothes', defaultImage: 'shirt.png' },
    { id: 'prod_seed_2', name: 'بنطلون', type: 'clothes', defaultImage: 'pants.png' }
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: {},
      create: p
    });
  }

  // 5. App Clients
  const appClients = [
    { washerId: 'washer_seed_1', appKey: 'naqaa-main-client', appName: 'تطبيق النقاء', platform: 'both' },
    { washerId: 'washer_seed_2', appKey: 'fajr-main-client', appName: 'تطبيق الفجر', platform: 'both' },
    { washerId: 'washer_seed_1', appKey: 'com.laundry.customer', appName: 'تطبيق النقاء', platform: 'both' },
    { washerId: 'washer_seed_2', appKey: 'com.fajr.customer', appName: 'تطبيق الفجر', platform: 'both' },
    { washerId: 'washer_seed_3', appKey: 'com.lamaa.customer', appName: 'تطبيق السريع', platform: 'both' },
    { washerId: 'washer_seed_1', appKey: 'com.alwafa.customer', appName: 'تطبيق الوفاء', platform: 'both' },
  ];

  for (const ac of appClients) {
    await prisma.appClient.upsert({
      where: { appKey: ac.appKey },
      update: {},
      create: ac
    });
  }

  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
