import prisma from '../../config/db.js';

const ProductModel = {
  findDefaults() {
    return prisma.product.findMany({ where: { isDefault: true }, orderBy: { name: 'asc' } });
  },
  findWasherProducts(washerId) {
    return prisma.washerProduct.findMany({ where: { washerId }, include: { product: true } });
  },
  createWasherProduct(data) {
    return prisma.washerProduct.create({ data });
  },
  updateWasherProduct(id, data) {
    return prisma.washerProduct.update({ where: { id }, data });
  },
  findWasherProductByWasherAndProduct(washerId, productId) {
    return prisma.washerProduct.findFirst({ where: { washerId, productId } });
  }
};

export default ProductModel;
