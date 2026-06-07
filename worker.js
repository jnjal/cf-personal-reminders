/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║     Personal Telegram Reminder Bot — Cloudflare Worker          ║
 * ║     Single-file, ES Modules, KV-backed, Jalali-aware            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ENV BINDINGS required in wrangler.toml / CF Dashboard:
 *   TELEGRAM_TOKEN  — Bot token from @BotFather
 *   MY_CHAT_ID      — Your numeric Telegram chat ID (security gate)
 *   REMINDERS_KV    — KV namespace binding
 *
 * Cron Trigger: every 15 minutes  →  * /15 * * * *  (remove space)
 */

// ─────────────────────────────────────────────
// SECTION 1 ─ Jalali ↔ Gregorian / Timestamp
// ─────────────────────────────────────────────

/**
 * Converts a Jalali (Solar Hijri) date + wall-clock time into a UTC Unix
 * timestamp (seconds).
 *
 * Algorithm:
 *  1. Calculate the Julian Day Number (JDN) for the Jalali date, using the
 *     well-known astronomical formula that maps Jalali epochs to the
 *     proleptic Julian calendar.
 *  2. Convert JDN → Gregorian calendar fields via the standard JDN→Gregorian
 *     algorithm.
 *  3. Build a UTC Date by subtracting the Tehran fixed offset (+3:30 = 12600 s).
 *
 * Tehran offset: Iran abolished DST in 2005; the fixed offset is UTC+03:30
 * (3 hours 30 minutes = 12600 seconds ahead of UTC).
 */
function jalaliToUnix(jY, jM, jD, hour, minute) {
  // ── Step 1: Jalali → Julian Day Number ──────────────────────────
  // Reference epoch: Jalali 1/1/1 = JDN 1948321 (Birashk algorithm)
  const jEpoch = 1948321;

  // Determine the Gregorian year of the Jalali year's epoch
  // by grouping Jalali years into 2820-year grand cycles.
  const jy = jY - 474;
  const jyy = 474 + (((jy % 2820) + 2820) % 2820);

  // JDN of the first day of the Jalali year
  const jdn =
    jD +
    (jM <= 6 ? (jM - 1) * 31 : (jM - 1) * 30 + 6) + // day-of-year
    Math.floor((jyy * 682 - 110) / 2816) +            // leap correction
    (jyy - 1) * 365 +                                  // full years
    Math.floor(jy / 2820) * 1029983 +                 // grand cycles
    jEpoch - 1;

  // ── Step 2: JDN → Gregorian (proleptic) ─────────────────────────
  // Standard algorithm from Richards (2013), Mapping Time.
  const f = jdn + 1401 + Math.floor((Math.floor((4 * jdn + 274277) / 146097) * 3) / 4) - 38;
  const e = 4 * f + 3;
  const g = Math.floor((e % 1461) / 4);
  const h = 5 * g + 2;

  const gD = Math.floor((h % 153) / 5) + 1;
  const gM = ((Math.floor(h / 153) + 2) % 12) + 1;
  const gY = Math.floor(e / 1461) - 4716 + Math.floor((14 - gM) / 12);

  // ── Step 3: Gregorian wall-clock (Tehran) → UTC Unix timestamp ──
  // Tehran local time = UTC + 03:30 → UTC = local − 12600 seconds
  const tehranOffsetSeconds = 3 * 3600 + 30 * 60; // 12600
  const utcMs =
    Date.UTC(gY, gM - 1, gD, hour, minute, 0) - tehranOffsetSeconds * 1000;

  return Math.floor(utcMs / 1000);
}

/**
 * Returns a human-readable Tehran local time string from a Unix timestamp.
 * Used in /list display and confirmation messages.
 */
function unixToTehranString(ts) {
  const tehranOffset = 3 * 60 + 30; // minutes
  const d = new Date((ts + tehranOffset * 60) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (تهران)`;
}

/** Tiny UUID v4 generator — no crypto dependency needed for KV keys. */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ─────────────────────────────────────────────
// SECTION 2 ─ Telegram API helpers
// ─────────────────────────────────────────────

/** Base Telegram API caller. Returns parsed JSON response. */
async function tgCall(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const tg = {
  send: (token, chatId, text, extra = {}) =>
    tgCall(token, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...extra,
    }),

  edit: (token, chatId, messageId, text, extra = {}) =>
    tgCall(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...extra,
    }),

  answer: (token, callbackQueryId, text = "") =>
    tgCall(token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    }),

  deleteMsg: (token, chatId, messageId) =>
    tgCall(token, "deleteMessage", { chat_id: chatId, message_id: messageId }),
};

// ─────────────────────────────────────────────
// SECTION 3 ─ KV helpers
// ─────────────────────────────────────────────

/** List all reminders (keys prefixed reminder:) */
async function listReminders(kv) {
  const list = await kv.list({ prefix: "reminder:" });
  const reminders = [];
  for (const key of list.keys) {
    const val = await kv.get(key.name, "json");
    if (val) reminders.push({ id: key.name.replace("reminder:", ""), ...val });
  }
  return reminders;
}

/** Save a new reminder */
async function saveReminder(kv, reminder) {
  await kv.put(`reminder:${reminder.id}`, JSON.stringify(reminder));
}

/** Delete reminder by uuid */
async function deleteReminder(kv, uuid) {
  await kv.delete(`reminder:${uuid}`);
}

/** Temp wizard state helpers */
const tmp = {
  get: (kv, key) => kv.get(key),
  set: (kv, key, val) => kv.put(key, val, { expirationTtl: 3600 }), // 1 hr TTL
  del: (kv, key) => kv.delete(key),
};

/** Clean up all wizard state for a chat */
async function cleanWizard(kv, chatId) {
  await Promise.all([
    tmp.del(kv, `temp_step:${chatId}`),
    tmp.del(kv, `temp_text:${chatId}`),
    tmp.del(kv, `temp_mode:${chatId}`),
    tmp.del(kv, `temp_jY:${chatId}`),
    tmp.del(kv, `temp_jM:${chatId}`),
    tmp.del(kv, `temp_jD:${chatId}`),
    tmp.del(kv, `temp_hour:${chatId}`),
    tmp.del(kv, `temp_interval:${chatId}`),
    tmp.del(kv, `temp_msgId:${chatId}`), // the wizard message to keep editing
  ]);
}

// ─────────────────────────────────────────────
// SECTION 4 ─ Recurring: compute next trigger
// ─────────────────────────────────────────────

/**
 * Given a triggered reminder, compute the next Unix timestamp.
 *
 * For `monthly`, we work in Tehran local time, increment the Jalali month
 * (wrapping year), and use the proper month length:
 *   - Jalali months 1–6  → 31 days
 *   - Jalali months 7–11 → 30 days
 *   - Jalali month 12    → 29 days (30 in leap years; we use 29 conservatively)
 *
 * This prevents "drift" where adding 30 days to a 31-day month shifts the
 * effective day-of-month forward.
 */
function computeNextTrigger(reminder) {
  const { interval, jY, jM, jD, hour, minute } = reminder;
  if (interval === "daily") {
    return reminder.nextTriggerTime + 86400;
  }
  if (interval === "weekly") {
    return reminder.nextTriggerTime + 7 * 86400;
  }
  if (interval === "monthly") {
    // Increment Jalali month, wrap year
    let ny = jY, nm = jM + 1;
    if (nm > 12) { nm = 1; ny += 1; }

    // Clamp day to the new month's max days to avoid invalid dates
    const monthLengths = [31,31,31,31,31,31,30,30,30,30,30,29]; // index 0=month1
    const maxDay = monthLengths[nm - 1];
    const clampedDay = Math.min(jD, maxDay);

    // Update the stored Jalali fields in the reminder object for future cycles
    reminder.jY = ny;
    reminder.jM = nm;
    reminder.jD = clampedDay;

    return jalaliToUnix(ny, nm, clampedDay, hour, minute);
  }
  return null;
}

// ─────────────────────────────────────────────
// SECTION 5 ─ UI Builder helpers
// ─────────────────────────────────────────────

/** Build a 2-column inline keyboard from an array of [{text, data}] */
function buildKeyboard(buttons, cols = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += cols) {
    rows.push(
      buttons.slice(i, i + cols).map((b) => ({
        text: b.text,
        callback_data: b.data,
      }))
    );
  }
  return { inline_keyboard: rows };
}

// Persian month names
const JALALI_MONTHS = [
  "فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
  "مهر","آبان","آذر","دی","بهمن","اسفند",
];

// ─────────────────────────────────────────────
// SECTION 6 ─ Wizard step renderers
// ─────────────────────────────────────────────

/**
 * Each function renders the UI for a wizard step.
 * They return { text, reply_markup } ready for editMessageText.
 */

function renderModeStep() {
  return {
    text: "🔔 <b>یادآور جدید</b>\n\nنوع یادآور را انتخاب کنید:",
    reply_markup: buildKeyboard([
      { text: "⏱ یک‌بار", data: "wz:mode:once" },
      { text: "🔁 تکرارشونده", data: "wz:mode:recurring" },
    ], 2),
  };
}

function renderIntervalStep() {
  return {
    text: "🔁 <b>تکرار را انتخاب کنید:</b>",
    reply_markup: buildKeyboard([
      { text: "روزانه", data: "wz:interval:daily" },
      { text: "هفتگی", data: "wz:interval:weekly" },
      { text: "ماهانه", data: "wz:interval:monthly" },
    ], 3),
  };
}

function renderMonthStep(mode) {
  return {
    text: `📅 <b>ماه را انتخاب کنید:</b>`,
    reply_markup: buildKeyboard(
      JALALI_MONTHS.map((m, i) => ({ text: m, data: `wz:jM:${i + 1}` })),
      3
    ),
  };
}

function renderDayStep(jM) {
  const maxDay = jM <= 6 ? 31 : jM <= 11 ? 30 : 29;
  const days = [];
  for (let d = 1; d <= maxDay; d++) days.push({ text: String(d), data: `wz:jD:${d}` });
  return {
    text: `📅 <b>روز را انتخاب کنید:</b> (${JALALI_MONTHS[jM - 1]})`,
    reply_markup: buildKeyboard(days, 7),
  };
}

function renderHourStep() {
  const hours = [];
  for (let h = 0; h < 24; h++)
    hours.push({ text: String(h).padStart(2, "0"), data: `wz:hour:${h}` });
  return {
    text: "⏰ <b>ساعت را انتخاب کنید:</b>",
    reply_markup: buildKeyboard(hours, 6),
  };
}

function renderMinuteStep(hour) {
  return {
    text: `⏰ <b>دقیقه را انتخاب کنید:</b> (ساعت ${String(hour).padStart(2, "0")})`,
    reply_markup: buildKeyboard(
      [0, 15, 30, 45].map((m) => ({
        text: String(m).padStart(2, "0"),
        data: `wz:min:${m}`,
      })),
      4
    ),
  };
}

// ─────────────────────────────────────────────
// SECTION 7 ─ Webhook: message handler
// ─────────────────────────────────────────────

async function handleMessage(msg, env) {
  const chatId = String(msg.chat.id);
  const text = msg.text || "";
  const TOKEN = env.TELEGRAM_TOKEN;
  const KV = env.REMINDERS_KV;

  if (text === "/start" || text === "/help") {
    return tg.send(TOKEN, chatId,
      "👋 <b>ربات یادآور شخصی</b>\n\n" +
      "دستورات:\n" +
      "/new — ایجاد یادآور جدید\n" +
      "/list — مشاهده و حذف یادآورها\n\n" +
      "⏱ یادآور یک‌بار: با تاریخ جلالی تنظیم می‌شود.\n" +
      "🔁 یادآور تکرارشونده: روزانه / هفتگی / ماهانه."
    );
  }

  if (text === "/list") {
    return handleList(chatId, TOKEN, KV);
  }

  if (text === "/new") {
    // Start the wizard: send a message and remember its ID for future edits
    const step = renderModeStep();
    const sent = await tg.send(TOKEN, chatId, step.text, { reply_markup: step.reply_markup });
    const msgId = sent?.result?.message_id;
    await Promise.all([
      tmp.set(KV, `temp_step:${chatId}`, "mode"),
      tmp.set(KV, `temp_msgId:${chatId}`, String(msgId)),
    ]);
    return;
  }

  // If the user is in the "awaiting text" step, capture their message
  const step = await tmp.get(KV, `temp_step:${chatId}`);
  if (step === "awaiting_text") {
    await tmp.set(KV, `temp_text:${chatId}`, text);
    await tmp.set(KV, `temp_step:${chatId}`, "mode");

    // Delete user's message to keep the chat clean
    await tg.deleteMsg(TOKEN, chatId, msg.message_id);

    // Edit the wizard message with mode selection
    const msgId = await tmp.get(KV, `temp_msgId:${chatId}`);
    const ui = renderModeStep();
    return tg.edit(TOKEN, chatId, msgId, `📝 متن یادآور ذخیره شد.\n\n${ui.text}`, {
      reply_markup: ui.reply_markup,
    });
  }
}

// ─────────────────────────────────────────────
// SECTION 8 ─ Webhook: callback query handler
// ─────────────────────────────────────────────

async function handleCallbackQuery(cbq, env, ctx) {
  const chatId = String(cbq.message.chat.id);
  const msgId = cbq.message.message_id;
  const data = cbq.data || "";
  const TOKEN = env.TELEGRAM_TOKEN;
  const KV = env.REMINDERS_KV;

  // ── Always answer immediately to stop button spinner ──────────────
  ctx.waitUntil(tg.answer(TOKEN, cbq.id));

  // ── Deletion from /list ──────────────────────────────────────────
  if (data.startsWith("del:")) {
    const uuid = data.slice(4);
    await deleteReminder(KV, uuid);
    // Refresh the list message
    return handleList(chatId, TOKEN, KV, msgId);
  }

  // ── Wizard callbacks ─────────────────────────────────────────────
  if (!data.startsWith("wz:")) return;

  const parts = data.split(":"); // ["wz", "key", "value"]
  const wzKey = parts[1];
  const wzVal = parts[2];

  // Retrieve current wizard message ID (the one we keep editing)
  const wizMsgId = (await tmp.get(KV, `temp_msgId:${chatId}`)) || msgId;

  // ── Step: text entry trigger ─────────────────────────────────────
  // We ask the user to TYPE their reminder text in chat
  if (wzKey === "start_text") {
    await tmp.set(KV, `temp_step:${chatId}`, "awaiting_text");
    return tg.edit(TOKEN, chatId, wizMsgId,
      "✏️ لطفاً متن یادآور را تایپ کنید و ارسال کنید:"
    );
  }

  // ── Step: mode ───────────────────────────────────────────────────
  if (wzKey === "mode") {
    await tmp.set(KV, `temp_mode:${chatId}`, wzVal);

    // Check if we have reminder text yet; if not, ask for it first
    const existingText = await tmp.get(KV, `temp_text:${chatId}`);
    if (!existingText) {
      await tmp.set(KV, `temp_step:${chatId}`, "awaiting_text");
      return tg.edit(TOKEN, chatId, wizMsgId,
        "✏️ لطفاً متن یادآور را تایپ کنید و ارسال کنید:"
      );
    }

    if (wzVal === "recurring") {
      const ui = renderIntervalStep();
      return tg.edit(TOKEN, chatId, wizMsgId, ui.text, { reply_markup: ui.reply_markup });
    } else {
      // once → pick month
      const jY = new Date().getFullYear(); // will refine below
      const ui = renderMonthStep();
      return tg.edit(TOKEN, chatId, wizMsgId, ui.text, { reply_markup: ui.reply_markup });
    }
  }

  // ── Step: interval (recurring) ───────────────────────────────────
  if (wzKey === "interval") {
    await tmp.set(KV, `temp_interval:${chatId}`, wzVal);
    const ui = renderMonthStep();
    return tg.edit(TOKEN, chatId, wizMsgId, ui.text, { reply_markup: ui.reply_markup });
  }

  // ── Step: Jalali month ───────────────────────────────────────────
  if (wzKey === "jM") {
    await tmp.set(KV, `temp_jM:${chatId}`, wzVal);
    const ui = renderDayStep(parseInt(wzVal));
    return tg.edit(TOKEN, chatId, wizMsgId, ui.text, { reply_markup: ui.reply_markup });
  }

  // ── Step: Jalali day ─────────────────────────────────────────────
  if (wzKey === "jD") {
    await tmp.set(KV, `temp_jD:${chatId}`, wzVal);
    const ui = renderHourStep();
    return tg.edit(TOKEN, chatId, wizMsgId, ui.text, { reply_markup: ui.reply_markup });
  }

  // ── Step: hour ───────────────────────────────────────────────────
  if (wzKey === "hour") {
    await tmp.set(KV, `temp_hour:${chatId}`, wzVal);
    const ui = renderMinuteStep(parseInt(wzVal));
    return tg.edit(TOKEN, chatId, wizMsgId, ui.text, { reply_markup: ui.reply_markup });
  }

  // ── Step: minute → FINALIZE ──────────────────────────────────────
  if (wzKey === "min") {
    const minute = parseInt(wzVal);
    const hour = parseInt(await tmp.get(KV, `temp_hour:${chatId}`));
    const jD = parseInt(await tmp.get(KV, `temp_jD:${chatId}`));
    const jM = parseInt(await tmp.get(KV, `temp_jM:${chatId}`));
    const mode = await tmp.get(KV, `temp_mode:${chatId}`);
    const reminderText = await tmp.get(KV, `temp_text:${chatId}`);
    const interval = await tmp.get(KV, `temp_interval:${chatId}`);

    // Compute current Jalali year from today's Tehran local time
    // For simplicity, derive it from the current UTC+3:30 date
    const nowTehran = new Date(Date.now() + (3 * 3600 + 30 * 60) * 1000);
    const jY = gregorianToJalaliYear(
      nowTehran.getUTCFullYear(),
      nowTehran.getUTCMonth() + 1,
      nowTehran.getUTCDate()
    );

    const nextTriggerTime = jalaliToUnix(jY, jM, jD, hour, minute);

    const reminder = {
      id: uuidv4(),
      text: reminderText || "یادآور",
      mode,
      nextTriggerTime,
      ...(mode === "once" ? {} : { interval, jY, jM, jD, hour, minute }),
    };

    await saveReminder(KV, reminder);
    await cleanWizard(KV, chatId);

    const modeLabel = mode === "once" ? "⏱ یک‌بار" : `🔁 ${interval}`;
    const timeStr = unixToTehranString(nextTriggerTime);

    return tg.edit(TOKEN, chatId, wizMsgId,
      `✅ <b>یادآور ثبت شد!</b>\n\n` +
      `📝 متن: ${reminderText}\n` +
      `📅 زمان: ${timeStr}\n` +
      `🔔 نوع: ${modeLabel}`
    );
  }
}

// ─────────────────────────────────────────────
// SECTION 9 ─ /list command handler
// ─────────────────────────────────────────────

async function handleList(chatId, TOKEN, KV, editMsgId = null) {
  const reminders = await listReminders(KV);

  if (reminders.length === 0) {
    const msg = "📭 <b>هیچ یادآوری ثبت نشده است.</b>\n\n/new — ایجاد یادآور جدید";
    return editMsgId
      ? tg.edit(TOKEN, chatId, editMsgId, msg)
      : tg.send(TOKEN, chatId, msg);
  }

  const lines = reminders.map((r, i) => {
    const time = unixToTehranString(r.nextTriggerTime);
    const type = r.mode === "once" ? "⏱" : "🔁";
    return `${i + 1}. ${type} <b>${r.text}</b>\n   📅 ${time}`;
  });

  const text = `🗒 <b>یادآورهای فعال (${reminders.length})</b>\n\n${lines.join("\n\n")}`;

  const deleteButtons = reminders.map((r) => ({
    text: `🗑 حذف #${reminders.indexOf(r) + 1}`,
    data: `del:${r.id}`,
  }));

  const keyboard = buildKeyboard(deleteButtons, 2);

  return editMsgId
    ? tg.edit(TOKEN, chatId, editMsgId, text, { reply_markup: keyboard })
    : tg.send(TOKEN, chatId, text, { reply_markup: keyboard });
}

// ─────────────────────────────────────────────
// SECTION 10 ─ Cron Job: check and fire reminders
// ─────────────────────────────────────────────

/**
 * Cron loop — runs every 15 minutes.
 *
 * Logic:
 *  1. Fetch all keys with prefix "reminder:".
 *  2. For each, parse the JSON and check if nextTriggerTime ≤ now.
 *  3. If due:
 *     a. Send the Telegram notification.
 *     b. If mode=once → delete from KV.
 *     c. If mode=recurring → compute next trigger, update KV.
 *
 * The 15-minute cron granularity matches our forced 15-min minute intervals,
 * ensuring no reminder is ever missed by more than 15 minutes.
 */
async function handleCron(env) {
  const KV = env.REMINDERS_KV;
  const TOKEN = env.TELEGRAM_TOKEN;
  const chatId = env.MY_CHAT_ID;
  const nowSec = Math.floor(Date.now() / 1000);

  const list = await KV.list({ prefix: "reminder:" });

  await Promise.all(
    list.keys.map(async (key) => {
      const reminder = await KV.get(key.name, "json");
      if (!reminder) return;

      if (reminder.nextTriggerTime > nowSec) return; // not yet due

      // ── Fire the reminder ───────────────────────────────────────
      const typeIcon = reminder.mode === "once" ? "⏱" : "🔁";
      await tg.send(TOKEN, chatId,
        `🔔 <b>یادآور!</b>\n\n${typeIcon} ${reminder.text}`
      );

      if (reminder.mode === "once") {
        // One-shot: delete immediately
        await KV.delete(key.name);
      } else {
        // Recurring: compute next trigger time (mutates reminder.jY/jM/jD for monthly)
        const next = computeNextTrigger(reminder);
        if (next) {
          reminder.nextTriggerTime = next;
          await KV.put(key.name, JSON.stringify(reminder));
        } else {
          // Fallback: delete malformed recurring reminder
          await KV.delete(key.name);
        }
      }
    })
  );
}

// ─────────────────────────────────────────────
// SECTION 11 ─ Gregorian year extraction helper
// ─────────────────────────────────────────────

/**
 * Returns the Jalali year for a given Gregorian date.
 * Used to determine the current year when finalizing a reminder.
 *
 * Simplified: Jalali year ≈ Gregorian year − 621, adjusted for
 * the Nowruz boundary (≈ March 20–21).
 */
function gregorianToJalaliYear(gY, gM, gD) {
  // Nowruz is typically on March 20 or 21
  const isBeforeNowruz = gM < 3 || (gM === 3 && gD < 21);
  return gY - 621 - (isBeforeNowruz ? 1 : 0);
}

// ─────────────────────────────────────────────
// SECTION 12 ─ Worker entry point
// ─────────────────────────────────────────────

export default {
  /**
   * fetch handler — processes incoming Telegram Webhook updates.
   * Telegram sends one POST per update to: https://<your-worker>.workers.dev/
   */
  async fetch(request, env, ctx) {
    // Only allow POST (Telegram webhooks are always POST)
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // ── Security Gate ─────────────────────────────────────────────
    // Determine the originating chat ID from the update
    const incomingChatId = String(
      update?.message?.chat?.id ||
      update?.callback_query?.message?.chat?.id ||
      ""
    );

    if (incomingChatId !== String(env.MY_CHAT_ID)) {
      // Silently drop unauthorized updates
      return new Response("OK", { status: 200 });
    }

    // ── Route to handler ─────────────────────────────────────────
    if (update.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    } else if (update.callback_query) {
      ctx.waitUntil(handleCallbackQuery(update.callback_query, env, ctx));
    }

    // Return 200 quickly so Telegram doesn't retry
    return new Response("OK", { status: 200 });
  },

  /**
   * scheduled handler — Cloudflare Cron Trigger.
   * Configure in wrangler.toml:
   *   [triggers]
   *   crons = ["*\/15 * * * *"]
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  },
};
