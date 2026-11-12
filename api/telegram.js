// Telegram webhook: (1) marks a transaction used when someone joins with its link,
// (2) lets people pay and get receipts / links / reminders in a private chat with the bot.
const { E, redis, send, getSettings, rate, getJ, setJ } = require('./_lib');
const { processPayment, receiptOf, receiptText, planOf, methodsText, due, money } = require('./_pay');

async function onMessage(m, host) {
  const chat = m.chat.id, text = m.text.trim(), S = await getSettings();
  const state = (await getJ('chat:' + chat)) || {};

  if (text.startsWith('/start')) {
    const arg = text.split(/\s+/)[1] || '';
    if (arg.startsWith('t_')) { // opened from the receipt on the website
      const id = await redis('GET', 'tk:' + arg.slice(2));
      const o = id && (await getJ('ord:' + id));
      if (!o) return send(chat, 'This link is no longer valid.');
      o.chat = chat; o.blocked = false; await setJ('ord:' + o.id, o);
      await setJ('chat:' + chat, { ...state, order: o.id });
      const rec = await getJ('tx:' + o.id);
      let msg = 'Connected ✔\n\n' + receiptText(receiptOf(S, o, o.txs[o.txs.length - 1]));
      if (rec && !rec.used && rec.link && rec.exp > Date.now()) msg += `\n\nYour private group link (single use):\n${rec.link}`;
      if (due(o) > 0) msg += `\n\nBalance of ${money(due(o))} USDT is due later. I will remind you here every day once classes start. To pay, send the new transaction ID in this chat.`;
      return send(chat, msg);
    }
    const slug = arg.startsWith('plan_') ? arg.slice(5) : (state.plan || 'full');
    const P = planOf(S, slug);
    await setJ('chat:' + chat, { ...state, plan: P.slug });
    return send(chat, `Welcome to ${S.groupName}.\n\nPrice: ${money(P.first)} USDT${P.total > P.first ? ` now (the remaining ${money(P.total - P.first)} USDT later)` : ''}.\n\nSend USDT to:\n${methodsText(S)}\n\nThen reply here with your transaction hash or Binance Pay order ID. I will verify it and send your receipt and private group link.`);
  }

  if (!/^[\w.:-]{8,120}$/.test(text)) return send(chat, 'Send your transaction hash or Binance Pay order ID here, or /start for payment details.');
  if (!(await rate('bot:' + chat, 6, 60))) return send(chat, 'Too many attempts. Please wait a minute and try again.');
  const o = state.order && (await getJ('ord:' + state.order));
  const balance = o && due(o) > 0 && text.toLowerCase() !== o.id;
  const [code, body] = await processPayment({ txid: text, plan: state.plan, balanceFor: balance ? o.id : undefined, chat, notify: false });
  if (code !== 200) return send(chat, body.error);
  await setJ('chat:' + chat, { ...state, order: body.receipt.order });
  if (body.done) return send(chat, 'Balance verified ✔\n\n' + receiptText(body.receipt));
  let msg = 'Payment verified ✔\n\n' + receiptText(body.receipt) + `\n\nYour private group link (single use, valid 1 hour):\n${body.link}\n\nNot joined in time? Send the same transaction ID here for a new link.`;
  if (body.receipt.due > 0) msg += `\n\nBalance of ${money(body.receipt.due)} USDT is due later. I will remind you here every day once classes start. To pay, send the new transaction ID in this chat.`;
  return send(chat, msg);
}

module.exports = async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== E.TG_WEBHOOK_SECRET) return res.status(401).end();
  try {
    const u = req.body || {};
    const cm = u.chat_member, link = cm && cm.invite_link && cm.invite_link.invite_link;
    if (link && cm.new_chat_member && cm.new_chat_member.status === 'member') {
      const tx = await redis('GET', 'link:' + link);
      const raw = tx && (await redis('GET', 'tx:' + tx));
      if (raw) await redis('SET', 'tx:' + tx, JSON.stringify({ ...JSON.parse(raw), used: true, joinedAt: Date.now() }));
    }
    const m = u.message;
    if (m && m.chat && m.chat.type === 'private' && typeof m.text === 'string') await onMessage(m, req.headers.host);
  } catch (e) { console.error(e); }
  res.status(200).json({ ok: true });
};
