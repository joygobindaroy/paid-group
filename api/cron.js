const { E } = require('./_lib');
const { sendReminders } = require('./_pay');
module.exports = async (req, res) => {
  if (!E.CRON_SECRET || req.headers.authorization !== `Bearer ${E.CRON_SECRET}`) return res.status(401).end();
  res.status(200).json(await sendReminders(req.headers.host));
};
