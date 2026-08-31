import prisma from './src/config/db.js';

async function main() {
  try {
    await prisma.order.create({
      data: {
        washerId: "foo",
        branchId: null,
      }
    });
  } catch(e) {
    console.error(e.message);
  }
}
main();
