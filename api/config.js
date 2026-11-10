const { redis, getSettings, THEMES } = require('./_lib');
module.exports = async (req, res) => {
  const { groupId, theme: T, ...pub } = await getSettings();
  let theme = T.fixed;
  if (T.mode === 'rotate') {
    const list = T.rotate.length ? T.rotate : THEMES;
    const have = String((req.query && req.query.have) || '');
    if (list.includes(have)) theme = have;                       // returning visitor keeps theirs
    else { const n = await redis('INCR', 'themeCounter'); theme = list[(n - 1) % list.length]; } // next visitor, next theme
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ...pub, theme, mode: T.mode });
};
