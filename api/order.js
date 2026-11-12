const { rate, getJ } = require('./_lib');
const { due, stripOff } = require('./_pay');
module.exports = async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  if (!(await rate('ord:' + ip, 20, 60))) return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' });
  const o = await getJ('ord:' + stripOff(req.query && req.query.id));
  if (!o) return res.status(404).json({ error: 'Order not found. Check the transaction ID of your first payment.' });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ due: due(o), paid: o.paid, total: o.total, title: o.title });
};
