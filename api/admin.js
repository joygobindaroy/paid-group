const { E, crypto, redis, tg, getSettings, THEMES } = require('./_lib');

const authed = req => {
  const a = Buffer.from(String(req.headers['x-admin-password'] || ''));
  const b = Buffer.from(E.ADMIN_PASSWORD || '');
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};
const clean = (v, n = 300) => String(v == null ? '' : v).trim().slice(0, n);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const bad = parseInt(await redis('GET', 'bad:' + ip)) || 0;
  if (bad >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!authed(req)) {
    await redis('INCR', 'bad:' + ip); await redis('EXPIRE', 'bad:' + ip, 900);
    return res.status(401).json({ error: 'Wrong password.' });
  }

  if (req.method === 'GET') {
    const keys = (await redis('LRANGE', 'txlog', 0, 49)) || [];
    const log = [];
    for (const tx of keys) {
      const raw = await redis('GET', 'tx:' + tx);
      if (!raw) continue;
      const r = JSON.parse(raw);
      log.push({ tx, at: r.at, status: r.used ? 'Joined' : (r.exp > Date.now() ? 'Link active' : 'Expired, not joined') });
    }
    return res.status(200).json({ settings: await getSettings(), log });
  }

  const b = req.body || {};
  if (b.action === 'check') {
    const id = clean(b.groupId, 30);
    const chat = await tg('getChat', { chat_id: id });
    if (!chat.ok) return res.status(200).json({ ok: false, error: chat.description });
    const me = await tg('getMe', {});
    const m = await tg('getChatMember', { chat_id: id, user_id: me.result.id });
    const p = m.result || {};
    return res.status(200).json({
      ok: true, title: chat.result.title, admin: p.status === 'administrator' || p.status === 'creator',
      canInvite: p.status === 'creator' || !!p.can_invite_users,
    });
  }

  if (b.action === 'save') {
    const s = b.settings || {};
    const groupId = clean(s.groupId, 30);
    const price = parseFloat(s.price);
    if (!/^-?\d+$/.test(groupId)) return res.status(400).json({ error: 'Group ID must be a number like -1001234567890.' });
    if (!(price > 0)) return res.status(400).json({ error: 'Price must be greater than 0.' });
    const methods = (Array.isArray(s.methods) ? s.methods : []).slice(0, 8).map((m, i) => ({
      id: 'm' + i, label: clean(m.label, 40), field: clean(m.field, 40) || 'Deposit address', addr: clean(m.addr, 200), note: clean(m.note, 200),
    })).filter(m => m.label && m.addr);
    const th = s.theme || {};
    const mode = th.mode === 'rotate' ? 'rotate' : 'fixed';
    const fixed = THEMES.includes(th.fixed) ? th.fixed : 'club';
    const rotate = (Array.isArray(th.rotate) ? th.rotate : []).filter(x => THEMES.includes(x));
    if (mode === 'rotate' && rotate.length < 2) return res.status(400).json({ error: 'Select at least 2 themes to rotate.' });
    const theme = { mode, fixed, rotate };
    const out = { groupId, groupName: clean(s.groupName, 80), tagline: clean(s.tagline, 200), price, supportUrl: clean(s.supportUrl, 200), methods, theme };
    await redis('SET', 'settings', JSON.stringify(out));
    return res.status(200).json({ ok: true });
  }
  res.status(400).json({ error: 'Bad request' });
};
