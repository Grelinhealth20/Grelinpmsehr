/**
 * Zod validation middleware. Validates and *replaces* req[part] with the parsed
 * (and thus sanitized/typed) result, rejecting unknown fields by default.
 */
export function validate(schema, part = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed.',
        code: 'VALIDATION_ERROR',
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req[part] = result.data;
    next();
  };
}
