import WashersService from '../washers/washers.service.js';
import { ok } from '../../helpers/apiResponse.js';

const CustomerController = {
  async listBranches(req, res) {
    const { washerId } = req.customerContext;
    return ok(res, await WashersService.listBranches(washerId), 'Washer branches list');
  }
};

export default CustomerController;

