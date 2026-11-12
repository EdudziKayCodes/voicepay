"""
Proves the balance stays private. Run:  python test_privacy.py

It plays the part of a phone with Face ID (a software authenticator) and walks through the
whole conversation, checking every server reply for the balance.
"""
import base64
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

os.environ.pop('GROQ_API_KEY', None)  # test with the rule-based parser only
os.environ['RP_ID'] = 'localhost'
os.environ['ORIGIN'] = 'http://localhost:5000'
os.environ['SETUP_TOKEN'] = 'test-owner-setup-token'
os.environ['FIREBASE_API_KEY'] = 'test-api-key'
os.environ['FIREBASE_AUTH_DOMAIN'] = 'test.firebaseapp.com'
os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
os.environ['FIREBASE_APP_ID'] = 'test-app'
os.environ['ALLOW_RESET'] = '0'
TEST_HOME = Path(tempfile.mkdtemp())
os.environ['VOICEPAY_DATA_FILE'] = str(TEST_HOME / 'data.json')
os.environ['VOICEPAY_LEDGER_DB'] = str(TEST_HOME / 'ledger.sqlite3')

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

import app as vp

ORIGIN, RP = 'http://localhost:5000', 'localhost'
SECRET = ['1,000.00', '950.00', '900.00']  # hidden balances and derived balances
failures = []
seen = []  # every reply body the server ever sent to the page


def b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


class Phone:
    """A software Face ID: signs whatever challenge it is given."""

    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred_id = os.urandom(16)
        self.count = 0

    def register(self, options):
        client = json.dumps({'type': 'webauthn.create', 'challenge': options['challenge'],
                             'origin': ORIGIN, 'crossOrigin': False}).encode()
        n = self.key.public_key().public_numbers()
        cose = {1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, 'big'), -3: n.y.to_bytes(32, 'big')}
        auth = (hashlib.sha256(RP.encode()).digest() + bytes([0x45]) + (0).to_bytes(4, 'big') + b'\0' * 16
                + len(self.cred_id).to_bytes(2, 'big') + self.cred_id + cbor2.dumps(cose))
        att = cbor2.dumps({'fmt': 'none', 'attStmt': {}, 'authData': auth})
        return {'id': b64u(self.cred_id), 'rawId': b64u(self.cred_id), 'type': 'public-key',
                'response': {'attestationObject': b64u(att), 'clientDataJSON': b64u(client), 'transports': ['internal']}}

    def sign(self, options):
        self.count += 1
        client = json.dumps({'type': 'webauthn.get', 'challenge': options['challenge'],
                             'origin': ORIGIN, 'crossOrigin': False}).encode()
        auth = hashlib.sha256(RP.encode()).digest() + bytes([0x05]) + self.count.to_bytes(4, 'big')
        sig = self.key.sign(auth + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
        return {'id': b64u(self.cred_id), 'rawId': b64u(self.cred_id), 'type': 'public-key',
                'response': {'clientDataJSON': b64u(client), 'authenticatorData': b64u(auth), 'signature': b64u(sig)}}


def check(name, condition):
    print(('  [ok]   ' if condition else '  [FAIL] ') + name)
    if not condition:
        failures.append(name)


def call(client, method, path, body=None):
    headers = {'Origin': ORIGIN} if method == 'POST' else None
    res = client.open(path, method=method, json=body, headers=headers)
    text = res.get_data(as_text=True)
    seen.append((path, text))
    return res.status_code, (res.get_json(silent=True) or {})


def chat(client, text):
    return call(client, 'POST', '/api/chat', {'text': text})[1]


vp.app.config['TESTING'] = True
vp.FIREBASE_READY = True
firebase_phones = {'alice-token': '+919876543210', 'other-token': '+919876543211'}
vp.firebase_auth.verify_id_token = lambda token, app=None, check_revoked=False: {
    'uid': token, 'phone_number': firebase_phones[token]}
vp.firebase_auth.get_user = lambda uid, app=None: SimpleNamespace(phone_number=firebase_phones[uid])
alice = vp.app.test_client()
phone = Phone()


def authenticate(client, token):
    code, _ = call(client, 'POST', '/api/auth/firebase', {'id_token': token})
    check('Firebase verified phone account is accepted', code == 200)

print('Setup')
_, state = call(alice, 'GET', '/api/state')
check('/api/state has no balance field', not any('balance' in k for k in state))
check('/api/state does not disclose history', 'history' not in state)
authenticate(alice, 'alice-token')
_, reg = call(alice, 'POST', '/api/register/options', {})
code, _ = call(alice, 'POST', '/api/register/verify', {'credential': phone.register(reg)})
check('device registered', code == 200)
other = vp.app.test_client()
authenticate(other, 'other-token')
other_phone = Phone()
code, other_reg = call(other, 'POST', '/api/register/options', {})
if code == 200:
    code, _ = call(other, 'POST', '/api/register/verify', {'credential': other_phone.register(other_reg)})
check('another verified account can register its own device', code == 200)
alice_user = vp.user_for_auth_token(alice.get_cookie('vp_auth').value)

print('\nGuided conversation')
r = chat(alice, 'I want to send some money')
check('asks how much', r['expects'] == 'amount')
r = chat(alice, '50')
check('asks who next', r['expects'] == 'recipient' and '50.00' in r['message'])
r = chat(alice, 'Yaw')
check('accepts a recipient name typed during the transaction', r['expects'] == 'note' and 'Yaw' in r['message'])
r = chat(alice, 'for lunch')
check('shows the confirmation ticket', r['kind'] == 'confirm' and r['recipient'] == 'Yaw' and r['note'] == 'lunch')
first = r
r = chat(alice, 'make it 60')
check('changing the amount issues a new ticket', r['kind'] == 'confirm' and '60.00' in r['amount_text'] and r['txn_id'] != first['txn_id'])
code, _ = call(alice, 'POST', '/api/approve', {'txn_id': first['txn_id'], 'credential': phone.sign(first['options'])})
check('the old ticket no longer works', code == 410)
r = chat(alice, 'yes')
check('saying yes does not approve, it points to Face ID', r['expects'] == 'confirm' and 'Approve' in r['message'])

print('\nBalance privacy')
r = chat(alice, "what's my balance?")
check('asking for the balance shows nothing, only how to unlock', r.get('highlight_balance') and not any(s in r['message'] for s in SECRET))
code, reveal = call(alice, 'POST', '/api/balance/reveal', {'credential': phone.sign(first['options'])})
check('balance refused without a fresh unlock', code in (401, 410) and 'balance_text' not in reveal)
_, opts = call(alice, 'POST', '/api/balance/options')
code, bad = call(alice, 'POST', '/api/balance/reveal', {'credential': phone.sign(r2 := {'challenge': first['options']['challenge']})})
check("a payment approval cannot be reused to unlock the balance", code == 401 and 'balance_text' not in bad)

print('\nPayments')
r = chat(alice, 'cancel')
check('cancel clears the conversation', 'cancelled' in r['message'])
r = chat(alice, 'send 5000 rupees to Ananya for rent')
check('a large amount gets the same pre-biometric review flow', r['kind'] == 'confirm'
      and 'daily limit' not in json.dumps(r).lower())
chat(alice, 'cancel')
r = chat(alice, 'send 50 rupees to Aarav for lunch')
check('one sentence goes straight to the ticket', r['kind'] == 'confirm')
chat(other, 'hello')
code, _ = call(other, 'POST', '/api/approve', {'txn_id': r['txn_id'], 'credential': phone.sign(r['options'])})
check("someone else's browser cannot approve my payment", code == 410)
code, res = call(alice, 'POST', '/api/approve', {'txn_id': r['txn_id'], 'credential': phone.sign(r['options'])})
check('approved with Face ID', code == 200 and res['ok'])
check('the approval reply has no balance', 'balance' not in json.dumps(res))
code, _ = call(alice, 'POST', '/api/approve', {'txn_id': r['txn_id'], 'credential': phone.sign(r['options'])})
check('retries return the original receipt without charging twice', code == 200)

print('\nUnlocking the balance')
_, opts = call(alice, 'POST', '/api/balance/options')
code, res = call(alice, 'POST', '/api/balance/reveal', {'credential': phone.sign(opts['options'])})
check('Face ID shows the balance', code == 200 and '950.00' in res['balance_text'])
code, _ = call(alice, 'POST', '/api/balance/reveal', {'credential': phone.sign(opts['options'])})
check('the unlock works only once', code == 410)

print('\nNot enough money')
with vp.db_connect() as conn:
    conn.execute("INSERT INTO ledger(kind,amount_cents,created,note,owner_id,currency) VALUES('reset',?,?,?,?,?)",
                 (-92000, int(time.time()), 'test-only adjustment', alice_user['id'], 'INR'))
r = chat(alice, 'send 40 rupees to Ananya for snacks')
check('no hint of low funds before Face ID: the ticket is issued as normal', r['kind'] == 'confirm')
code, res = call(alice, 'POST', '/api/approve', {'txn_id': r['txn_id'], 'credential': phone.sign(r['options'])})
check('after Face ID it says insufficient funds, and nothing is sent', code == 400 and 'Insufficient' in res['error'] and vp.ledger_balance(alice_user['id'], 'INR') == 30.0)
with vp.db_connect() as conn:
    conn.execute("INSERT INTO ledger(kind,amount_cents,created,note,owner_id,currency) VALUES('reset',?,?,?,?,?)",
                 (92000, int(time.time()), 'test-only adjustment', alice_user['id'], 'INR'))

print('\nHistory privacy')
_, state = call(alice, 'GET', '/api/state')
check('history remains absent from public state after a payment', 'history' not in state)
_, opts = call(alice, 'POST', '/api/history/options', {})
code, history = call(alice, 'POST', '/api/history/reveal', {'credential': phone.sign(opts['options'])})
check('history is returned only after biometric approval', code == 200 and len(history['history']) == 1)

print('\nLockout')
for i in range(3):
    _, o = call(alice, 'POST', '/api/balance/options')
    fake = phone.sign(o['options'])
    fake['response']['signature'] = b64u(b'not a real signature')
    call(alice, 'POST', '/api/balance/reveal', {'credential': fake})
_, o = call(alice, 'POST', '/api/balance/options')
code, _ = call(alice, 'POST', '/api/balance/reveal', {'credential': phone.sign(o['options'])})
check('three failed attempts lock it for a minute', code == 429)

print('\nLeak sweep')
allowed_private = {'/api/balance/reveal', '/api/history/reveal'}
leaks = [(p, s) for p, t in seen if p not in allowed_private for s in SECRET if s in t]
check('balance values appear only in biometrically gated replies ({} replies checked)'.format(len(seen)), not leaks)
for p, s in leaks[:5]:
    print('         leaked', s, 'in', p)

print()
if failures:
    sys.exit('{} check(s) failed.'.format(len(failures)))
print('All checks passed.')
