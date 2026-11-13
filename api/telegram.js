// Telegram webhook: (1) marks a transaction used when someone joins with its link,
// (2) lets people pay and get receipts / links / reminders in a private chat with the bot.
const crypto = require('crypto');
const { E, redis, tg, send, getSettings, rate, getJ, setJ, isAdmin, adminIds } = require('./_lib');
const { processPayment, receiptOf, receiptText, planOf, methodsText, liveMethods, due, money } = require('./_pay');

const rnd = n => [...crypto.randomBytes(n)].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const HELP = '/admin commands:\n/stats: today and balances due\n/newlink 5 [name]: private link, pay 5 now\n/links: your private links\n/revoke CODE: switch a link off\n/login: one-time link to the admin panel\n/myid: your Telegram ID';
async function adminCmd(text, chat, S, host) {
  const [cmd, ...a] = text.split(/\s+/);
  if (cmd === '/admin') return send(chat, HELP);
  if (cmd === '/login') { const t = rnd(24); await redis('SET', 'lg:' + t, '1', 'EX', 300); return send(chat, `Admin panel (opens once, valid 5 minutes):\nhttps://${host}/admin#t=${t}`); }
  if (cmd === '/stats') {
    const d0 = new Date(); d0.setUTCHours(0, 0, 0, 0); let n = 0, sum = 0, cnt = 0, owed = 0;
    for (const id of (await redis('LRANGE', 'txlog', 0, 99)) || []) { const o = await getJ('ord:' + id); if (o && o.created >= d0.getTime()) { n++; sum += o.paid; } }
    for (const id of (await redis('LRANGE', 'orders', 0, 499)) || []) { const o = await getJ('ord:' + id); if (o && due(o) > 0) { cnt++; owed += due(o); } }
    return send(chat, `Today (UTC): ${n} sale(s), ${money(sum)} USDT\nBalances due: ${cnt} student(s), ${money(owed)} USDT`);
  }
  if (cmd === '/newlink') {
    const amount = parseFloat(a[0]);
    if (!(amount > 0)) return send(chat, 'Usage: /newlink 5   or   /newlink 5 Rahim');
    const code = rnd(14);
    await setJ('pl:' + code, { amount, label: a.slice(1).join(' ').slice(0, 40), uses: 0, revoked: false, at: Date.now() });
    await redis('LPUSH', 'plinks', code); await redis('LTRIM', 'plinks', 0, 499);
    return send(chat, `https://${host}/p/${code}\nPay now: ${money(amount)} USDT${S.price > amount ? `, balance later: ${money(S.price - amount)} USDT (price ${money(S.price)})` : ''}`);
  }
  if (cmd === '/links') {
    const out = [];
    for (const c of (await redis('LRANGE', 'plinks', 0, 14)) || []) { const l = await getJ('pl:' + c); if (l) out.push(`${c} · ${money(l.amount)} USDT${l.label ? ' · ' + l.label : ''} · used ${l.uses || 0}${l.revoked ? ' · OFF' : ''}`); }
    return send(chat, out.join('\n') || 'No links yet. Try /newlink 5');
  }
  if (cmd === '/revoke') {
    const l = await getJ('pl:' + (a[0] || ''));
    if (!l) return send(chat, 'Link not found. Use /links to see the codes.');
    l.revoked = true; await setJ('pl:' + a[0], l); return send(chat, 'Link switched off.');
  }
  return false;
}

// A student's message (text, photo, screenshot, video, file) is copied to every admin; admins answer by replying to it.
async function toSupport(m, chat) {
  const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') + (m.from.username ? ' @' + m.from.username : '');
  const st = await getJ('chat:' + chat), o = st && st.order && (await getJ('ord:' + st.order));
  const info = o ? `Order #${o.rno}: paid ${money(o.paid)} of ${money(o.total)} USDT` : 'No payment yet';
  for (const id of adminIds()) {
    const h = await send(id, `Support message from ${who} (ID ${chat})\n${info}\nReply to this or to the message below to answer.`);
    const c = await tg('copyMessage', { chat_id: id, from_chat_id: chat, message_id: m.message_id });
    for (const x of [h, c]) if (x && x.ok) await redis('SET', `sup:${id}:${x.result.message_id}`, String(chat), 'EX', 30 * 86400);
  }
}

async function onMessage(m, host) {
  const chat = m.chat.id, text = (m.text || '').trim(), S = await getSettings();
  const state = (await getJ('chat:' + chat)) || {};
  if (text === '/myid') return send(chat, `Your Telegram ID: ${m.from ? m.from.id : chat}`);
  if (m.from && isAdmin(m.from.id) && m.reply_to_message) { // admin answering a support message
    const to = await redis('GET', `sup:${m.from.id}:${m.reply_to_message.message_id}`);
    if (to) { await tg('copyMessage', { chat_id: to, from_chat_id: chat, message_id: m.message_id }); return send(chat, 'Sent ✔'); }
  }
  if (m.from && isAdmin(m.from.id) && text.startsWith('/')) { const r = await adminCmd(text, chat, S, host); if (r !== false) return r; }

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
    return send(chat, `Welcome to ${S.groupName}.\n\nPrice: ${money(P.first)} USDT${P.total > P.first ? ` now (the remaining ${money(P.total - P.first)} USDT later)` : ''}.\n\nSend USDT to:\n${methodsText(await liveMethods(S))}\n\nThen reply here with your transaction hash or Binance Pay order ID. I will verify it and send your receipt and private group link.`);
  }

  if (!text.startsWith('/') && !/^[\w.:-]{8,120}$/.test(text)) { // not a command and not a transaction ID: goes to support
    if (!(await rate('sup:' + chat, 10, 60))) return send(chat, 'Too many messages. Please wait a minute.');
    await toSupport(m, chat);
    return send(chat, 'Sent to support. We will reply here. If you are paying, send your transaction ID.');
  }
  if (!/^[\w.:-]{8,120}$/.test(text)) return send(chat, 'Send your transaction hash or Binance Pay order ID here, or /start for payment details.');
  if (!(await rate('bot:' + chat, 6, 60))) return send(chat, 'Too many attempts. Please wait a minute and try again.');
  const o = state.order && (await getJ('ord:' + state.order));
  const balance = o && due(o) > 0 && text.toLowerCase() !== o.id;
  const [code, body] = await processPayment({ txid: text, plan: state.plan, balanceFor: balance ? o.id : undefined, chat, notify: false });
  if (code !== 200) return send(chat, body.error + (code === 402 ? '\n\nNeed help? Write a message or send a screenshot here and support will see it.' : ''));
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
    if (m && m.chat && m.chat.type === 'private') await onMessage(m, req.headers.host);
  } catch (e) { console.error(e); }
  res.status(200).json({ ok: true });
};
