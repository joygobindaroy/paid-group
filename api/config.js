const { redis, getSettings, THEMES, getJ } = require('./_lib');
const { liveMethods } = require('./_pay');
module.exports = async (req, res) => {
  const S = await getSettings();
  const { groupId, theme: T, plans, ...pub } = S;
  pub.methods = await liveMethods(S);
  let theme = T.fixed;
  if (T.mode === 'rotate') {
    const list = T.rotate.length ? T.rotate : THEMES;
    const have = String((req.query && req.query.have) || '');
    if (list.includes(have)) theme = have;
    else { const n = await redis('INCR', 'themeCounter'); theme = list[(n - 1) % list.length]; }
  }
  const slug = String((req.query && req.query.plan) || ''), code = String((req.query && req.query.code) || '');
  let p = slug && (plans || []).find(x => x.slug === slug), bad = !!slug && !p;
  if (code) { const l = await getJ('pl:' + code); p = l && !l.revoked ? { slug: 'p', title: l.label || 'Private plan', first: l.amount, total: Math.max(l.amount, S.price) } : null; bad = !p; }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ...pub, theme, mode: T.mode, plan: p ? { slug: p.slug, title: p.title, first: p.first, total: p.total } : null, planInvalid: bad });
};
