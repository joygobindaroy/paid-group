// Telegram webhook: marks a transaction as used once someone joins with its link.
const { E, redis } = require('./_lib');
module.exports = async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== E.TG_WEBHOOK_SECRET) return res.status(401).end();
  try {
    const cm = (req.body || {}).chat_member;
    const link = cm && cm.invite_link && cm.invite_link.invite_link;
    if (link && cm.new_chat_member && cm.new_chat_member.status === 'member') {
      const tx = await redis('GET', 'link:' + link);
      const raw = tx && await redis('GET', 'tx:' + tx);
      if (raw) await redis('SET', 'tx:' + tx, JSON.stringify({ ...JSON.parse(raw), used: true, joinedAt: Date.now() }));
    }
  } catch (e) { console.error(e); }
  res.status(200).json({ ok: true });
};
