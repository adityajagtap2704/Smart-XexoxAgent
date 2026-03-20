const { AppError } = require('../utils/helpers');

exports.validateBody = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    const messages = error.details.map((d) => d.message).join('. ');
    return next(new AppError(messages, 400));
  }
  req.body = value;
  next();
};

exports.validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query, { abortEarly: false, stripUnknown: true });
  if (error) {
    const messages = error.details.map((d) => d.message).join('. ');
    return next(new AppError(messages, 400));
  }
  req.query = value;
  next();
};
