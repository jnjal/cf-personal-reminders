# 🔔 Personal Telegram Reminder Bot
### Cloudflare Worker · KV Storage · Jalali Calendar · Zero Cost

A production-ready, serverless Telegram bot that runs entirely on **Cloudflare's free tier** — no server, no database fees, no maintenance. Set reminders using the **Persian (Jalali) calendar**, with support for one-time and recurring alerts (daily, weekly, monthly). Built as a single JavaScript file using ES Modules.

```
You → /new → Interactive Wizard → Reminder saved in KV
                                        ↓
                              Cron fires every 15 min
                                        ↓
                              🔔 Telegram notification
```

---

## ✨ Features

- **Jalali date input** — set reminders using Persian month names (فروردین → اسفند)
- **One-time reminders** — fire once at a specific date and time, then auto-delete
- **Recurring reminders** — daily, weekly, or monthly with correct Jalali month-length handling (no date drift)
- **Inline wizard UI** — entire setup flow edits a single message; no chat spam
- **Instant button response** — spinner dismissed immediately via `answerCallbackQuery`
- **15-minute precision** — cron triggers every 15 min, minutes locked to `00 / 15 / 30 / 45`
- **Private & secure** — hard-locked to your `MY_CHAT_ID`; all other users are silently dropped
- **Zero dependencies** — single `.js` file, no npm, no build step
- **Tehran timezone** — fixed UTC+03:30 offset (DST abolished in Iran since 2005)

---

## 📋 Prerequisites

Before you start, make sure you have:

- A **Cloudflare account** (free tier is enough) → [dash.cloudflare.com](https://dash.cloudflare.com)
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather)
- Your **Telegram Chat ID** (get it from [@userinfobot](https://t.me/userinfobot))

---

## 🚀 Deployment Guide

### Step 1 — Create a KV Namespace

1. Go to **Cloudflare Dashboard → Workers & Pages → KV**
2. Click **Create a namespace**
3. Name it `REMINDERS_KV` (or anything you like)
4. Copy the **Namespace ID** — you'll need it in `wrangler.toml`

---

### Step 2 — Deploy the Worker

#### Option A: Cloudflare Quick Editor (no CLI needed)

1. Go to **Workers & Pages → Create application → Create Worker**
2. Give it a name (e.g. `reminder-bot`) and click **Deploy**
3. Click **Edit code**
4. Delete all default code and paste the contents of `worker.js`
5. Click **Save and Deploy**

#### Option B: Wrangler CLI

```bash
# Install Wrangler
npm install -g wrangler

# Login
wrangler login

# Deploy
wrangler deploy
```

With this `wrangler.toml` in your project folder:

```toml
name = "reminder-bot"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "REMINDERS_KV"
id = "REMINDERS_KV"

[triggers]
crons = ["*/15 * * * *"]
```

---

### Step 3 — Bind the KV Namespace

#### If using Quick Editor:
1. In your Worker page, go to **Settings → Bindings**
2. Click **Add binding → KV Namespace**
3. Set **Variable name** to `REMINDERS_KV`
4. Select the namespace you created in Step 1
5. Click **Save**

---

### Step 4 — Set Environment Variables

Go to **Worker → Settings → Variables and Secrets**.

| Variable | Type | Value |
|---|---|---|
| `TELEGRAM_TOKEN` | **Secret** | `123456:ABCdef...` (from BotFather) |
| `MY_CHAT_ID` | Plain text | Your numeric Telegram ID |

> ⚠️ Always add `TELEGRAM_TOKEN` as a **Secret**, not a plain variable, so it's encrypted at rest.

---

### Step 5 — Set up the Cron Trigger

#### If using Quick Editor:
1. Go to **Worker → Triggers → Cron Triggers**
2. Click **Add Cron Trigger**
3. Enter: `*/15 * * * *`
4. Click **Add**

#### If using Wrangler:
Already included in `wrangler.toml` from Step 2. Wrangler sets it automatically on deploy.

---

### Step 6 — Register the Telegram Webhook

Open this URL in your browser (replace the placeholders):

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<YOUR_WORKER_NAME>.<YOUR_SUBDOMAIN>.workers.dev/
```

You should receive:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

To verify it's working:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo
```

---

## 💬 Bot Commands

| Command | Description |
|---|---|
| `/start` | Show welcome message and command list |
| `/help` | Same as `/start` |
| `/new` | Open the reminder creation wizard |
| `/list` | View all active reminders with delete buttons |

---

## 🧭 Creating a Reminder — Wizard Flow

### One-time reminder (`/new` → ⏱ یک‌بار)

```
/new
 └─ Choose type: [⏱ یک‌بار] [🔁 تکرارشونده]
      └─ Type your reminder text in chat
           └─ Choose month: [فروردین] [اردیبهشت] ... [اسفند]
                └─ Choose day: [1] [2] ... [31]
                     └─ Choose hour: [00] [01] ... [23]
                          └─ Choose minute: [00] [15] [30] [45]
                               └─ ✅ Reminder saved!
```

### Recurring reminder (`/new` → 🔁 تکرارشونده)

```
/new
 └─ Choose type: [⏱ یک‌بار] [🔁 تکرارشونده]
      └─ Choose interval: [روزانه] [هفتگی] [ماهانه]
           └─ Type your reminder text in chat
                └─ (same month/day/hour/minute steps as above)
                     └─ ✅ Reminder saved! Next trigger auto-calculated.
```

---

## 🗃️ KV Data Schema

### Reminder record — key: `reminder:<uuid>`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Take medication",
  "mode": "recurring",
  "nextTriggerTime": 1748000000,
  "interval": "monthly",
  "jY": 1404,
  "jM": 3,
  "jD": 15,
  "hour": 9,
  "minute": 0
}
```

For `once` mode, the `interval`, `jY`, `jM`, `jD`, `hour`, `minute` fields are omitted. The record is **deleted** immediately after firing.

### Wizard state keys (TTL: 1 hour)

| Key | Value |
|---|---|
| `temp_step:<chatId>` | Current wizard step |
| `temp_text:<chatId>` | Reminder text typed by user |
| `temp_mode:<chatId>` | `once` or `recurring` |
| `temp_jM:<chatId>` | Selected Jalali month (1–12) |
| `temp_jD:<chatId>` | Selected Jalali day |
| `temp_hour:<chatId>` | Selected hour (0–23) |
| `temp_interval:<chatId>` | `daily` / `weekly` / `monthly` |
| `temp_msgId:<chatId>` | Message ID of the wizard message |

All wizard keys are automatically cleaned up after a reminder is saved, or expire after 1 hour if the wizard is abandoned.

---

## 🗓️ Jalali Calendar Notes

### Month lengths used internally

| Months | Days |
|---|---|
| فروردین → شهریور (1–6) | 31 days |
| مهر → بهمن (7–11) | 30 days |
| اسفند (12) | 29 days (30 in leap years) |

### Why month-aware recurrence matters

Adding a fixed number of days to a monthly reminder causes **date drift** — e.g., a reminder set on the 31st of Farvardin would shift forward over months that have fewer days. Instead, the bot stores the original Jalali `jY/jM/jD` fields and **recomputes the correct timestamp** for the next Jalali month on every trigger.

### Tehran timezone

Iran uses a fixed offset of **UTC+03:30** (12,600 seconds). Daylight saving time was permanently abolished in 2005. This is hardcoded in the Jalali-to-Unix conversion function and requires no runtime lookup.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│           Cloudflare Worker                 │
│                                             │
│  fetch handler  ◄──── Telegram Webhook      │
│       │                                     │
│       ├── Security gate (MY_CHAT_ID check)  │
│       ├── /new  → Wizard (editMessageText)  │
│       ├── /list → Inline delete buttons     │
│       └── callback_query → wz:* / del:*     │
│                                             │
│  scheduled handler  ◄──── Cron */15 min     │
│       │                                     │
│       └── Scan KV → fire due reminders      │
│               ├── once     → send + DELETE  │
│               └── recurring → send + UPDATE │
│                                             │
│  Cloudflare KV                              │
│       ├── reminder:<uuid>  (persistent)     │
│       └── temp_*:<chatId>  (TTL 1hr)        │
└─────────────────────────────────────────────┘
```

---

## 🔐 Security

- Every incoming Telegram update is checked against `MY_CHAT_ID` before any processing occurs.
- Updates from any other user are **silently dropped** with a `200 OK` response (no error leakage).
- `TELEGRAM_TOKEN` is stored as a Cloudflare **Secret** (encrypted, never visible in logs).
- Wizard state keys have a **1-hour TTL** so abandoned sessions don't linger in KV.

---

## 💡 Cloudflare Free Tier Limits

This project is designed to stay well within free limits:

| Resource | Free Limit | This Bot's Usage |
|---|---|---|
| Worker requests | 100,000/day | ~96/day (cron) + interactions |
| KV reads | 100,000/day | Low |
| KV writes | 1,000/day | Very low |
| Cron triggers | Unlimited | 96/day |

---

## 🛠️ Troubleshooting

**Bot doesn't respond**
- Verify the webhook is set correctly with `getWebhookInfo`
- Check that `TELEGRAM_TOKEN` and `MY_CHAT_ID` are both set under Worker → Settings → Variables

**Reminders not firing**
- Confirm the Cron trigger `*/15 * * * *` is listed under Worker → Triggers
- Check that `REMINDERS_KV` binding is set correctly under Settings → Bindings

**"Webhook was not set" error**
- Make sure your worker URL ends with `/` when calling `setWebhook`
- Confirm the worker is deployed and returning `200 OK` on GET requests

**Getting your Chat ID**
- Message [@userinfobot](https://t.me/userinfobot) on Telegram — it replies with your numeric ID instantly

---

## 📄 License

MIT — free to use, modify, and deploy for personal or commercial use.
