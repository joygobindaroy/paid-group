const { redis, tg, bn, getSettings } = require('./_lib');

async function paymentIsValid(tx, price) {
  const dep = await bn('/sapi/v1/capital/deposit/hisrec', { coin: 'USDT', startTime: Date.now() - 89 * 864e5, limit: 1000 });
  if (Array.isArray(dep) && dep.some(d =>
    String(d.txId).toLowerCase() === tx && [1, 6].includes(d.status) && parseFloat(d.amount) >= price)) return true;
  try {
    const pay = await bn('/sapi/v1/pay/transactions', { startTimestamp: Date.now() - 30 * 864e5, endTimestamp: Date.now(), limit: 100 });
    return ((pay && pay.data) || []).some(p =>
      [p.transactionId, p.orderId].some(x => String(x).toLowerCase() === tx) &&
      p.currency === 'USDT' && parseFloat(p.amount) >= price);
  } catch { return false; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const S = await getSettings();
    if (!S.groupId) return res.status(503).json({ error: 'Not configured yet. Please contact support.' });

    const tx = String((req.body && req.body.txid) || '').trim().toLowerCase();
    if (!/^[\w.:-]{8,120}$/.test(tx)) return res.status(400).json({ error: 'Enter a valid transaction hash or ID.' });

    const key = 'tx:' + tx;
    const raw = await redis('GET', key);
    const rec = raw ? JSON.parse(raw) : null;

    if (rec && rec.pending) return res.status(429).json({ error: 'Already processing. Try again in a few seconds.' });
    // Already joined with this transaction -> support
    if (rec && rec.used) return res.status(409).json({ code: 'used', error: 'This transaction was already used to join the group. Please contact support.' });
    // Link still valid and nobody joined -> give the same link again
    if (rec && rec.link && rec.exp > Date.now()) return res.status(200).json({ link: rec.link, expires: rec.exp });

    // First time: verify payment on Binance
    if (!rec) {
      if (!(await paymentIsValid(tx, parseFloat(S.price))))
        return res.status(402).json({ error: `No confirmed payment of at least ${S.price} USDT found for this ID. If you just paid, wait a minute and try again.` });
      const claimed = await redis('SET', key, JSON.stringify({ pending: true }), 'NX', 'EX', 30);
      if (!claimed) return res.status(429).json({ error: 'Already processing. Try again in a few seconds.' });
      await redis('LPUSH', 'txlog', tx); await redis('LTRIM', 'txlog', 0, 99);
    }

    // First time, or the last link expired without anyone joining -> new link
    const chat = rec && rec.chat ? rec.chat : S.groupId;
    const exp = Date.now() + 3600 * 1000;
    const out = await tg('createChatInviteLink', { chat_id: chat, member_limit: 1, expire_date: Math.floor(exp / 1000), name: 'tx ' + tx.slice(0, 20) });
    if (!out.ok) { if (!rec) await redis('DEL', key); throw new Error(out.description); }

    const link = out.result.invite_link;
    await redis('SET', key, JSON.stringify({ link, chat, exp, used: false, at: Date.now() }));
    await redis('SET', 'link:' + link, tx);
    res.status(200).json({ link, expires: exp });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
  }
};
