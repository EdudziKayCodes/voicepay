'use strict';

/* VoicePay front end. Simulation only.
   Flow: talk or type -> /api/chat (guided questions) -> confirm ticket -> Face ID -> /api/approve.
   The balance is never in /api/state or in any chat reply. It is fetched only by unlock(),
   after a Face ID / Touch ID check, and wiped again after a few seconds. */

const $ = (id) => document.getElementById(id);
const HIDDEN_BALANCE = '\u2022\u2022\u2022\u2022\u2022\u2022';

function savedPhrasePreference() {
  try { return localStorage.getItem('voicepay-phrase-check') === 'on'; } catch (e) { return false; }
}

let LANG = 'en-IN';
let countryCatalog = [];
let firebaseAuth = null;
let firebaseModules = null;
let firebaseConfirmation = null;
let firebaseRecaptcha = null;
let firebaseSyncUid = null;
let firebaseVerificationInProgress = false;

const app = {
  currency: 'INR',
  country: 'IN',
  authenticated: false,
  accountIdentity: null,
  registered: false,
  addingDevice: false,
  txn: null,
  regOptions: null,
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
  mediaRecorder: null,
  mediaStream: null,
  audioChunks: [],
  recording: false,
  forceRecorder: false,
  listening: false,
  approving: false,
  busy: false,
  deadline: 0,
  timer: null,
  sound: false, // voice mode is opt-in
  lastPayment: null,
  recentContacts: [],
  selectedContact: null,
  inactivityTimer: null,
  lastActivity: Date.now(),
  voicePhrase: [],
  voicePhraseAttempts: 0,
  voicePhrasePassed: false,
  voicePhraseEnabled: savedPhrasePreference(),
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

async function apiUpload(path, form) {
  let res;
  try { res = await fetch(path, { method: 'POST', body: form }); }
  catch (e) { throw new Error('VoicePay could not connect. Check your connection and try again.'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore a non-JSON reply */ }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || 'Request failed (' + res.status + ').');
    err.data = data || {}; err.status = res.status; throw err;
  }
  return data;
}

async function initializeFirebase() {
  if (firebaseAuth && firebaseModules) return firebaseModules;
  const response = await api('/api/firebase/config');
  if (!response.configured || !response.config) {
    throw new Error('Phone sign-in needs Firebase Web settings and the private Firebase Admin service account in the server environment.');
  }
  const root = 'https://www.gstatic.com/firebasejs/13.2.0/';
  const [appSdk, authSdk] = await Promise.all([
    import(root + 'firebase-app.js'), import(root + 'firebase-auth.js'),
  ]);
  const firebaseApp = appSdk.initializeApp(response.config);
  firebaseAuth = authSdk.getAuth(firebaseApp);
  firebaseAuth.languageCode = LANG;
  firebaseModules = authSdk;
  authSdk.onAuthStateChanged(firebaseAuth, async (user) => {
    if (!user || firebaseVerificationInProgress || firebaseSyncUid === user.uid || app.authenticated) return;
    firebaseSyncUid = user.uid;
    try {
      await api('/api/auth/firebase', { id_token: await user.getIdToken() });
      await refresh();
      navigate(app.registered ? 'home' : 'setup');
      say(app.registered ? 'Signed in.' : 'Verified. Add device approval to continue.', 'ok');
    } catch (e) { firebaseSyncUid = null; say(e.message, 'error'); }
  });
  return firebaseModules;
}

function phoneToE164(value, country) {
  const raw = String(value || '').trim();
  if (raw.startsWith('+')) return '+' + raw.slice(1).replace(/\D/g, '');
  const dial = countryCatalog.find((item) => item.code === country)?.dial;
  if (!dial) throw new Error('Select a country first.');
  let digits = raw.replace(/\D/g, '');
  const countryDigits = dial.slice(1);
  if (digits.startsWith(countryDigits)) return '+' + digits;
  digits = digits.replace(/^0+/, '');
  return dial + digits;
}

function formatMoney(value) {
  try { return new Intl.NumberFormat('en-' + app.country, { style: 'currency', currency: app.currency }).format(Number(value)); }
  catch (e) { return app.currency + ' ' + Number(value).toLocaleString(); }
}

function say(text, kind) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

const VIEWS = ['home', 'about', 'pay', 'balance', 'history', 'setup', 'settings', 'account'];

function navigate(view, push) {
  if (!VIEWS.includes(view)) view = 'home';
  const requiresAccount = !app.authenticated && ['pay', 'balance', 'history', 'setup', 'settings'].includes(view);
  if (requiresAccount) view = 'account';
  if (view !== 'balance') hideBalance();
  if (view !== 'history') hideHistory();
  document.querySelectorAll('[data-screen]').forEach((screen) => {
    const active = screen.dataset.screen === view;
    screen.hidden = !active;
    screen.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  if (push !== false && location.hash !== '#' + view) history.pushState({ view }, '', '#' + view);
  if (view === 'balance') prefetchReveal();
  if (view === 'history') prefetchHistory();
  if (requiresAccount) say('Verify your phone number to open this section.', 'error');
}

function clearClientFlow() {
  if (app.voiceTimer) { clearTimeout(app.voiceTimer); app.voiceTimer = null; }
  if (app.recognizer && app.listening) app.recognizer.abort();
  if (app.mediaRecorder && app.recording) {
    app.mediaRecorder.onstop = null;
    try { app.mediaRecorder.stop(); } catch (e) { /* already stopped */ }
    cleanupRecording();
  }
  app.addingDevice = false;
  app.busy = false;
  app.txn = null;
  app.lastPayment = null;
  app.recentContacts = [];
  app.selectedContact = null;
  app.revealOptions = null;
  app.historyOptions = null;
  $('log').textContent = '';
  $('receipt').hidden = true;
  hideTicket();
  hideBalance();
  hideHistory();
  setChips(startChips());
  addMessage('bot', 'Who would you like to pay?');
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
      u.rate = 0.96;
      const voices = window.speechSynthesis.getVoices();
      const wanted = LANG.toLowerCase();
      const preferred = wanted === 'en-gh' ? ['en-gh', 'en-gb', 'en-us'] : [wanted];
      u.voice = voices.find((voice) => preferred.includes(voice.lang.toLowerCase()))
        || voices.find((voice) => voice.lang.toLowerCase().startsWith(wanted.split('-')[0]))
        || null;
      u.onend = resolve;
      u.onerror = resolve;
      window.speechSynthesis.resume();
      setTimeout(resolve, Math.max(8000, Math.min(20000, text.length * 110)));
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
  stopVoiceInput();
  const manualPhone = $('recipient-phone').value.trim();
  if (manualPhone && !app.selectedContact && !/\bto\b/i.test(text)) {
    const tail = manualPhone.replace(/\D/g, '').slice(-4);
    text += ' to phone ending ' + tail;
  }
  if (/\b(cancel|stop|abort|never\s?mind)\b/i.test(text)) app.selectedContact = null;
  app.busy = true;
  addMessage('you', shown || text);
  setChips([]);
  say('');
  try {
    const r = await api('/api/chat', {
      text,
      recipient_country: $('recipient-country').value || app.country,
      recipient_phone: app.selectedContact ? app.selectedContact.phone : $('recipient-phone').value.trim(),
    });
    navigate('pay');
    if (r.source) $('engine').textContent = r.source === 'ai' ? 'Enhanced command understanding' : 'Basic command understanding';
    if (r.kind === 'confirm') {
      showTicket(r);
      app.busy = false;
      await botSay('Check the details, then approve. ' + r.speech, 'confirm');
      if (app.sound) await speak('Voice phrase simulation. Say: ' + app.voicePhrase.join(', '));
      return;
    }
    if (r.expects !== 'confirm') hideTicket();
    if (r.needs_setup) { $('setup-box').hidden = false; navigate('setup'); }
    if (r.highlight_balance) { navigate('balance'); nudgeReveal(); }
    setChips(r.chips);
    app.busy = false;
    await botSay(r.message, r.expects);
  } catch (e) {
    if (e.data && e.data.auth_required) {
      navigate('account');
      say('Verify your phone number to continue.', 'error');
      return;
    }
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
    const destination = h.recipient_country && h.recipient_country !== app.country
      ? ' | Demo route: ' + h.recipient_country + ' (' + h.currency + ' to ' + h.recipient_currency + ')' : '';
    sub.textContent = (h.note ? h.note + ', ' : '') + when + destination + (h.reference ? ' · Ref ' + h.reference : '');
    li.append(who, sum, sub);
    list.appendChild(li);
  });
  $('empty').hidden = items.length > 0;
}

async function refresh() {
  const s = await api('/api/state');
  if (app.accountIdentity && s.authenticated && s.account_identity !== app.accountIdentity) clearClientFlow();
  app.currency = s.currency;
  app.country = s.country || 'IN';
  if ($('country-select') && s.authenticated) $('country-select').value = app.country;
  app.authenticated = Boolean(s.authenticated);
  if (s.authenticated) app.accountIdentity = s.account_identity;
  app.registered = s.registered;
  $('setup-box').hidden = !s.authenticated || (s.registered && !app.addingDevice);
  $('setup-complete').hidden = !s.authenticated || !s.registered || app.addingDevice;
  $('account-ready').hidden = !s.authenticated;
  $('account-form').hidden = Boolean(s.authenticated);
  $('account-currency').textContent = s.currency || '';
  $('balance-caption').textContent = 'AVAILABLE · ' + (s.currency || 'DEMO') + ' SIMULATED';
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
  if (!s.authenticated && ['pay', 'balance', 'history', 'setup', 'settings'].includes(location.hash.slice(1))) {
    navigate('account', false);
  }
}

async function loadCountryOptions() {
  try {
    const response = await fetch('/api/countries');
    if (!response.ok) throw new Error('Country list unavailable');
    const data = await response.json();
    countryCatalog = data.countries || [];
    const select = $('country-select');
    const destination = $('recipient-country');
    select.textContent = '';
    destination.textContent = '';
    const same = document.createElement('option');
    same.value = '';
    same.textContent = 'Same as my country';
    destination.appendChild(same);
    countryCatalog.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.code;
      option.textContent = item.name + ' (' + item.dial + ')';
      option.dataset.currency = item.currency;
      option.dataset.currencyName = item.currency_name;
      select.appendChild(option);
      const routeOption = option.cloneNode(true);
      destination.appendChild(routeOption);
    });
    select.value = app.country || 'IN';
    destination.value = '';
    updateCurrencyPreview();
  } catch (e) {
    say('Could not load countries. Refresh the page and try again.', 'error');
  }
}

function updateCurrencyPreview() {
  const item = countryCatalog.find((entry) => entry.code === $('country-select').value);
  if (!item) return;
  $('currency-preview').textContent = 'Currency · ' + item.currency + ' ' + item.currency_symbol;
  app.country = item.code;
  app.currency = item.currency;
  $('phone-number').placeholder = 'Number including area code';
}

async function sendPhoneCode() {
  const phone = $('phone-number').value.trim();
  const country = $('country-select').value;
  $('send-code').disabled = true;
  try {
    const authSdk = await initializeFirebase();
    if (!firebaseRecaptcha) {
      firebaseRecaptcha = new authSdk.RecaptchaVerifier(firebaseAuth, 'send-code', { size: 'invisible' });
    }
    firebaseConfirmation = await authSdk.signInWithPhoneNumber(firebaseAuth, phoneToE164(phone, country), firebaseRecaptcha);
    $('code-group').hidden = false;
    $('phone-code').focus();
    say('Code sent. Check your text messages.', 'ok');
  } catch (e) {
    if (firebaseRecaptcha) { try { await firebaseRecaptcha.clear(); } catch (ignored) {} firebaseRecaptcha = null; }
    const code = e.code || '';
    const messages = {
      'auth/invalid-phone-number': 'Check the phone number and country code, then try again.',
      'auth/too-many-requests': 'Too many attempts. Wait a while before requesting another code.',
      'auth/operation-not-allowed': 'Phone sign-in is disabled in Firebase Console.',
      'auth/unauthorized-domain': 'Add this site hostname to Firebase Authentication’s Authorized domains.',
      'auth/captcha-check-failed': 'Phone verification could not confirm this browser. Refresh and try again.',
      'auth/quota-exceeded': 'Firebase SMS quota is reached. Try later or check the project billing settings.',
      'auth/network-request-failed': 'Could not reach Firebase. Check your connection and try again.',
    };
    say(messages[code] || e.message || 'Could not send a code. Check the number and try again.', 'error');
  }
  finally { $('send-code').disabled = false; }
}

async function verifyPhoneCode() {
  const code = $('phone-code').value.trim();
  if (!firebaseConfirmation) { say('Request a new code first.', 'error'); return; }
  $('verify-code').disabled = true;
  firebaseVerificationInProgress = true;
  try {
    const result = await firebaseConfirmation.confirm(code);
    firebaseSyncUid = result.user.uid;
    await api('/api/auth/firebase', { id_token: await result.user.getIdToken() });
    firebaseConfirmation = null;
    await refresh();
    navigate(app.registered ? 'home' : 'setup');
    say(app.registered ? 'Signed in.' : 'Phone verified. Add device approval to continue.', 'ok');
  } catch (e) { say(e.message, 'error'); }
  finally { firebaseVerificationInProgress = false; $('verify-code').disabled = false; }
}

async function logout() {
  if (app.inactivityTimer) { clearTimeout(app.inactivityTimer); app.inactivityTimer = null; }
  if (firebaseAuth && firebaseModules) { try { await firebaseModules.signOut(firebaseAuth); } catch (e) { /* clear server session below */ } }
  try { await api('/api/auth/logout', {}); } catch (e) { /* still clear the local view */ }
  firebaseSyncUid = null;
  app.authenticated = false;
  app.registered = false;
  app.accountIdentity = null;
  hideTicket();
  $('receipt').hidden = true;
  $('phone-number').value = '';
  $('phone-code').value = '';
  $('code-group').hidden = true;
  clearClientFlow();
  navigate('account');
  await refresh();
  say('Signed out.', 'ok');
}

async function pickContact() {
  if (!navigator.contacts || typeof navigator.contacts.select !== 'function') {
    say('Contact picking is not available in this browser. Type the recipient name instead.', 'error');
    $('typed').focus();
    return;
  }
  try {
    const contacts = await navigator.contacts.select(['name', 'tel'], { multiple: false });
    const contact = contacts && contacts[0];
    const name = contact && contact.name && contact.name[0];
    const phone = contact && contact.tel && contact.tel[0];
    if (!name) { say('That contact has no name. Type the recipient instead.', 'error'); return; }
    app.selectedContact = phone ? { name, phone: phoneToE164(phone, $('recipient-country').value || app.country) } : null;
    $('recipient-phone').value = app.selectedContact ? app.selectedContact.phone : '';
    handleCommand('send to ' + name, 'Contact: ' + name);
  } catch (e) {
    if (e.name !== 'AbortError') say('Could not read that contact. Type the recipient name instead.', 'error');
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
  $('setup-prepare').disabled = true;
  try {
    app.regOptions = await api('/api/register/options', {});
    $('setup-scan').hidden = false;
    $('setup-scan').focus();
    say('Ready. Continue with Step 2 to scan your face or fingerprint.', 'ok');
  } catch (e) {
    say(e.message, 'error');
  } finally {
    $('setup-prepare').disabled = false;
  }
}

async function scanSetup() {
  if (!canUseBiometrics() || !app.regOptions) return;
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
    await api('/api/register/verify', { credential: payload });
    $('setup-scan').hidden = true;
    app.addingDevice = false;
    say('');
    await refresh();
    const resumed = await api('/api/resume', {});
    navigate('pay');
    if (resumed.kind === 'confirm') {
      showTicket(resumed);
      await botSay('Your saved payment is ready. Review the details, then approve. ' + resumed.speech, 'confirm');
    } else {
      setChips(resumed.chips || []);
      await botSay('Device approval is ready. ' + resumed.message, resumed.expects);
    }
  } catch (e) {
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
  $('history-reveal').textContent = 'Unlock activity';
  document.querySelector('.history-lock').hidden = false;
}

function showHistory(items, seconds) {
  renderHistory(items);
  $('history').hidden = false;
  document.querySelector('.history-lock').hidden = true;
  $('history-reveal').textContent = 'Hide activity';
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
  if (app.listening || app.approving || app.busy) return;
  if (!Recognition) { say('Tap the mic to record your reply, or type it.'); return; }
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
    if (event.error === 'not-allowed') {
      app.sound = false;
      $('sound').textContent = 'Voice replies off';
      say('Microphone access was blocked. Allow the microphone for this site, or type instead.', 'error');
    } else if (event.error === 'language-not-supported') {
      LANG = 'en-US';
      say('That language is not supported here. Switched to US English. Tap the mic again.', 'error');
    } else if (event.error === 'network') {
      app.forceRecorder = true;
      say('Browser voice input failed. Tap the mic to record with VoicePay instead.', 'error');
      $('mic').setAttribute('aria-label', 'Record voice with VoicePay');
    } else if (event.error === 'service-not-allowed') {
      app.forceRecorder = true;
      say('Browser voice input is unavailable. Tap the mic to record with VoicePay instead.', 'error');
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
  if (app.recording && app.mediaRecorder) { app.mediaRecorder.stop(); return; }
  if (app.forceRecorder || !Recognition) startRecording(); else startListening();
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    $('typed').focus();
    say('Voice recording is unavailable here. Allow microphone access or type your message.', 'error');
    return;
  }
  try {
    app.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type));
    app.mediaRecorder = mimeType ? new MediaRecorder(app.mediaStream, { mimeType }) : new MediaRecorder(app.mediaStream);
    app.audioChunks = [];
    app.mediaRecorder.ondataavailable = (event) => { if (event.data && event.data.size) app.audioChunks.push(event.data); };
    app.mediaRecorder.onstop = finishRecording;
    app.mediaRecorder.start();
    app.recording = true;
    setListening(true);
    $('mic').setAttribute('aria-label', 'Stop recording');
    say('Recording. Tap the mic when finished.');
  } catch (e) {
    cleanupRecording();
    say('Microphone access is blocked or unavailable. Allow it for this site, or type instead.', 'error');
  }
}

async function finishRecording() {
  const recorder = app.mediaRecorder;
  const chunks = app.audioChunks;
  const blob = new Blob(chunks, { type: recorder && recorder.mimeType || 'audio/webm' });
  cleanupRecording();
  if (!blob.size) { say('No speech was recorded. Try again or type instead.', 'error'); return; }
  say('Transcribing…');
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('audio', blob, 'voice.' + ext);
  form.append('language', LANG);
  try {
    const result = await apiUpload('/api/transcribe', form);
    queueVoiceTranscript(result.text);
  } catch (e) { say(e.message, 'error'); }
}

function cleanupRecording() {
  if (app.mediaStream) app.mediaStream.getTracks().forEach((track) => track.stop());
  app.mediaStream = null;
  app.mediaRecorder = null;
  app.audioChunks = [];
  app.recording = false;
  setListening(false);
  $('mic').setAttribute('aria-label', 'Speak');
}

function queueVoiceTranscript(transcript) {
  if (app.voiceTimer) clearTimeout(app.voiceTimer);
  $('typed').value = transcript;
  say('Heard: “' + transcript + '”. Edit or send in 3 seconds.');
  app.voiceTimer = setTimeout(() => {
    app.voiceTimer = null;
    if ($('typed').value.trim() === transcript) {
      stopVoiceInput();
      $('typed').value = '';
      handleCommand(transcript);
    }
  }, 3000);
}

function onTranscriptEdit() {
  if (app.voiceTimer) {
    clearTimeout(app.voiceTimer);
    app.voiceTimer = null;
    say('Transcript edited. Press Send when it is correct.');
  }
}

/* ---------- confirmation ticket and approval ---------- */

function prepareVoicePhrase() {
  $('voice-check-panel').hidden = !app.voicePhraseEnabled;
  const words = ['amber','apple','bridge','candle','cedar','cloud','daisy','delta','eagle','ember','forest','garden','harbor','island','jacket','lemon','maple','meadow','ocean','olive','pencil','planet','rabbit','river','silver','sunset','tiger','velvet','window','yellow'];
  const pool = words.slice();
  app.voicePhrase = Array.from({ length: 3 }, () => pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  app.voicePhraseAttempts = 0;
  app.voicePhrasePassed = false;
  $('voice-words').textContent = app.voicePhrase.join(' · ');
  $('approve').disabled = app.voicePhraseEnabled;
}

async function runVoicePhraseCheck() {
  if (!Recognition) { say('Voice recognition is unavailable. Type the three displayed words below.', 'error'); $('voice-phrase-input').focus(); return; }
  const rec = new Recognition();
  rec.lang = LANG; rec.interimResults = false; rec.maxAlternatives = 1;
  $('voice-check').disabled = true; say('Listening for the three words.');
  rec.onresult = async (event) => {
    const said = event.results[0][0].transcript.toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/).join(' ');
    processVoicePhrase(said);
  };
  rec.onerror = () => { $('voice-check').disabled = false; say('Could not hear the phrase. Try again or type the displayed words.', 'error'); };
  rec.onend = () => { $('voice-check').disabled = false; };
  try { rec.start(); } catch (e) { $('voice-check').disabled = false; say('Could not start voice recognition. Type the displayed words instead.', 'error'); }
}

async function processVoicePhrase(value) {
  const said = String(value || '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/).join(' ');
  if (said === app.voicePhrase.join(' ')) {
    app.voicePhrasePassed = true; $('approve').disabled = false;
    say('Phrase matched. Continue with device approval.', 'ok');
  } else if (++app.voicePhraseAttempts >= 2) {
      hideTicket(); try { await api('/api/cancel', {}); } catch (e) {}
      addMessage('bot', 'Voice phrase did not match twice. Payment cancelled.');
      say('Payment cancelled after two phrase mismatches.', 'error');
  } else {
    const attempts = app.voicePhraseAttempts; prepareVoicePhrase(); app.voicePhraseAttempts = attempts;
    say('Phrase did not match. New words are ready; try once more.', 'error');
  }
}

function hideTicket() {
  $('ticket').hidden = true;
  $('pay-tip').hidden = false;
  app.txn = null;
  if (app.timer) { clearInterval(app.timer); app.timer = null; }
}

function showTicket(r) {
  navigate('pay');
  $('receipt').hidden = true;
  $('pay-tip').hidden = true;
  app.txn = r;
  $('t-amount').textContent = r.amount_text;
  $('t-to').textContent = 'To ' + r.recipient
    + (r.recipient_phone_hint ? ' · phone ending ' + r.recipient_phone_hint : '');
  const route = r.cross_border_simulated
    ? 'Cross-border demo: ' + app.country + ' to ' + r.recipient_country + ' (' + app.currency + ' to ' + r.recipient_currency + ', no conversion)'
    : '';
  $('t-route').textContent = route;
  $('t-route').hidden = !route;
  $('t-note').textContent = r.note ? 'For ' + r.note : '';
  $('t-note').hidden = !r.note;
  $('t-change').textContent = r.amount_change ? 'Amount changed: ' + r.amount_change : '';
  $('t-change').hidden = !r.amount_change;
  $('approve').disabled = false;
  $('ticket').hidden = false;
  prepareVoicePhrase();
  $('ticket-announcement').textContent = 'Review payment: ' + r.amount_text + ' to ' + r.recipient
    + (r.recipient_phone_hint ? ', phone ending ' + r.recipient_phone_hint : '')
    + (r.note ? ', for ' + r.note : '') + (route ? '. ' + route : '') + '. This is simulated.';
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
  if (app.voicePhraseEnabled && !app.voicePhrasePassed) { say('Complete the optional three-word phrase check first.', 'error'); return; }
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
  stopVoiceInput();
  hideTicket();
  $('receipt-text').textContent = formatMoney(record.amount) + ' to ' + record.to
    + (record.note ? ' for ' + record.note : '');
  if (record.recipient_country && record.recipient_country !== app.country) {
    $('receipt-text').textContent += ' · Cross-border simulation to ' + record.recipient_country;
  }
  if (record.recipient_phone_hint) $('receipt-text').textContent += ' · phone ending ' + record.recipient_phone_hint;
  $('receipt-reference').textContent = 'Reference: ' + (record.reference || 'available in recent payments');
  $('receipt').hidden = false;
  $('pay-tip').hidden = true;
  navigate('pay');
  app.lastPayment = record;
  app.selectedContact = null;
  app.recentContacts = [record.to, ...app.recentContacts.filter((name) => name !== record.to)].slice(0, 3);
  setChips(startChips());
  say('Payment complete. Keep this reference for your records.', 'ok');
  botSay('Sent ' + formatMoney(record.amount) + ' to ' + record.to + '. Your receipt is shown above.', null);
  refresh();
}

function stopVoiceInput() {
  if (app.voiceTimer) { clearTimeout(app.voiceTimer); app.voiceTimer = null; }
  if (app.recognizer && app.listening) { try { app.recognizer.abort(); } catch (e) {} }
  if (app.mediaRecorder && app.recording) { app.mediaRecorder.onstop = null; try { app.mediaRecorder.stop(); } catch (e) {} }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  cleanupRecording();
  setListening(false);
}

function clearReceiptAndChat() {
  stopVoiceInput();
  $('receipt').hidden = true;
  $('pay-tip').hidden = false;
  $('typed').value = '';
  $('recipient-phone').value = '';
  $('log').textContent = '';
  app.lastPayment = null;
  app.txn = null;
  app.selectedContact = null;
  setChips(startChips());
  addMessage('bot', 'Ready for a new payment.');
  say('Receipt dismissed. The completed demo payment remains in Activity.', 'ok');
}

async function onCancel() {
  hideTicket();
  app.selectedContact = null;
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
  if (!app.sound && (!window.speechSynthesis || !window.SpeechSynthesisUtterance)) {
    say('Spoken replies are not supported in this browser.', 'error');
    return;
  }
  app.sound = !app.sound;
  if (!app.sound && window.speechSynthesis) window.speechSynthesis.cancel();
  if (!app.sound && app.recognizer && app.listening) app.recognizer.abort();
  $('sound').setAttribute('aria-pressed', String(app.sound));
  $('sound-setting').setAttribute('aria-pressed', String(app.sound));
  $('sound').setAttribute('aria-label', app.sound ? 'Turn voice replies off' : 'Turn voice replies on');
  say(app.sound ? 'Voice replies and automatic listening are on.' : 'Voice replies are off. Tap the mic to speak, or type.', 'ok');
  if (app.sound) speak('Voice replies are on.');
}

function startChips() {
  const recent = app.recentContacts.map((name) => ({ label: 'Pay ' + name, text: 'I want to send money to ' + name }));
  return recent.concat([{ label: 'Send money', text: 'I want to send money' }, { label: 'Check my balance', text: 'What is my balance?' }]);
}

/* ---------- start ---------- */

async function start() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.view));
  });
  window.addEventListener('popstate', () => navigate(location.hash.slice(1) || 'home', false));
  navigate(location.hash.slice(1) || 'home', false);
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
  $('voice-check').addEventListener('click', runVoicePhraseCheck);
  $('voice-phrase-submit').addEventListener('click', () => {
    const input = $('voice-phrase-input');
    const value = input.value;
    input.value = '';
    processVoicePhrase(value);
  });
  $('voice-phrase-enabled').checked = app.voicePhraseEnabled;
  $('voice-phrase-enabled').addEventListener('change', (event) => {
    app.voicePhraseEnabled = event.target.checked;
    try { localStorage.setItem('voicepay-phrase-check', app.voicePhraseEnabled ? 'on' : 'off'); } catch (e) {}
    say(app.voicePhraseEnabled ? 'Optional phrase check enabled. Device approval is still required.' : 'Face ID / Touch ID is the default approval.', 'ok');
  });
  $('reveal').addEventListener('click', onReveal);
  $('history-reveal').addEventListener('click', onHistoryReveal);
  $('reset').addEventListener('click', onReset);
  $('clear-receipt').addEventListener('click', clearReceiptAndChat);
  $('sound').addEventListener('click', onSound);
  $('sound-setting').addEventListener('click', onSound);
  $('add-device').addEventListener('click', () => {
    app.addingDevice = true;
    $('setup-complete').hidden = true;
    $('setup-box').hidden = false;
    $('setup-prepare').focus();
  });
  $('country-select').addEventListener('change', updateCurrencyPreview);
  $('recipient-country').addEventListener('change', () => { app.selectedContact = null; });
  $('recipient-phone').addEventListener('input', () => { app.selectedContact = null; });
  $('pick-contact').addEventListener('click', pickContact);
  $('send-code').addEventListener('click', sendPhoneCode);
  $('verify-code').addEventListener('click', verifyPhoneCode);
  $('logout').addEventListener('click', logout);
  $('logout-settings').addEventListener('click', logout);
  const resetInactivity = () => {
    app.lastActivity = Date.now();
    if (app.inactivityTimer) clearTimeout(app.inactivityTimer);
    app.inactivityTimer = setTimeout(() => {
      if (app.authenticated) { say('Signed out after 5 minutes of inactivity.', 'error'); logout(); }
    }, 5 * 60 * 1000);
  };
  ['pointerdown', 'keydown', 'touchstart', 'input'].forEach((eventName) =>
    document.addEventListener(eventName, resetInactivity, { passive: true }));
  window.addEventListener('focus', resetInactivity);
  resetInactivity();
  $('sound').textContent = '♫';
  $('sound').setAttribute('aria-pressed', 'false');
  $('language').value = LANG;
  $('language').addEventListener('change', (event) => {
    LANG = event.target.value;
    if (firebaseAuth) firebaseAuth.languageCode = LANG;
  });

  addMessage('bot', 'Who would you like to pay?');
  setChips(startChips());

  if (!window.isSecureContext) {
    say('This page is not on https, so Face ID / Touch ID will not work. Use localhost or an https tunnel.', 'error');
  }

  await loadCountryOptions();
  try { await refresh(); } catch (e) { say(e.message, 'error'); }
  try { await initializeFirebase(); } catch (e) { console.info('Firebase sign-in is not ready:', e.message); }
}

start();
