# VoicePay

Talk through a payment, approve it with Face ID or Touch ID. **Simulation only: no real money moves.**

How it works: the browser turns your voice into text, a Groq AI model turns the text into
`{amount, recipient, note}`, the server checks the rules (contacts, balance, daily limit), and your
phone approves *that exact payment* with its fingerprint or face (WebAuthn). If the AI is down,
simple rules still understand common commands.

## 1. Install (5 minutes)

```
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # Windows: copy .env.example .env
```

Open `.env`, paste your free Groq API key after `GROQ_API_KEY=`, and set `SETUP_TOKEN` to a long random secret. For example:

```
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Keep this owner setup token private. It is required to register or replace the approving device.

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

1. Enter the owner setup token, tap **Step 1: Prepare setup**, then **Step 2: Scan with Face ID / Touch ID**.
2. Tap the mic and say: *Send 50 cedis to Kofi for lunch.* (or use **Type instead**)
3. Check the ticket, then tap **Approve** and use your fingerprint or face.

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
open the https address on your phone, enter the owner token, then follow the two setup steps.

Important: Face ID / Touch ID is registered for one address. If the tunnel address changes, update
`.env`, restart, and register again. A credential saved for another address is ignored automatically.
The free ngrok plan may show a "Visit site" warning page the first time: tap through it once.

## 3b. Deploy on Render

In the Render dashboard create a **Web Service** from your GitHub repo and use exactly:

| Setting | Value |
|---|---|
| Runtime | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `gunicorn app:app --workers 1 --threads 4` |
| Instance count | 1 (pending approvals and conversations are held in memory) |

Use one worker: pending approvals and conversations live in process memory. The append-only demo ledger is in SQLite.

Under **Environment** add these variables:

| Variable | Value |
|---|---|
| `GROQ_API_KEY` | your Groq key |
| `RP_ID` | your Render address **without** https, for example `voicepay-ab12.onrender.com` |
| `ORIGIN` | the same address **with** https, for example `https://voicepay-ab12.onrender.com` |
| `SETUP_TOKEN` | a long random owner secret; required to register the approving device |
| `ALLOW_RESET` | `0` (reset is disabled by default) |
| `PROXY_FIX_HOPS` | `1` for the single trusted Render proxy |
| `REDIS_URL` | a Redis connection URL for rate limits shared across workers/instances |
| `PYTHON_VERSION` | `3.12.3` |

Your exact address is shown at the top of the service page in Render. Save the variables and let it redeploy.
`/api/health` is a minimal liveness check for Render. Detailed diagnostics and the optional Groq check are owner-only at `/api/health/details?live=1`; send the setup token in an `Authorization: Bearer ...` header.

Keep one app worker/instance: pending approvals and conversations are in process memory. The ledger is append-only SQLite, but Render's free filesystem is ephemeral. Use a persistent disk for demos that must survive deploys; use managed Postgres before running multiple instances or treating the ledger as production data. Redis shares rate limits. Without `REDIS_URL`, rate limits are in process memory and reset on restart.

Render's free filesystem is ephemeral, so SQLite ledger data and the registered credential may be lost
after a restart or redeploy. Attach persistent storage for a demo that needs to retain them. Open the site
before your demo to wake it and verify device registration.

## 4. How the conversation works

You can give everything in one sentence, or let the assistant ask for what is missing:

> **You:** I want to send some money
> **VoicePay:** How much would you like to send?
> **You:** Fifty cedis
> **VoicePay:** Got it, GHS 50.00. Who should receive it?
> **You:** Kofi
> **VoicePay:** Got it, to Kofi. What is it for? You can say skip.
> **You:** Lunch
> *(confirmation ticket appears: tap Approve and use your face or fingerprint)*

- Say "send 50 cedis to Kofi for lunch" to skip all the questions.
- While the ticket is showing you can still change it ("make it 60") or say "cancel".
- Voice replies and automatic listening are **off by default**. Turn them on with the header control; tap the mic to start a voice command.
- Typed/recognized text is sent to this demo server and may be processed by Groq when enabled. When you use the mic, your browser's speech recognition service may process the audio.
  (iPhone Safari cannot start the mic on its own: tap the mic, or type.)
- The Face ID / Touch ID step always needs a tap. A browser will not let a voice command trigger it, and that is the point.
- The browser biometric prompt may be generic and may not display the payee or amount. The server challenge binds amount, recipient, note, payment ID, and browser session; check the visible ticket before approving. Native payment details need a separate Secure Payment Confirmation registration/Payment Request flow, which this prototype does not implement.
- Allowed contacts: Kofi, Ama, Mum, Kwame. Daily limit: GHS 500. Change both at the top of `app.py`.

## 4b. Balance privacy

The balance is **never shown by default** and never leaves the server unless you prove it is you:

| Where the balance could leak | What VoicePay does |
|---|---|
| The page and `/api/state` | Not included. The page shows `••••••`. |
| Payment history | Not included in `/api/state`. `/api/history/reveal` requires a fresh, one-time biometric signature; the page hides it again after 10 seconds or when you switch tabs. |
| Chat replies and spoken replies | Never contain it. "What is my balance?" only points to the Show balance button. |
| The AI model (Groq) | Never sees it. It only turns a sentence into amount / recipient / note. The server decides every next step. |
| Showing it on screen | Only `/api/balance/reveal`, which needs a fresh Face ID / Touch ID signature tied to that one request. It works once, then the page hides it again after 10 seconds, when you switch tabs, or when you tap Hide now. |
| Guessing balance or daily spend by trying amounts | Funds and daily limits are checked only after Face ID. Before then, every eligible amount gets the same review flow. |
| Someone else's browser | Every browser gets its own private session. A ticket or unlock from one browser is rejected in another. |
| Brute force | Three failed biometric attempts lock the browser session for a minute. Requests are rate limited; Redis can share rate limits across workers. |
| Replaying a signature | A payment approval cannot be reused to unlock the balance, or the other way round. |
| Taking over the account | Once a device is registered, nobody else can register another (set `ALLOW_REREGISTER=1` to replace it). |

Run `python test_privacy.py` to check the privacy flow. It plays a phone with Face ID and checks that ordinary API replies disclose neither balance nor history.

The ledger is append-only SQLite with an idempotency key per payment. A small `data.json` stores the demo credential's public key and sign counter. Neither file is encrypted. The deployment still has one hardcoded demo user and one passkey; this is not an account system. Production use needs managed durable storage, accounts, passkey recovery, audit and notification flows, and an independent security review.

## 5. Two-minute demo script

1. Say the problem: paying by voice is convenient but easy to abuse, and PINs are weak.
2. Say "I want to pay someone" and let VoicePay ask the questions. Point out the balance is hidden.
3. Approve with Face ID / Touch ID. Then say "what is my balance?" and unlock it with Face ID: it shows for 10 seconds and disappears.
4. Show a failure: say a payment over the limit, or cancel the biometric prompt.
5. Say why it is safe: voice is only the command. The biometric signs this exact payment, each approval
   works once, it expires after two minutes, and the biometric never leaves the phone.

Reset is **off by default**. For a controlled local demo, set `ALLOW_RESET=1`; the button is then shown. Reset appends an adjustment entry and leaves payment history intact. Leave it off on any publicly reachable deployment.

The demo ledger and recent payment history are shared by all visitors to the same deployment. Do not put personal or real financial information into it.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| Biometric registration does not work | Check `RP_ID` and `ORIGIN` in owner-only `/api/health/details` and confirm they match the browser address. |
| Face ID / Touch ID button does nothing or says it needs https | Use `localhost` on a laptop, or the https tunnel address on a phone. |
| "Could not register this device" | `RP_ID` or `ORIGIN` does not match the address in the browser. Run `python check_setup.py`. |
| Setup asks for an owner token | Set `SETUP_TOKEN` in `.env` or the host's environment settings, restart/redeploy, then enter that token when setting up the device. |
| "A device is already registered" | Set `ALLOW_REREGISTER=1`, then register with the owner setup token to replace the device. |
| Approval says "Biometric check failed" | You are on a different address than the one you registered on. Update `.env`, restart, register again. |
| Mic does nothing | Allow the microphone for the site. Use Chrome (Android or desktop). On iPhone use **Type instead** as the backup. |
| Speech is misheard | Choose English (Ghana), English (UK), or English (US) from the language selector; review the transcript before it is sent. |
| Voice recognition is unavailable | Use the text field. Voice transcripts are not submitted until the short review window ends. |
| Enhanced command understanding is unavailable | The Groq key may be missing or rate limited. Basic amount and contact commands still work. |
| Groq says a model was not found | Groq changes its model list. Set `GROQ_MODELS` in `.env` to current model names from the Groq console. |

## Files

- `app.py`: the whole backend (conversation, AI parsing, rules, WebAuthn, ledger)
- `test_privacy.py`: proves the balance and approvals are protected
- `static/index.html`, `static/style.css`, `static/app.js`: the page
- `check_setup.py`: tests your setup
- `voicepay.sqlite3`: append-only demo ledger; created on first run and ignored by Git
- `data.json`: stores the demo WebAuthn credential public key and sign counter; never commit it
