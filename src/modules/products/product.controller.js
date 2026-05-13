import ProductService from './product.service.js';
import { ok } from '../../helpers/apiResponse.js';

const ProductController = {
  async defaults(req, res) {
    return ok(res, await ProductService.getDefaultProducts(), 'Default products');
  },

  async washerProducts(req, res) {
    return ok(res, await ProductService.getWasherProducts(req.params.washerId), 'Washer products');
  },

  async saveWasherProduct(req, res) {
    return ok(res, await ProductService.saveWasherProduct(req.params.washerId, req.body), 'Washer product saved');
  }
};

export default ProductController;
