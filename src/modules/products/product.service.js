import prisma from '../../config/db.js';
import ProductModel from './product.model.js';
import ApiError from '../../helpers/apiError.js';
import { toWesternDigits } from '../../utils/digits.js';
import CacheService from '../../services/cache.service.js';

const ProductService = {
  async getDefaultProducts() {
    const cacheKey = 'products:defaults';
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const products = await ProductModel.findDefaults();
    await CacheService.set(cacheKey, products, 86400); // 24 hours
    return products;
  },

  async getWasherProducts(washerId) {
    const cacheKey = `products:washer:${washerId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const products = await ProductModel.findWasherProducts(washerId);
    await CacheService.set(cacheKey, products, 3600); // 1 hour
    return products;
  },

  async saveWasherProduct(washerId, body) {
    const washer = await prisma.washer.findUnique({ where: { id: washerId } });
    if (!washer) throw new ApiError(404, 'Washer not found');

    const { id, productId, price, customName, customImage } = body;

    // Price validation
    if (price === undefined || price === null) {
      throw new ApiError(400, 'price is required');
    }
    const priceStr = typeof price === 'number' ? String(price) : toWesternDigits(String(price ?? ''));
    const priceNum = Number(priceStr);
    if (!Number.isFinite(priceNum) || !Number.isInteger(priceNum) || priceNum < 0) {
      throw new ApiError(400, 'price must be a valid non-negative integer');
    }
    const priceInt = priceNum;

    let result;
    if (id) {
      const existing = await prisma.washerProduct.findUnique({ where: { id } });
      if (!existing || existing.washerId !== washerId) {
        throw new ApiError(404, 'Washer product not found');
      }

      const updateData = { price: priceInt };
      if (!existing.productId) {
        // Custom product edit
        if (customName !== undefined) {
          const nameTrimmed = typeof customName === 'string' ? customName.trim() : '';
          if (!nameTrimmed) throw new ApiError(400, 'customName must be non-empty for custom product');
          updateData.customName = nameTrimmed;
        }
        if (customImage !== undefined) {
          updateData.customImage = typeof customImage === 'string' && customImage.trim() ? customImage.trim() : null;
        }
      }
      result = await ProductModel.updateWasherProduct(id, updateData);
    } else if (productId) {
      // Platform product customization
      const prod = await prisma.product.findUnique({ where: { id: productId } });
      if (!prod) throw new ApiError(404, 'Platform product not found');

      const existing = await ProductModel.findWasherProductByWasherAndProduct(washerId, productId);
      if (existing) {
        result = await ProductModel.updateWasherProduct(existing.id, { price: priceInt });
      } else {
        result = await ProductModel.createWasherProduct({
          washerId,
          productId,
          price: priceInt
        });
      }
    } else {
      // Independent custom product
      const nameToSave = typeof customName === 'string' ? customName.trim() : null;
      if (!nameToSave) throw new ApiError(400, 'customName is required for custom product');

      result = await ProductModel.createWasherProduct({
        washerId,
        price: priceInt,
        customName: nameToSave,
        customImage: typeof customImage === 'string' && customImage.trim() ? customImage.trim() : null
      });
    }

    // Invalidate washer products cache
    await CacheService.del(`products:washer:${washerId}`);

    return result;
  }
};

export default ProductService;
