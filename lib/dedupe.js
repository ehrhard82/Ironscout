// The same machine often shows up twice: IronPlanet + Marketplace-E, a dealer's listing
// mirrored on Machinio, or the same URL with different tracking tags. Collapse rows that
// share a title and price into one card and note the other places it's listed.
const key = (r) => `${String(r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${Math.round(Number(r.price) / 50)}`;

function dedupe(rows, better = (a, b) => (Number(b.deal_score) || 0) - (Number(a.deal_score) || 0)) {
  const seen = new Map();
  for (const r of rows) {
    const k = key(r);
    const cur = seen.get(k);
    if (!cur) { seen.set(k, r); continue; }
    const [keep, drop] = better(cur, r) <= 0 ? [cur, r] : [r, cur];
    keep.also_on = [...new Set([...(keep.also_on || []), ...(drop.also_on || []), drop.source].filter(s => s && s !== keep.source))];
    seen.set(k, keep);
  }
  return rows.filter(r => seen.get(key(r)) === r);
}
module.exports = { dedupe };
