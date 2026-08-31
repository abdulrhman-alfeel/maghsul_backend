import WebhookService from './webhook.service.js';
import { ok } from '../../helpers/apiResponse.js';

const WebhookController = {
  async handleMoyasarWebhook(req, res) {
    const result = await WebhookService.receiveMoyasarWebhook(req.body);
    return ok(res, result, 'Webhook received');
  }
};

export default WebhookController;
