# VoicePay

Talk through a payment, approve it with Face ID or Touch ID. **Simulation only: no real money moves.**

How it works: verify a phone number, use its country and currency, describe the payment by voice
or text, review the details, then approve with this device's built-in authenticator. A Groq language
model interprets commands and the server checks them. If the model is unavailable, simple rules still
understand common commands.

Phone sign-in uses Firebase Authentication. The verified phone region selects that user's country and
currency; India (INR) is the default before sign-in. The model receives the selected currency and
destination context at request time, so it is not trained for Ghana or retrained for each country.
Phone formats and current country currencies come from international metadata libraries.

The payment screen can prepare a cross-border demo route using a selected destination country or a
phone contact. It does not call a remittance provider, calculate an exchange rate, or move money.

The interface has separate Home, Pay, Balance, Activity, Device Security, and Settings views. Balance
and Activity hide again when you leave their screens. The opening view introduces the demo before a
visitor starts a payment.

## 1. Install (5 minutes)

```
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # Windows: copy .env.example .env
```

Open Firebase Console, create a project and web app, enable Phone sign-in, set the SMS region policy,
and add your deployed domain to Authorized domains. Link a Cloud Billing account; Firebase may charge
for SMS. For local development, use Firebase's fictional test phone numbers; live web phone auth needs
an authorized hosted domain. Copy the Web app's API key, Auth domain, Project ID, and App ID into `.env`. Create a service
account for Firebase Admin, download its private JSON, and set that JSON as
`FIREBASE_SERVICE_ACCOUNT_JSON`. Never commit the service account key.

```
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Paste that generated value into `SETUP_TOKEN`. Keep all keys private. `SETUP_TOKEN` only protects owner diagnostics; users register their own
device after verifying their phone number.

Check everything before you start:

```
python check_setup.py --live
```

Every line should say `[ok]`. Fix anything marked `[FIX]`.

## 2. Run on your laptop

```
python app.py
```

Open http://localhost:5000 in Chrome. `localhost` is allowed to use Face ID / Touch ID / Windows Hello
without https, so you can build and test here first.

1. Open **Account**, select your country, enter your phone number, and verify the SMS code.
2. Open **Secure**, tap **Prepare device**, then confirm on your phone or computer.
3. Tap **Pay**, then say or type a payment request.
4. Check the ticket, then tap **Approve** and confirm with your device.

## 3. Run on your phone (for the demo)

Phones need an https address. Use a tunnel:

```
ngrok http 5000
```

Copy the https address it prints, for example `https://abc123.ngrok-free.app`, then put it in `.env`:

```
RP_ID=abc123.ngrok-free.app
ORIGIN=https://abc123.ngrok-free.app
```

`RP_ID` is the address **without** `https://`. Restart `python app.py`, run `python check_setup.py`,
open the https address on your phone, verify your number, then follow the device setup steps.

Important: device approval is tied to one site address. If the tunnel address changes, update
`.env`, restart, and register a device again on the new address.
The free ngrok plan may show a "Visit site" warning page the first time: tap through it once.

## 3b. Deploy on Render

In the Render dashboard create a **Web Service** from your GitHub repo and use exactly:

| Setting | Value |
|---|---|
| Runtime | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `gunicorn app:app --workers 1 --threads 4` |
| Instance count | 1 (pending approvals and conversations are held in memory) |

Use one worker: pending approvals and conversations live in process memory. Verified users have separate simulated balances, histories, country settings, and device credentials in SQLite.

Under **Environment** add these variables:

| Variable | Value |
|---|---|
| `GROQ_API_KEY` | your Groq key |
| `RP_ID` | your Render address **without** https, for example `voicepay-ab12.onrender.com` |
| `ORIGIN` | the same address **with** https, for example `https://voicepay-ab12.onrender.com` |
| `SETUP_TOKEN` | optional long random owner secret for private diagnostics |
| `FIREBASE_API_KEY` | Firebase Web app API key |
| `FIREBASE_AUTH_DOMAIN` | Firebase Web app auth domain |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_APP_ID` | Firebase Web app ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | private service account JSON for server-side token verification |
| `ALLOW_RESET` | `0` (reset is disabled by default) |
| `PROXY_FIX_HOPS` | `1` for the single trusted Render proxy |
| `REDIS_URL` | a Redis connection URL for rate limits shared across workers/instances |
| `PYTHON_VERSION` | `3.12.3` |

Your exact address is shown at the top of the service page in Render. Save the variables and let it redeploy.
`/api/health` is a minimal liveness check for Render. Detailed diagnostics and the optional Groq check are owner-only at `/api/health/details?live=1`; send the setup token in an `Authorization: Bearer ...` header.

Keep one app worker/instance: pending approvals and conversations are in process memory. Accounts and ledgers are in SQLite, but Render's free filesystem is ephemeral. Use managed Postgres and shared challenge/session storage before running multiple instances or treating account data as durable. Redis shares rate limits. Without `REDIS_URL`, rate limits are in process memory and reset on restart.

Render's free filesystem is ephemeral, so SQLite account, ledger, and device data may be lost after a
restart or redeploy. Open the site before your demo to wake it and verify sign-in and device setup.

## 4. How the conversation works

You can give everything in one sentence, or let the assistant ask for what is missing:

> **You:** I want to send some money
> **VoicePay:** How much would you like to send?
> **You:** Five hundred rupees
> **VoicePay:** Got it, INR 500.00. Who should receive it?
> **You:** Priya
> **VoicePay:** Got it, to Priya. What is it for? You can say skip.
> **You:** Lunch
> *(confirmation ticket appears: tap Approve and use your face or fingerprint)*

- Say "send 500 rupees to Priya for lunch" to skip all the questions.
- While the ticket is showing you can still change it ("make it 60") or say "cancel".
- Voice replies and automatic listening are **off by default**. Turn them on with the header control; tap the mic to start a voice command.
- Typed and browser-recognized text is sent to this server and may be processed by Groq. If browser speech recognition is unavailable, microphone audio is sent to Groq for transcription and is not stored by VoicePay.
  (iPhone Safari cannot start the mic on its own: tap the mic, or type.)
- Device confirmation always needs a tap. A browser will not let a voice command trigger it.
- On the web, Face ID / Touch ID is reached through WebAuthn's platform authenticator. The website cannot call a separate raw Face ID API; the browser may label this a passkey. The device can also request a screen lock or PIN. A native iOS/Android app would be needed for a platform-specific native flow.
- The browser biometric prompt may be generic and may not display the payee or amount. The server challenge binds amount, recipient, note, payment ID, and browser session; check the visible ticket before approving. Native payment details need a separate Secure Payment Confirmation registration/Payment Request flow, which this prototype does not implement.
- The contact picker uses the browser's explicit contact-selection permission where supported. A selected phone is used only to identify its destination country and show its last four digits on the ticket; VoicePay does not send the number to Groq or store it in the ledger. You can also type a recipient name directly; review it on the approval ticket.
- Choose a destination country for a cross-border demo. It records the source and destination currencies but does not quote FX, connect to a remittance provider, or move funds.
- India is the default country. A verified phone number selects the account country and currency. The amount parser receives that currency as context and accepts number words, digits, and common currency symbols/codes.
- The demo daily limit is 500 units in the selected account currency. Change it at the top of `app.py`.

## 4b. Balance privacy

The balance is **never shown by default** and never leaves the server unless you prove it is you:

| Where the balance could leak | What VoicePay does |
|---|---|
| The page and `/api/state` | Not included. The page shows `••••••`. |
| Payment history | Not included in `/api/state`. `/api/history/reveal` requires a fresh, one-time biometric signature; the page hides it again after 10 seconds or when you switch tabs. |
| Chat replies and spoken replies | Never contain it. "What is my balance?" only points to the Show balance button. |
| The AI model (Groq) | Never sees the balance. It gets the selected account and destination currency plus the payment sentence to parse amount / recipient / note. The server decides every next step. |
| Showing it on screen | Only `/api/balance/reveal`, which needs a fresh Face ID / Touch ID signature tied to that one request. It works once, then the page hides it again after 10 seconds, when you switch tabs, or when you tap Hide now. |
| Guessing balance or daily spend by trying amounts | Funds and daily limits are checked only after Face ID. Before then, every eligible amount gets the same review flow. |
| Someone else's browser | Every browser gets its own private session. A ticket or unlock from one browser is rejected in another. |
| Brute force | Three failed biometric attempts lock the browser session for a minute. Requests are rate limited; Redis can share rate limits across workers. |
| Replaying a signature | A payment approval cannot be reused to unlock the balance, or the other way round. |
| Account separation | A verified phone owns its own account, currency ledger, history, and device credentials. |

Run `python test_privacy.py` to check the privacy flow. It plays a phone with Face ID and checks that ordinary API replies disclose neither balance nor history.

Each verified phone has its own simulated opening balance and ledger. The append-only SQLite ledger uses an idempotency key per payment. Phone numbers, passkey public keys, and account records are stored server-side; biometric data and private signing keys stay on the device. This is still a demo, not a real payment service. Production needs durable managed storage, recovery and audit flows, notifications, service abuse controls, and an independent security review.

## 5. Two-minute demo script

1. Say the problem: paying by voice is convenient but easy to abuse, and PINs are weak.
2. Say "I want to pay someone" and let VoicePay ask the questions. Point out the balance is hidden.
3. Approve with Face ID / Touch ID. Then say "what is my balance?" and unlock it with Face ID: it shows for 10 seconds and disappears.
4. Show a failure: say a payment over the limit, or cancel the biometric prompt.
5. Say why it is safe: voice is only the command. The biometric signs this exact payment, each approval
   works once, it expires after two minutes, and the biometric never leaves the phone.

Reset is **off by default**. For a controlled local demo, set `ALLOW_RESET=1`; the button is then shown. Reset appends an adjustment entry and leaves payment history intact. Leave it off on any publicly reachable deployment.

Each account has a separate demo ledger. Do not put real payment or sensitive personal information into it.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| Biometric registration does not work | Check `RP_ID` and `ORIGIN` in owner-only `/api/health/details` and confirm they match the browser address. |
| Face ID / Touch ID button does nothing or says it needs https | Use `localhost` on a laptop, or the https tunnel address on a phone. |
| "Could not register this device" | `RP_ID` or `ORIGIN` does not match the address in the browser. Run `python check_setup.py`. |
| Phone code will not send | Check Firebase Phone sign-in, the SMS region policy, authorized domain, web config, billing status, and service account credentials. |
| Device registration does not appear | Verify your phone number first, then open **Secure** and tap **Prepare device**. |
| Approval says "Biometric check failed" | You are on a different address than the one you registered on. Update `.env`, restart, register again. |
| Mic does nothing | Open the site over HTTPS, allow microphone access, and tap the mic again. VoicePay uses browser recognition when available and Groq transcription as a fallback. |
| Speech is misheard | Choose the available English speech locale that matches your accent; review the transcript before it is sent. |
| Voice recognition is unavailable | Try the mic recorder fallback or use the text field. Voice transcripts are shown for review before sending. |
| Enhanced command understanding is unavailable | The Groq key may be missing or rate limited. Basic amount and contact commands still work. |
| Groq says a model was not found | Groq changes its model list. Set `GROQ_MODELS` in `.env` to current model names from the Groq console. |

## Files

- `app.py`: the whole backend (conversation, AI parsing, rules, WebAuthn, ledger)
- `test_privacy.py`: proves the balance and approvals are protected
- `static/index.html`, `static/style.css`, `static/app.js`: the page
- `check_setup.py`: tests your setup
- `voicepay.sqlite3`: account, passkey public keys, auth sessions, and append-only demo ledgers; created on first run and ignored by Git
- Legacy `data.json`: read only during migration from an earlier single-user version; keep it private and never commit it
