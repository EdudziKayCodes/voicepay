'use strict';

/* VoicePay front end. Simulation only.
   Flow: talk or type -> /api/chat (guided questions) -> confirm ticket -> Face ID -> /api/approve.
   The balance is never in /api/state or in any chat reply. It is fetched only by unlock(),
   after a Face ID / Touch ID check, and wiped again after a few seconds. */

const $ = (id) => document.getElementById(id);
const HIDDEN_BALANCE = '\u2022\u2022\u2022\u2022\u2022\u2022';

let LANG = 'en-GH';

const app = {
  currency: 'GHS',
  registered: false,
  txn: null,
  regOptions: null,
  setupToken: null,
  revealOptions: null,
  revealAt: 0,
  revealTimer: null,
  historyOptions: null,
  historyAt: 0,
  historyTimer: null,
  revealFetching: false,
  historyFetching: false,
  challengeTimer: null,
  voiceTimer: null,
  recognizer: null,
  listening: false,
  approving: false,
  busy: false,
  deadline: 0,
  timer: null,
  sound: false, // voice mode is opt-in
  lastPayment: null,
  recentContacts: [],
};

/* ---------- helpers ---------- */

function b64uToBuf(value) {
  let s = value.split('-').join('+').split('_').join('/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function bufToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).split('+').join('-').split('/').join('_').split('=').join('');
}

async function api(path, body) {
  const options = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, options);
  } catch (e) {
    throw new Error('VoicePay could not connect. Check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* the reply was not JSON */ }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || 'Request failed (' + res.status + ').');
    err.data = data || {};
    err.status = res.status;
    throw err;
  }
  return data;
}

function formatMoney(value) {
  return app.currency + ' ' + Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function say(text, kind) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function webauthnProblem(e) {
  switch (e && e.name) {
    case 'NotAllowedError': return 'Cancelled or timed out. Try again.';
    case 'InvalidStateError': return 'This device is already registered.';
    case 'SecurityError': return 'This address cannot use Face ID / Touch ID. Open VoicePay over https or localhost.';
    case 'NotSupportedError': return 'This device cannot create a Face ID / Touch ID credential.';
    default: return (e && e.message) || 'Something went wrong with Face ID / Touch ID.';
  }
}

function canUseBiometrics() {
  return window.isSecureContext && window.PublicKeyCredential && navigator.credentials;
}

/* ---------- conversation ---------- */

function addMessage(who, text, isError) {
  const li = document.createElement('li');
  li.className = 'msg ' + who + (isError ? ' error' : '');
  li.textContent = text;
  $('log').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}

function setChips(chips) {
  const box = $('chips');
  box.textContent = '';
  (chips || []).forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c.label;
    b.addEventListener('click', () => handleCommand(c.text, c.label));
    box.appendChild(b);
  });
}

// Resolves when the reply has been spoken (or straight away if voice mode is off).
function speak(text) {
  return new Promise((resolve) => {
    try {
      if (!app.sound || !text || !('speechSynthesis' in window)) return resolve();
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = LANG;
      u.onend = resolve;
      u.onerror = resolve;
      setTimeout(resolve, 12000); // some browsers never fire onend
      window.speechSynthesis.speak(u);
    } catch (e) { resolve(); }
  });
}

// The assistant says something. If it asked a question, listen for the answer without another tap.
async function botSay(text, expects, isError) {
  addMessage('bot', text, isError);
  await speak(text);
  if (app.sound && ['amount', 'recipient', 'note'].includes(expects)) startListening();
}

async function handleCommand(text, shown) {
  text = (text || '').trim();
  if (!text || app.busy) return;
  app.busy = true;
  addMessage('you', shown || text);
  setChips([]);
  say('');
  try {
    const r = await api('/api/chat', { text });
    if (r.source) $('engine').textContent = r.source === 'ai' ? 'Enhanced command understanding' : 'Basic command understanding';
    if (r.kind === 'confirm') {
      showTicket(r);
      app.busy = false;
      await botSay('Check the details, then approve. ' + r.speech, 'confirm');
      return;
    }
    if (r.expects !== 'confirm') hideTicket();
    if (r.needs_setup) $('setup-box').hidden = false;
    if (r.highlight_balance) nudgeReveal();
    setChips(r.chips);
    app.busy = false;
    await botSay(r.message, r.expects);
  } catch (e) {
    addMessage('bot', e.message + ' You can retry or type your message.', true);
  } finally {
    app.busy = false;
  }
}

/* ---------- state and history ---------- */

function renderHistory(items) {
  const list = $('history');
  list.textContent = '';
  (items || []).slice().reverse().forEach((h) => {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = 'To ' + h.to;
    const sum = document.createElement('span');
    sum.className = 'sum';
    sum.textContent = formatMoney(h.amount);
    const sub = document.createElement('span');
    sub.className = 'sub';
    const when = new Date(h.time * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    sub.textContent = (h.note ? h.note + ', ' : '') + when + (h.reference ? ' · Ref ' + h.reference : '');
    li.append(who, sum, sub);
    list.appendChild(li);
  });
  $('empty').hidden = items.length > 0;
}

async function refresh() {
  const s = await api('/api/state');
  app.currency = s.currency;
  app.registered = s.registered;
  $('setup-box').hidden = s.registered;
  $('reset').hidden = !s.reset_enabled;
  $('engine').textContent = s.ai ? 'Enhanced command understanding available' : 'Basic command understanding';
  if (s.registered && !app.revealOptions) prefetchReveal();
  if (s.registered && !app.historyOptions) prefetchHistory();
  if (s.registered && !app.challengeTimer) {
    app.challengeTimer = setInterval(() => {
      prefetchReveal();
      prefetchHistory();
    }, 80000);
  }
}

/* ---------- Face ID / Touch ID registration ---------- */

function decodeCreationOptions(o) {
  const out = Object.assign({}, o);
  out.challenge = b64uToBuf(o.challenge);
  out.user = Object.assign({}, o.user, { id: b64uToBuf(o.user.id) });
  out.excludeCredentials = (o.excludeCredentials || []).map((c) => Object.assign({}, c, { id: b64uToBuf(c.id) }));
  return out;
}

async function prepareSetup() {
  if (!canUseBiometrics()) {
    say('Face ID / Touch ID needs https or localhost. Open the https link from your tunnel.', 'error');
    return;
  }
  const token = $('setup-token').value.trim();
  if (!token) {
    say('Enter the owner setup token first.', 'error');
    return;
  }
  app.setupToken = token;
  $('setup-prepare').disabled = true;
  try {
    app.regOptions = await api('/api/register/options', { setup_token: token });
    $('setup-scan').hidden = false;
    $('setup-scan').focus();
    say('Ready. Continue with Step 2 to scan your face or fingerprint.', 'ok');
  } catch (e) {
    app.setupToken = null;
    say(e.message, 'error');
  } finally {
    $('setup-prepare').disabled = false;
  }
}

async function scanSetup() {
  if (!canUseBiometrics() || !app.regOptions || !app.setupToken) return;
  const publicKey = decodeCreationOptions(app.regOptions);
  app.regOptions = null;
  $('setup-scan').disabled = true;
  try {
    const cred = await navigator.credentials.create({ publicKey });
    const r = cred.response;
    const payload = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        attestationObject: bufToB64u(r.attestationObject),
        clientDataJSON: bufToB64u(r.clientDataJSON),
        transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
      },
    };
    if (cred.authenticatorAttachment) payload.authenticatorAttachment = cred.authenticatorAttachment;
    await api('/api/register/verify', { setup_token: app.setupToken, credential: payload });
    app.setupToken = null;
    $('setup-token').value = '';
    $('setup-scan').hidden = true;
    say('');
    await refresh();
    const resumed = await api('/api/resume', {});
    if (resumed.kind === 'confirm') {
      showTicket(resumed);
      await botSay('Your saved payment is ready. Review the details, then approve. ' + resumed.speech, 'confirm');
    } else {
      setChips(resumed.chips || []);
      await botSay('Face ID / Touch ID is ready. ' + resumed.message, resumed.expects);
    }
  } catch (e) {
    app.setupToken = null;
    $('setup-scan').hidden = true;
    say(e.data ? e.message : webauthnProblem(e), 'error');
  } finally {
    $('setup-scan').disabled = false;
  }
}

/* ---------- Face ID / Touch ID signing (shared by payments and the balance) ---------- */

function decodeRequestOptions(o) {
  const out = Object.assign({}, o);
  out.challenge = b64uToBuf(o.challenge);
  out.allowCredentials = (o.allowCredentials || []).map((c) => Object.assign({}, c, { id: b64uToBuf(c.id) }));
  return out;
}

async function signWithBiometrics(options) {
  const cred = await navigator.credentials.get({ publicKey: decodeRequestOptions(options) });
  const r = cred.response;
  const credential = {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64u(r.clientDataJSON),
      authenticatorData: bufToB64u(r.authenticatorData),
      signature: bufToB64u(r.signature),
    },
  };
  if (r.userHandle) credential.response.userHandle = bufToB64u(r.userHandle);
  if (cred.authenticatorAttachment) credential.authenticatorAttachment = cred.authenticatorAttachment;
  return credential;
}

/* ---------- the private balance ---------- */

async function prefetchReveal() {
  if (!app.registered || app.revealFetching) return;
  app.revealFetching = true;
  try {
    const r = await api('/api/balance/options', {});
    app.revealOptions = r.options;
    app.revealAt = Date.now();
  } catch (e) {
    app.revealOptions = null;
  } finally {
    app.revealFetching = false;
  }
}

async function prefetchHistory() {
  if (!app.registered || app.historyFetching) return;
  app.historyFetching = true;
  try {
    const r = await api('/api/history/options', {});
    app.historyOptions = r.options;
    app.historyAt = Date.now();
  } catch (e) {
    app.historyOptions = null;
  } finally {
    app.historyFetching = false;
  }
}

function hideHistory() {
  if (app.historyTimer) { clearTimeout(app.historyTimer); app.historyTimer = null; }
  $('history').textContent = '';
  $('history').hidden = true;
  $('empty').hidden = true;
  $('history-reveal').textContent = 'Show payments with Face ID';
}

function showHistory(items, seconds) {
  renderHistory(items);
  $('history').hidden = false;
  $('history-reveal').textContent = 'Hide payments now';
  if (app.historyTimer) clearTimeout(app.historyTimer);
  app.historyTimer = setTimeout(hideHistory, seconds * 1000);
}

async function onHistoryReveal() {
  if (app.historyTimer) { hideHistory(); return; }
  if (!canUseBiometrics()) { say('Face ID / Touch ID needs https or localhost.', 'error'); return; }
  if (!app.registered) { say('Set up Face ID / Touch ID first.', 'error'); return; }
  if (!app.historyOptions || Date.now() - app.historyAt > 100000) {
    await prefetchHistory();
    say(app.historyOptions ? 'Ready. Tap Show payments once more.' : 'Could not prepare the unlock. Try again.', 'error');
    return;
  }
  const options = app.historyOptions;
  app.historyOptions = null;
  try {
    say('Waiting for Face ID / Touch ID...');
    const credential = await signWithBiometrics(options);
    const res = await api('/api/history/reveal', { credential });
    say('');
    showHistory(res.history, res.show_seconds);
  } catch (e) {
    say(e.data ? e.message : webauthnProblem(e), 'error');
  } finally {
    prefetchHistory();
  }
}

function hideBalance() {
  if (app.revealTimer) { clearInterval(app.revealTimer); app.revealTimer = null; }
  $('balance').textContent = HIDDEN_BALANCE;
  $('balance').classList.add('masked');
  $('balance').setAttribute('aria-label', 'Balance hidden');
  $('reveal').textContent = 'Show balance with Face ID';
  $('reveal-note').textContent = 'Hidden for your privacy. It is never read aloud or typed into the chat.';
}

function showBalance(text, seconds) {
  hideBalance();
  $('balance').textContent = text;
  $('balance').classList.remove('masked');
  $('balance').removeAttribute('aria-label');
  $('reveal').textContent = 'Hide now';
  let left = seconds;
  const tick = () => { $('reveal-note').textContent = 'Hiding in ' + left + ' seconds.'; };
  tick();
  app.revealTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) hideBalance(); else tick();
  }, 1000);
}

function nudgeReveal() {
  const b = $('reveal');
  b.classList.remove('pulse');
  void b.offsetWidth;
  b.classList.add('pulse');
  b.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function onReveal() {
  if (app.revealTimer) { hideBalance(); return; }
  if (!canUseBiometrics()) {
    say('Face ID / Touch ID needs https or localhost.', 'error');
    return;
  }
  if (!app.registered) {
    say('Set up Face ID / Touch ID first.', 'error');
    return;
  }
  if (!app.revealOptions || Date.now() - app.revealAt > 100000) {
    await prefetchReveal();
    say(app.revealOptions ? 'Ready. Tap Show balance once more.' : 'Could not prepare the unlock. Try again.', 'error');
    return;
  }
  const options = app.revealOptions;
  app.revealOptions = null; // each challenge works once
  say('Waiting for Face ID / Touch ID...');
  try {
    const credential = await signWithBiometrics(options); // called straight from the tap
    const res = await api('/api/balance/reveal', { credential });
    say('');
    showBalance(res.balance_text, res.show_seconds);
  } catch (e) {
    say(e.data ? e.message : webauthnProblem(e), 'error');
  } finally {
    prefetchReveal();
  }
}

// Never leave the balance on screen when the person looks away.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hideBalance(); hideHistory(); }
  else { prefetchReveal(); prefetchHistory(); }
});
window.addEventListener('pagehide', () => { hideBalance(); hideHistory(); });

/* ---------- voice input ---------- */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function setListening(on) {
  app.listening = on;
  $('mic').classList.toggle('listening', on);
  $('mic').setAttribute('aria-pressed', String(on));
  $('mic').setAttribute('aria-label', on ? 'Stop speaking' : 'Speak');
  $('typed').placeholder = on ? 'Listening...' : 'Type or tap the mic';
}

function startListening() {
  if (!Recognition || app.listening || app.approving || app.busy) return;
  if (window.speechSynthesis) window.speechSynthesis.cancel();

  const rec = new Recognition();
  rec.lang = LANG;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.continuous = false;

  let heard = false;
  let failed = false;
  let finalTranscript = '';
  rec.onstart = () => { setListening(true); say('Listening. Tap the mic to stop.'); };
  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const phrase = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += phrase + ' ';
      else interim += phrase;
    }
    $('typed').value = (finalTranscript + interim).trim();
    if (interim) say('Hearing: ' + $('typed').value);
    if (finalTranscript.trim() && !interim) {
      heard = true;
      queueVoiceTranscript(finalTranscript.trim());
    }
  };
  rec.onerror = (event) => {
    failed = true;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      app.sound = false;
      $('sound').textContent = 'Voice replies off';
      say('Microphone access was blocked. Allow the microphone for this site, or type instead.', 'error');
    } else if (event.error === 'language-not-supported') {
      LANG = 'en-US';
      say('That language is not supported here. Switched to US English. Tap the mic again.', 'error');
    } else if (event.error === 'network') {
      say('Voice recognition needs an internet connection. You can type instead.', 'error');
    } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
      say('Voice input failed (' + event.error + '). You can type instead.', 'error');
    }
  };
  rec.onend = () => {
    setListening(false);
    if (!heard && !failed) say('I did not hear anything. Tap the mic when you are ready.');
  };
  app.recognizer = rec;
  try { rec.start(); } catch (e) { say('Could not start the microphone. Try again.', 'error'); }
}

function onMic() {
  if (app.listening && app.recognizer) { app.recognizer.stop(); return; }
  if (!Recognition) {
    $('typed').focus();
    say('Voice input is not supported in this browser. Type instead.', 'error');
    return;
  }
  startListening();
}

function queueVoiceTranscript(transcript) {
  if (app.voiceTimer) clearTimeout(app.voiceTimer);
  $('typed').value = transcript;
  say('Heard: “' + transcript + '”. Edit it or press Send; sending in 2 seconds.');
  app.voiceTimer = setTimeout(() => {
    app.voiceTimer = null;
    if ($('typed').value.trim() === transcript) {
      $('typed').value = '';
      handleCommand(transcript);
    }
  }, 2000);
}

function onTranscriptEdit() {
  if (app.voiceTimer) {
    clearTimeout(app.voiceTimer);
    app.voiceTimer = null;
    say('Transcript edited. Press Send when it is correct.');
  }
}

/* ---------- confirmation ticket and approval ---------- */

function hideTicket() {
  $('ticket').hidden = true;
  app.txn = null;
  if (app.timer) { clearInterval(app.timer); app.timer = null; }
}

function showTicket(r) {
  $('receipt').hidden = true;
  app.txn = r;
  $('t-amount').textContent = r.amount_text;
  $('t-to').textContent = 'To ' + r.recipient;
  $('t-note').textContent = r.note ? 'For ' + r.note : '';
  $('t-note').hidden = !r.note;
  $('t-change').textContent = r.amount_change ? 'Amount changed: ' + r.amount_change : '';
  $('t-change').hidden = !r.amount_change;
  $('approve').disabled = false;
  $('ticket').hidden = false;
  $('ticket-announcement').textContent = 'Review payment: ' + r.amount_text + ' to ' + r.recipient
    + (r.note ? ', for ' + r.note : '') + '. Approval sends this exact payment.';
  app.deadline = Date.now() + r.expires_in * 1000;
  tick();
  if (app.timer) clearInterval(app.timer);
  app.timer = setInterval(tick, 500);
  $('ticket').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function tick() {
  const left = Math.max(0, Math.ceil((app.deadline - Date.now()) / 1000));
  $('t-timer').textContent = 'Expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  if (left === 0) {
    hideTicket();
    addMessage('bot', 'That payment expired. Tell me again if you still want to send it.', true);
  }
}

async function onApprove() {
  const txn = app.txn;
  if (!txn || app.approving) return;
  if (!canUseBiometrics()) {
    say('Face ID / Touch ID needs https or localhost.', 'error');
    return;
  }
  app.approving = true;
  let biometricSigned = false;
  $('approve').disabled = true;
  say('Waiting for Face ID / Touch ID...');
  try {
    const credential = await signWithBiometrics(txn.options); // called straight from the tap
    biometricSigned = true;
    const res = await api('/api/approve', { txn_id: txn.txn_id, credential });
    completeReceipt(res.record);
  } catch (e) {
    if (biometricSigned && (!e.status || e.status >= 500)) {
      try {
        const result = await api('/api/approve', { txn_id: txn.txn_id });
        completeReceipt(result.record);
      } catch (recheckError) {
        say('The connection dropped after approval. Check recent payments before trying again.', 'error');
      }
    } else if (e.data) {
      say(e.message, 'error');
      if (e.data.expired) { hideTicket(); addMessage('bot', e.message, true); }
    } else {
      say(webauthnProblem(e), 'error');
    }
    $('approve').disabled = false;
  } finally {
    app.approving = false;
  }
}

function completeReceipt(record) {
  hideTicket();
  $('receipt-text').textContent = formatMoney(record.amount) + ' to ' + record.to
    + (record.note ? ' for ' + record.note : '');
  $('receipt-reference').textContent = 'Reference: ' + (record.reference || 'available in recent payments');
  $('receipt').hidden = false;
  app.lastPayment = record;
  app.recentContacts = [record.to, ...app.recentContacts.filter((name) => name !== record.to)].slice(0, 3);
  setChips(startChips());
  say('Payment complete. Keep this reference for your records.', 'ok');
  botSay('Sent ' + formatMoney(record.amount) + ' to ' + record.to + '. Your receipt is shown above.', null);
  refresh();
}

function onRepeatLastPayment() {
  const payment = app.lastPayment;
  if (!payment) return;
  const command = 'send ' + Number(payment.amount).toFixed(2) + ' cedis to ' + payment.to
    + (payment.note ? ' for ' + payment.note : '');
  $('receipt').hidden = true;
  handleCommand(command, 'Prepare again: ' + formatMoney(payment.amount) + ' to ' + payment.to);
}

async function onCancel() {
  hideTicket();
  try { await api('/api/cancel', {}); } catch (e) { /* the ticket expires by itself */ }
  setChips([]);
  addMessage('bot', 'Cancelled. Nothing was sent.');
}

/* ---------- other controls ---------- */

async function onReset() {
  if (!window.confirm('Reset the simulated balance to its starting amount? Payment history remains as an audit record.')) return;
  try {
    await api('/api/reset', {});
    hideTicket();
    hideBalance();
    hideHistory();
    setChips(startChips());
    say('Demo reset.', 'ok');
    await refresh();
  } catch (e) {
    say(e.message, 'error');
  }
}

function onSound() {
  app.sound = !app.sound;
  if (!app.sound && window.speechSynthesis) window.speechSynthesis.cancel();
  if (!app.sound && app.recognizer && app.listening) app.recognizer.abort();
  $('sound').textContent = app.sound ? 'Voice replies on' : 'Voice replies off';
  $('sound').setAttribute('aria-pressed', String(app.sound));
  say(app.sound ? 'Voice replies and automatic listening are on.' : 'Voice replies are off. Tap the mic to speak, or type.', 'ok');
}

function startChips() {
  const recent = app.recentContacts.map((name) => ({ label: 'Pay ' + name, text: 'I want to send money to ' + name }));
  return recent.concat([{ label: 'Send money', text: 'I want to send money' }, { label: 'Check my balance', text: 'What is my balance?' }]);
}

/* ---------- start ---------- */

async function start() {
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (app.voiceTimer) { clearTimeout(app.voiceTimer); app.voiceTimer = null; }
    const input = $('typed');
    const text = input.value.trim();
    input.value = '';
    handleCommand(text);
  });
  $('typed').addEventListener('input', onTranscriptEdit);
  $('mic').addEventListener('click', onMic);
  $('setup-prepare').addEventListener('click', prepareSetup);
  $('setup-scan').addEventListener('click', scanSetup);
  $('approve').addEventListener('click', onApprove);
  $('cancel').addEventListener('click', onCancel);
  $('reveal').addEventListener('click', onReveal);
  $('history-reveal').addEventListener('click', onHistoryReveal);
  $('reset').addEventListener('click', onReset);
  $('repeat-payment').addEventListener('click', onRepeatLastPayment);
  $('sound').addEventListener('click', onSound);
  $('sound').textContent = 'Voice replies off';
  $('sound').setAttribute('aria-pressed', 'false');
  $('language').value = LANG;
  $('language').addEventListener('change', (event) => { LANG = event.target.value; });

  addMessage('bot', 'Hi! I can send money to your contacts and guide you step by step. '
    + 'Type a command, or tap the mic to speak. Voice replies and automatic listening are off until you turn them on. '
    + 'This is a simulation; the payment history is shared by visitors to this demo.');
  setChips(startChips());

  if (!window.isSecureContext) {
    say('This page is not on https, so Face ID / Touch ID will not work. Use localhost or an https tunnel.', 'error');
  } else if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    try {
      const ok = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (!ok) $('setup-text').textContent = 'This device has no Face ID, Touch ID or screen lock set up. Turn one on in your device settings first.';
    } catch (e) { /* ignore: the setup button still works */ }
  }

  try { await refresh(); } catch (e) { say(e.message, 'error'); }
}

start();
