// Buyer matching: which of the broker team's buyers want a given deal?
//
// A want matches a deal when the machine is the same and every limit the buyer set
// (max price, states, oldest year) is satisfied. Used as a sub-select on deal queries
// for admin/broker users only — subscribers never see the broker's buyer book.

/** SQL fragment (uses aliases d = deals, l = listings) returning a JSON array of matching buyers. */
const BUYERS_SQL = `
  (SELECT COALESCE(json_agg(json_build_object(
      'id', b.id, 'company', b.company, 'contact', b.contact_name, 'phone', b.phone,
      'city', b.city, 'state', b.state, 'status', b.status, 'want_id', bw.id, 'want_notes', bw.notes)
      ORDER BY b.status = 'customer' DESC, b.company), '[]'::json)
   FROM buyer_wants bw JOIN buyers b ON b.id = bw.buyer_id
   WHERE bw.active AND b.active AND bw.product_id = d.product_id
     AND (bw.max_price IS NULL OR l.price <= bw.max_price)
     AND (bw.states IS NULL OR cardinality(bw.states) = 0 OR l.state = ANY(bw.states))
     AND (bw.min_year IS NULL OR l.year IS NULL OR l.year >= bw.min_year)) AS buyers`;

/** Count version, for filtering ("has a buyer") and ordering. */
const BUYER_COUNT_SQL = `
  (SELECT COUNT(*)::int FROM buyer_wants bw JOIN buyers b ON b.id = bw.buyer_id
   WHERE bw.active AND b.active AND bw.product_id = d.product_id
     AND (bw.max_price IS NULL OR l.price <= bw.max_price)
     AND (bw.states IS NULL OR cardinality(bw.states) = 0 OR l.state = ANY(bw.states))
     AND (bw.min_year IS NULL OR l.year IS NULL OR l.year >= bw.min_year))`;

const isStaff = (user) => user && (user.role === 'admin' || user.role === 'broker');

module.exports = { BUYERS_SQL, BUYER_COUNT_SQL, isStaff };
