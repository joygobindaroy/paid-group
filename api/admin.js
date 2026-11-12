const { E, crypto, redis, tg, bn, getSettings, THEMES, getJ } = require('./_lib');
const { sendReminders, due } = require('./_pay');

const authed = req => {
  const a = Buffer.from(String(req.headers['x-admin-password'] || ''));
  const b = Buffer.from(E.ADMIN_PASSWORD || '');
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};
const clean = (v, n = 300) => String(v == null ? '' : v).trim().slice(0, n);
const bad = (res, error) => res.status(400).json({ error });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const fails = parseInt(await redis('GET', 'bad:' + ip)) || 0;
  if (fails >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!authed(req)) {
    await redis('INCR', 'bad:' + ip); await redis('EXPIRE', 'bad:' + ip, 900);
    return res.status(401).json({ error: 'Wrong password.' });
  }

  if (req.method === 'GET') {
    const log = [];
    for (const tx of (await redis('LRANGE', 'txlog', 0, 49)) || []) {
      const r = await getJ('tx:' + tx);
      if (r) log.push({ tx, at: r.at, status: r.used ? 'Joined' : (r.exp > Date.now() ? 'Link active' : 'Expired, not joined') });
    }
    const orders = [];
    for (const id of (await redis('LRANGE', 'orders', 0, 99)) || []) {
      const o = await getJ('ord:' + id);
      if (o && due(o) > 0) orders.push({ id, title: o.title, due: due(o), tg: !!o.chat && !o.blocked });
    }
    return res.status(200).json({ settings: await getSettings(), log, orders, classStart: Number(await redis('GET', 'classStart')) || 0 });
  }

  const b = req.body || {};
  if (b.action === 'check') {
    const id = clean(b.groupId, 30);
    const chat = await tg('getChat', { chat_id: id });
    if (!chat.ok) return res.status(200).json({ ok: false, error: chat.description });
    const me = await tg('getMe', {});
    const m = await tg('getChatMember', { chat_id: id, user_id: me.result.id });
    const p = m.result || {};
    return res.status(200).json({ ok: true, title: chat.result.title, admin: p.status === 'administrator' || p.status === 'creator', canInvite: p.status === 'creator' || !!p.can_invite_users });
  }

  if (b.action === 'detect') { // read your own deposit addresses from Binance
    const methods = [], errors = [];
    for (const [net, label, note] of [['TRX', 'USDT · TRC20', 'Send on the TRON (TRC20) network only. From another Binance account it is free and instant: paste the TxID number from your history.'], ['BSC', 'USDT · BEP20', 'Send on the BNB Smart Chain (BEP20) network only. From another Binance account it is free and instant: paste the TxID number from your history.']]) {
      try {
        const d = await bn('/sapi/v1/capital/deposit/address', { coin: 'USDT', network: net });
        if (d.address) methods.push({ label, field: 'Deposit address', addr: d.address, note }); else errors.push(`${label}: ${d.msg || 'no address returned'}`);
      } catch (e) { errors.push(`${label}: ${e.message}`); }
    }
    return res.status(200).json({ methods, errors });
  }

  if (b.action === 'selftest') { // shows whether auto-verification can really work with your Binance key
    const tests = [];
    const t = async (name, fn) => { try { tests.push({ name, ok: true, info: await fn() }); } catch (e) { tests.push({ name, ok: false, info: e.message }); } };
    await t('API key permissions', async () => {
      const r = await bn('/sapi/v1/account/apiRestrictions', {});
      if (r.enableWithdrawals) throw new Error('Withdrawals are ENABLED on this key. Create a new read-only key and delete this one.');
      return `reading ${r.enableReading ? 'on' : 'OFF'}, withdrawals off, IP restriction ${r.ipRestrict ? 'ON (turn it off, Vercel IPs change)' : 'off'}`;
    });
    await t('Deposit history (on-chain USDT)', async () => {
      const d = await bn('/sapi/v1/capital/deposit/hisrec', { coin: 'USDT', limit: 5 });
      if (!Array.isArray(d)) throw new Error(JSON.stringify(d).slice(0, 120));
      return d.length ? 'OK. Latest: ' + d.slice(0, 3).map(x => { const id = String(x.txId); return `${x.amount} USDT, ID "${id.length > 26 ? id.slice(0, 12) + '…' : id}"`; }).join('; ') : 'OK. No USDT deposits yet.';
    });
    await t('Deposit addresses', async () => { const d = await bn('/sapi/v1/capital/deposit/address', { coin: 'USDT', network: 'TRX' }); if (!d.address) throw new Error(d.msg || 'no address'); return 'OK'; });
    await t('Binance Pay history (zero fee)', async () => {
      const p = await bn('/sapi/v1/pay/transactions', { startTime: Date.now() - 14 * 864e5, endTime: Date.now(), limit: 100 });
      if (p.code && p.code !== '000000') throw new Error(p.message || p.code);
      const inc = (p.data || []).filter(x => parseFloat(x.amount) > 0);
      return `OK. ${(p.data || []).length} record(s) in 14 days.` + (inc.length ? ' Latest incoming: ' + inc.slice(0, 3).map(x => `${x.amount} ${x.currency} (ID ${x.transactionId})`).join(', ') : '');
    });
    return res.status(200).json({ tests });
  }

  if (b.action === 'class') {
    if (b.on) await redis('SET', 'classStart', String(Date.now())); else await redis('DEL', 'classStart');
    return res.status(200).json({ ok: true });
  }
  if (b.action === 'remind') return res.status(200).json(await sendReminders(req.headers.host));

  if (b.action === 'save') {
    const s = b.settings || {};
    const groupId = clean(s.groupId, 30), price = parseFloat(s.price);
    if (!/^-?\d+$/.test(groupId)) return bad(res, 'Group ID must be a number like -1001234567890.');
    if (!(price > 0)) return bad(res, 'Price must be greater than 0.');
    const methods = (Array.isArray(s.methods) ? s.methods : []).slice(0, 8).map((m, i) => ({
      id: 'm' + i, label: clean(m.label, 40), field: clean(m.field, 40) || 'Deposit address', addr: clean(m.addr, 200), note: clean(m.note, 200),
    })).filter(m => m.label && m.addr);
    const th = s.theme || {};
    const mode = th.mode === 'rotate' ? 'rotate' : 'fixed';
    const fixed = THEMES.includes(th.fixed) ? th.fixed : 'club';
    const rotate = (Array.isArray(th.rotate) ? th.rotate : []).filter(x => THEMES.includes(x));
    if (mode === 'rotate' && rotate.length < 2) return bad(res, 'Select at least 2 themes to rotate.');
    const plans = [];
    for (const p of (Array.isArray(s.plans) ? s.plans : []).slice(0, 10)) {
      if (!clean(p.slug) && !clean(p.title)) continue;
      const slug = clean(p.slug, 30).toLowerCase(), first = parseFloat(p.first), total = parseFloat(p.total);
      if (!/^[a-z0-9-]{2,30}$/.test(slug) || slug === 'full') return bad(res, `Link name "${slug}" must be 2-30 letters, numbers or dashes (and not "full").`);
      if (!(first > 0) || !(total >= first)) return bad(res, `Plan "${slug}": pay-now must be more than 0 and total at least the pay-now amount.`);
      if (plans.some(x => x.slug === slug)) return bad(res, `Link name "${slug}" is used twice.`);
      plans.push({ slug, title: clean(p.title, 60) || slug, first, total });
    }
    await redis('SET', 'settings', JSON.stringify({ groupId, groupName: clean(s.groupName, 80), tagline: clean(s.tagline, 200), price, supportUrl: clean(s.supportUrl, 200), methods, theme: { mode, fixed, rotate }, plans }));
    return res.status(200).json({ ok: true });
  }
  res.status(400).json({ error: 'Bad request' });
};
