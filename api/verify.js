const { rate } = require('./_lib');
const { processPayment } = require('./_pay');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
    if (!(await rate('web:' + ip, 30, 60))) return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' });
    const b = req.body || {};
    const [code, body] = await processPayment({ txid: b.txid, plan: b.plan, code: b.code, balanceFor: b.balanceFor });
    res.status(code).json(body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
  }
};
