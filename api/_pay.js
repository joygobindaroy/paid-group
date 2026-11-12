// Shared payment logic used by the website (/api/verify), the Telegram bot and the daily reminders.
const crypto = require('crypto');
const { redis, tg, bn, getSettings, botName, send, getJ, setJ } = require('./_lib');

const stripOff = s => String(s || '').trim().toLowerCase().replace(/^off-chain transfer\s*[:#-]?\s*/, '');
const EPS = 1e-6;
const money = n => String(Math.round(n * 100) / 100);
const due = o => Math.max(0, Math.round((o.total - o.paid) * 100) / 100);
const planOf = (S, slug) => (S.plans || []).find(p => p.slug === slug) || { slug: 'full', title: 'Full access', first: S.price, total: S.price };
const short = t => (t.length > 24 ? t.slice(0, 10) + '…' + t.slice(-8) : t);
const methodsText = S => S.methods.map(m => `• ${m.label}: ${m.addr}`).join('\n');

let PAYC = { at: 0, list: [] };
const resetPayCache = () => { PAYC = { at: 0, list: [] }; };
// Binance Pay history (weight 3000 per call), cached 8 seconds so many visitors do not hammer it.
async function payList() {
  if (Date.now() - PAYC.at < 8000) return PAYC.list;
  const pay = await bn('/sapi/v1/pay/transactions', { startTime: Date.now() - 14 * 864e5, endTime: Date.now(), limit: 100 });
  if (pay && pay.code && pay.code !== '000000') throw new Error('Pay history: ' + (pay.message || pay.code));
  PAYC = { at: Date.now(), list: (pay && pay.data) || [] };
  return PAYC.list;
}
const normId = s => String(s).trim().toLowerCase().replace(/^m_p_/, '');

// Looks the transaction up in your Binance account. Returns { amount, via, at } or null.
async function paymentInfo(tx) {
  const dep = await bn('/sapi/v1/capital/deposit/hisrec', { coin: 'USDT', startTime: Date.now() - 89 * 864e5, limit: 1000 });
  const d = Array.isArray(dep) && dep.find(x => stripOff(x.txId) === tx && [1, 6].includes(x.status)); // Binance-to-Binance transfers come back as "Off-chain transfer <number>"
  if (d) return { amount: parseFloat(d.amount), via: d.transferType === 1 || /^off-chain/i.test(String(d.txId)) ? 'Binance transfer (zero fee)' : 'USDT · ' + d.network, at: d.insertTime };
  try { // Binance Pay (zero fee, instant): incoming USDT only, never refunds
    const p = (await payList()).find(x => [x.transactionId, x.orderId].some(v => v && normId(v) === normId(tx))
      && x.currency === 'USDT' && parseFloat(x.amount) > 0 && !/REFUND|_RF/.test(x.orderType || ''));
    if (p) return { amount: parseFloat(p.amount), via: 'Binance Pay', at: p.transactionTime };
  } catch (e) { console.error('Binance Pay lookup failed:', e.message); }
  return null;
}

const receiptOf = (S, o, t) => ({ no: o.rno, group: S.groupName, plan: o.title, amount: t.amt, via: t.via, at: t.at, tx: t.tx, total: o.total, paid: o.paid, due: due(o), order: o.id });
const receiptText = r => [
  `Receipt #${r.no}`, r.group, `Plan: ${r.plan}`, `Received: ${money(r.amount)} USDT via ${r.via}`,
  `Time: ${new Date(r.at).toISOString().replace('T', ' ').slice(0, 16)} UTC`, `Transaction: ${short(r.tx)}`,
  r.due > 0 ? `Balance due: ${money(r.due)} USDT` : 'Paid in full ✔',
].join('\n');
const tgLink = async o => { const b = await botName(); return b && o.tok ? `https://t.me/${b}?start=t_${o.tok}` : null; };
const NOT_FOUND = { error: 'No confirmed payment found for this ID. If you just paid, wait a minute and try again.' };
const BUSY = { error: 'Already processing. Try again in a few seconds.' };

// Returns [httpStatus, body]. notify=false lets the bot send its own reply.
async function processPayment({ txid, plan: slug, balanceFor, chat, notify = true }) {
  const S = await getSettings();
  if (!S.groupId) return [503, { error: 'Not configured yet. Please contact support.' }];
  const tx = stripOff(txid);
  if (!/^[\w.:-]{8,120}$/.test(tx)) return [400, { error: 'Enter a valid transaction hash or ID.' }];
  const key = 'tx:' + tx;
  const rec = await getJ(key);
  if (rec && rec.pending) return [429, BUSY];

  // ---------- paying the remaining balance of an installment order ----------
  if (balanceFor) {
    const o = await getJ('ord:' + stripOff(balanceFor));
    if (!o) return [404, { error: 'Order not found. Enter the transaction ID of your first payment.' }];
    if (due(o) <= 0) return [409, { error: 'This order is already paid in full.' }];
    if (rec) return [409, { code: 'used', error: 'This transaction ID was already used.' }];
    const info = await paymentInfo(tx);
    if (!info) return [402, NOT_FOUND];
    if (info.amount < due(o) - EPS) return [402, { error: `Payment received (${money(info.amount)} USDT) is less than the balance due (${money(due(o))} USDT).` }];
    if (!(await redis('SET', key, JSON.stringify({ order: o.id, kind: 'balance' }), 'NX'))) return [429, BUSY];
    const t = { tx, amt: info.amount, at: info.at || Date.now(), via: info.via };
    o.paid = Math.round((o.paid + t.amt) * 100) / 100; o.txs.push(t);
    if (chat && !o.chat) o.chat = chat;
    await setJ('ord:' + o.id, o);
    const receipt = receiptOf(S, o, t);
    if (notify && o.chat) await send(o.chat, 'Balance received. Thank you!\n\n' + receiptText(receipt));
    return [200, { receipt, done: true }];
  }

  // ---------- first payment (full price, or the "pay now" part of a plan) ----------
  const P = planOf(S, slug || 'full');
  if (slug && slug !== 'full' && P.slug !== slug) return [404, { error: 'This payment link is not valid.' }];
  if (rec && (rec.used || rec.kind === 'balance')) {
    const o0 = rec.used ? await getJ('ord:' + tx) : null;
    return [409, { code: 'used', error: o0 && due(o0) > 0
      ? `You already joined. Your balance of ${money(due(o0))} USDT is still due. Use "Pay remaining balance" below.`
      : 'This transaction was already used to join the group. Please contact support.' }];
  }
  let o = rec ? await getJ('ord:' + tx) : null;
  if (rec && !o) return [500, { error: 'Order record missing. Please contact support.' }];
  // link still valid and nobody joined -> same link again
  if (rec && rec.link && rec.exp > Date.now()) return [200, { link: rec.link, expires: rec.exp, receipt: receiptOf(S, o, o.txs[0]), tg: await tgLink(o) }];

  let info;
  if (!rec) {
    info = await paymentInfo(tx);
    if (!info) return [402, NOT_FOUND];
    if (info.amount < P.first - EPS) return [402, { error: `Payment received (${money(info.amount)} USDT) is less than the required ${money(P.first)} USDT.` }];
    if (!(await redis('SET', key, JSON.stringify({ pending: true }), 'NX', 'EX', 30))) return [429, BUSY];
  }
  // first time, or the last link expired without anyone joining -> new link
  const grp = rec && rec.grp ? rec.grp : S.groupId;
  const exp = Date.now() + 3600 * 1000;
  const out = await tg('createChatInviteLink', { chat_id: grp, member_limit: 1, expire_date: Math.floor(exp / 1000), name: 'tx ' + tx.slice(0, 20) });
  if (!out.ok) { if (!rec) await redis('DEL', key); throw new Error(out.description); }
  const link = out.result.invite_link;
  if (!rec) {
    const t = { tx, amt: info.amount, at: info.at || Date.now(), via: info.via };
    o = { id: tx, plan: P.slug, title: P.title, total: P.total, paid: t.amt, rno: await redis('INCR', 'receiptNo'), tok: crypto.randomBytes(6).toString('base64url'), chat: chat || null, created: Date.now(), lastRemind: 0, txs: [t] };
    await setJ('ord:' + tx, o);
    await redis('SET', 'tk:' + o.tok, tx);
    await redis('LPUSH', 'txlog', tx); await redis('LTRIM', 'txlog', 0, 99);
    if (due(o) > 0) { await redis('LPUSH', 'orders', tx); await redis('LTRIM', 'orders', 0, 1999); }
  } else if (chat && !o.chat) { o.chat = chat; await setJ('ord:' + tx, o); }
  await setJ(key, { link, grp, exp, used: false, at: Date.now() });
  await redis('SET', 'link:' + link, tx);
  return [200, { link, expires: exp, receipt: receiptOf(S, o, o.txs[0]), tg: await tgLink(o) }];
}

// Daily reminder for students who still owe a balance. Only runs after the admin starts classes.
async function sendReminders(host) {
  const S = await getSettings();
  if (!(await redis('GET', 'classStart'))) return { sent: 0, note: 'Reminders are off (first class not started).' };
  const ids = (await redis('LRANGE', 'orders', 0, 499)) || [];
  let sent = 0, noTelegram = 0;
  for (const id of ids) {
    const o = await getJ('ord:' + id);
    if (!o || due(o) <= 0) continue;
    if (!o.chat || o.blocked) { noTelegram++; continue; }
    if (Date.now() - (o.lastRemind || 0) < 20 * 3600 * 1000) continue;
    const r = await send(o.chat, `Reminder: your remaining balance for ${S.groupName} is ${money(due(o))} USDT.\n\n${methodsText(S)}\n\nAfter paying, send the transaction ID right here. You can also pay on the website:\nhttps://${host}/?balance=${o.id}`);
    o.lastRemind = Date.now(); if (!r.ok) o.blocked = true; else sent++;
    await setJ('ord:' + o.id, o);
  }
  return { sent, noTelegram };
}

module.exports = { stripOff, resetPayCache, processPayment, sendReminders, receiptOf, receiptText, planOf, methodsText, due, money };
