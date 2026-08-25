import { searchPayers } from '../services/payerDirectoryService.js';

/** Typeahead search over the Stedi payer network for the face-sheet Payer picker. */
export async function search(req, res, next) {
  try {
    const q = (req.query.q || '').toString().slice(0, 80).trim();
    const payers = await searchPayers(q, { limit: 10 });
    res.json({ payers });
  } catch (err) { next(err); }
}
