import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const washer = await prisma.washer.upsert({
    where: { id: 'washer_seed_main' },
    update: {},
    create: { id: 'washer_seed_main', name: 'مغسلة النقاء', phone: '0500000001' }
  });

  await prisma.user.upsert({
    where: { phone: '966500000001' },
    update: { role: 'washer_admin', washerId: washer.id, name: 'مدير المغسلة' },
    create: { phone: '966500000001', name: 'مدير المغسلة', role: 'washer_admin', washerId: washer.id }
  });

  await prisma.user.upsert({
    where: { phone: '966500000002' },
    update: { role: 'driver', washerId: washer.id, name: 'موصل 1' },
    create: { phone: '966500000002', name: 'موصل 1', role: 'driver', washerId: washer.id }
  });

  await prisma.user.upsert({
    where: { phone: '966500000003' },
    update: { role: 'worker', washerId: washer.id, name: 'عامل 1' },
    create: { phone: '966500000003', name: 'عامل 1', role: 'worker', washerId: washer.id }
  });

  await prisma.user.upsert({
    where: { phone: '966500000004' },
    update: { role: 'customer', name: 'عميل تجريبي' },
    create: { phone: '966500000004', name: 'عميل تجريبي', role: 'customer' }
  });

  const zones = [
    { id: 'zone_seed_1', washerId: washer.id, name: 'حي النرجس', city: 'الرياض' },
    { id: 'zone_seed_2', washerId: washer.id, name: 'حي الياسمين', city: 'الرياض' },
    { id: 'zone_seed_3', washerId: washer.id, name: 'حي الصحافة', city: 'الرياض' }
  ];

  for (const zone of zones) {
    await prisma.zone.upsert({ where: { id: zone.id }, update: zone, create: zone });
  }

  const products = [
    { id: 'prod_seed_1', name: 'قميص', type: 'clothes', defaultImage: 'shirt.png' },
    { id: 'prod_seed_2', name: 'بنطلون', type: 'clothes', defaultImage: 'pants.png' },
    { id: 'prod_seed_3', name: 'ثوب', type: 'clothes', defaultImage: 'thobe.png' },
    { id: 'prod_seed_4', name: 'بطانية', type: 'home', defaultImage: 'blanket.png' }
  ];

  for (const product of products) {
    await prisma.product.upsert({ where: { id: product.id }, update: product, create: product });
  }

  const washerProducts = [
    { id: 'wp_seed_1', washerId: washer.id, productId: 'prod_seed_1', price: 1200 },
    { id: 'wp_seed_2', washerId: washer.id, productId: 'prod_seed_2', price: 1500 },
    { id: 'wp_seed_3', washerId: washer.id, productId: 'prod_seed_3', price: 1800 },
    { id: 'wp_seed_4', washerId: washer.id, productId: 'prod_seed_4', price: 3500 }
  ];

  for (const wp of washerProducts) {
    await prisma.washerProduct.upsert({ where: { id: wp.id }, update: wp, create: wp });
  }

  console.log('Seed completed');
}

main().finally(async () => {
  await prisma.$disconnect();
});
