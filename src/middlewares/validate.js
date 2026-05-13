import { fail } from '../helpers/apiResponse.js';

export default function validate(schema) {
  return (req, res, next) => {
    const errors = [];

    if (schema.body) {
      const { error, value } = schema.body(req.body);
      if (error) errors.push(error);
      else req.body = value;
    }

    if (schema.params) {
      const { error, value } = schema.params(req.params);
      if (error) errors.push(error);
      else req.params = value;
    }

    if (schema.query) {
      const { error, value } = schema.query(req.query);
      if (error) errors.push(error);
      else req.query = value;
    }

    if (errors.length) {
      return fail(res, 'Validation error', 400, errors);
    }

    next();
  };
}
