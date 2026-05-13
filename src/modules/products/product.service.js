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
    const priceStr = typeof price === 'number' ? String(price) : toWesternDigits(String(price ?? ''));
    const priceInt = Math.round(Number(priceStr));
    if (!Number.isFinite(priceInt) || priceInt < 0) throw new ApiError(400, 'price must be a valid non-negative number');

    let result;
    if (id) {
        // Direct update by ID (works for both predefined and custom)
        const updateData = { price: priceInt };
        if (!productId) {
            // If it's a custom product, allow name/image update too
            if (customName) updateData.customName = customName.trim();
            if (customImage) updateData.customImage = customImage.trim();
            if (!updateData.customName && !customName) {
                // If it's a new custom item without a name, it's invalid
                // but since ID exists, we just update what's changed.
            }
        }
        result = await ProductModel.updateWasherProduct(id, updateData);
    } else if (productId) {
      const existing = await ProductModel.findWasherProductByWasherAndProduct(washerId, productId);
      if (existing) {
        result = await ProductModel.updateWasherProduct(existing.id, { price: priceInt });
      } else {
        result = await ProductModel.createWasherProduct({ washerId, productId, price: priceInt });
      }
    } else {
      const nameToSave = typeof customName === 'string' ? customName.trim() : null;
      if (!nameToSave) throw new ApiError(400, 'customName is required for custom product');

      result = await ProductModel.createWasherProduct({
        washerId,
        price: priceInt,
        customName: nameToSave,
        customImage: typeof customImage === 'string' && customImage.trim() ? customImage.trim() : null
      });
    }

    // Invalidate cache
    await CacheService.del(`products:washer:${washerId}`);
    
    return result;
  }
};

export default ProductService;
