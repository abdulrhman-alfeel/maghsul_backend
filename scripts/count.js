import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const cIdentity = await prisma.identity.count();
  const cWasher = await prisma.washer.count();
  const cBranch = await prisma.branch.count();
  const cCustomer = await prisma.customerMembership.count();
  const cStaff = await prisma.staffMembership.count();
  const cPerm = await prisma.permission.count();
  const cRolePerm = await prisma.rolePermission.count();
  const cAppClient = await prisma.appClient.count();

  console.log('Database Counts:');
  console.log(`Identity: ${cIdentity}`);
  console.log(`Washer: ${cWasher}`);
  console.log(`Branch: ${cBranch}`);
  console.log(`CustomerMembership: ${cCustomer}`);
  console.log(`StaffMembership: ${cStaff}`);
  console.log(`Permission: ${cPerm}`);
  console.log(`RolePermission: ${cRolePerm}`);
  console.log(`AppClient: ${cAppClient}`);
}
main().finally(() => prisma.$disconnect());
