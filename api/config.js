const { redis, getSettings, THEMES } = require('./_lib');
module.exports = async (req, res) => {
  const { groupId, theme: T, plans, ...pub } = await getSettings();
  let theme = T.fixed;
  if (T.mode === 'rotate') {
    const list = T.rotate.length ? T.rotate : THEMES;
    const have = String((req.query && req.query.have) || '');
    if (list.includes(have)) theme = have;
    else { const n = await redis('INCR', 'themeCounter'); theme = list[(n - 1) % list.length]; }
  }
  const slug = String((req.query && req.query.plan) || '');
  const p = slug && (plans || []).find(x => x.slug === slug);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ...pub, theme, mode: T.mode, plan: p ? { slug: p.slug, title: p.title, first: p.first, total: p.total } : null, planInvalid: !!slug && !p });
};
