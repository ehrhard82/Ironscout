// Lightweight "who did what" log, so the owner can see how a new account is actually
// using the site (looked up a machine, added a buyer, claimed a deal...). Fire-and-forget.
const pool = require('./db');
function log(user, action, detail) {
  if (!user || !user.id) return;
  pool.query('INSERT INTO activity (user_id, action, detail) VALUES ($1,$2,$3)', [user.id, String(action).slice(0, 40), detail ? String(detail).slice(0, 200) : null]).catch(() => {});
}
module.exports = { log };
