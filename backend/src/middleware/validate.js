/**
 * Zod validation middleware. Validates and *replaces* req[part] with the parsed
 * (and thus sanitized/typed) result, rejecting unknown fields by default.
 *
 * For `params` the parsed values are MERGED over the existing route params rather
 * than replacing them — a params schema typically declares only the id it cares
 * about (e.g. `uuid`), and a hard replace would strip sibling path params from the
 * same route (e.g. `:docUuid` on `/:uuid/documents/:docUuid`), leaving the handler
 * with `undefined`. Merging keeps every route param while still applying the
 * schema's validation/coercion to the declared ones. Body/query keep the strict
 * replace so unknown client-supplied fields are dropped.
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
    req[part] = part === 'params' ? { ...req[part], ...result.data } : result.data;
    next();
  };
}
