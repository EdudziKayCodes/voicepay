"""
Run this before the hackathon (and again after changing RP_ID / ORIGIN):

    python check_setup.py          checks libraries, WebAuthn and your settings
    python check_setup.py --live   also sends one real request to Groq
"""
import inspect
import json
import os
import sys
from importlib import metadata
from urllib.parse import urlparse

problems = []


def ok(text):
    print('  [ok]   ' + text)


def bad(text):
    print('  [FIX]  ' + text)
    problems.append(text)


print('Python', sys.version.split()[0])
if sys.version_info < (3, 9):
    bad('Python 3.9 or newer is required.')

print('\nLibraries')
for package in ('flask', 'openai', 'webauthn', 'Babel', 'phonenumbers', 'firebase-admin'):
    try:
        ok('{} {}'.format(package, metadata.version(package)))
    except metadata.PackageNotFoundError:
        bad('{} is missing. Run: pip install -r requirements.txt'.format(package))
try:
    ok('python-dotenv {}'.format(metadata.version('python-dotenv')))
except metadata.PackageNotFoundError:
    print('  [skip] python-dotenv is not installed, so .env will not be read. Set variables in the terminal instead.')

if problems:
    sys.exit('\nInstall the missing libraries first, then run this again.')

try:  # load .env the same way the app does
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

print('\nWebAuthn (Face ID / Touch ID)')
import webauthn
from webauthn.helpers.structs import (
    AuthenticatorAttachment,
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    UserVerificationRequirement,
)

REQUIRED = {
    'generate_registration_options': ['rp_id', 'rp_name', 'user_id', 'user_name', 'user_display_name', 'authenticator_selection'],
    'verify_registration_response': ['credential', 'expected_challenge', 'expected_rp_id', 'expected_origin', 'require_user_verification'],
    'generate_authentication_options': ['rp_id', 'challenge', 'allow_credentials', 'user_verification'],
    'verify_authentication_response': [
        'credential', 'expected_challenge', 'expected_rp_id', 'expected_origin',
        'credential_public_key', 'credential_current_sign_count', 'require_user_verification',
    ],
}
for name, params in REQUIRED.items():
    try:
        have = inspect.signature(getattr(webauthn, name)).parameters
        missing = [p for p in params if p not in have]
        if missing:
            bad('webauthn.{} does not accept {}. Run: pip install "webauthn>=2.0,<3"'.format(name, ', '.join(missing)))
        else:
            ok('webauthn.{} has the expected parameters'.format(name))
    except AttributeError:
        bad('webauthn.{} not found. Run: pip install "webauthn>=2.0,<3"'.format(name))

if not problems:
    try:
        reg = json.loads(webauthn.options_to_json(webauthn.generate_registration_options(
            rp_id='localhost', rp_name='VoicePay', user_id=b'demo', user_name='demo',
            user_display_name='demo',
            authenticator_selection=AuthenticatorSelectionCriteria(
                authenticator_attachment=AuthenticatorAttachment.PLATFORM,
                user_verification=UserVerificationRequirement.REQUIRED))))
        auth = json.loads(webauthn.options_to_json(webauthn.generate_authentication_options(
            rp_id='localhost', challenge=b'x' * 32,
            allow_credentials=[PublicKeyCredentialDescriptor(id=b'cred')],
            user_verification=UserVerificationRequirement.REQUIRED)))
        if all(k in reg for k in ('challenge', 'rp', 'user', 'pubKeyCredParams')) and \
           all(k in auth for k in ('challenge', 'allowCredentials')) and 'id' in reg['user']:
            ok('registration and approval options are built correctly')
        else:
            bad('webauthn returned options in an unexpected shape. Run: pip install "webauthn>=2.0,<3"')
    except Exception as exc:
        bad('webauthn could not build options: {}'.format(exc))

print('\nSettings')
if os.environ.get('GROQ_API_KEY', '').strip():
    ok('GROQ_API_KEY is set')
else:
    bad('GROQ_API_KEY is not set. The app still works with simple rules, but not with the AI. Put it in .env')

rp_id = os.environ.get('RP_ID', 'localhost').strip()
origins = [o.strip() for o in os.environ.get('ORIGIN', 'http://localhost:5000').split(',') if o.strip()]
ok('RP_ID = {}'.format(rp_id))
for origin in origins:
    parsed = urlparse(origin)
    host = parsed.hostname or ''
    if parsed.scheme not in ('http', 'https') or not host:
        bad('ORIGIN "{}" must look like https://your-address (no path)'.format(origin))
    elif host != rp_id and not host.endswith('.' + rp_id):
        bad('ORIGIN host "{}" does not match RP_ID "{}". RP_ID is the address without https://'.format(host, rp_id))
    elif parsed.scheme == 'http' and host != 'localhost':
        bad('ORIGIN "{}" must use https (only localhost may use http)'.format(origin))
    else:
        ok('ORIGIN = {}'.format(origin))

print('\nApp')
try:
    import app as voicepay

    cmd, source = voicepay.fallback_parse('pay thirty rupees to Aarav for lunch'), 'rules'
    if cmd.get('amount') == 30.0 and cmd.get('recipient') == 'Aarav':
        ok('app.py loads and the rule-based parser works')
    else:
        bad('rule-based parser returned {}'.format(cmd))
except Exception as exc:
    bad('app.py could not be loaded: {}'.format(exc))
    voicepay = None

if voicepay is not None:
    firebase_client = (voicepay.FIREBASE_API_KEY, voicepay.FIREBASE_AUTH_DOMAIN,
                       voicepay.FIREBASE_PROJECT_ID, voicepay.FIREBASE_APP_ID)
    if all(firebase_client):
        ok('Firebase Web app config is set')
    else:
        bad('Set FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID and FIREBASE_APP_ID.')
    if voicepay.FIREBASE_READY:
        ok('Firebase Admin credentials are ready for verified phone tokens')
    elif not voicepay.FIREBASE_SERVICE_ACCOUNT_JSON and not os.environ.get('GOOGLE_APPLICATION_CREDENTIALS'):
        bad('Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS for the server Admin SDK.')
    else:
        bad('Firebase Admin could not initialize. Check the service account credentials.')
    if voicepay.SETUP_TOKEN:
        ok('SETUP_TOKEN is set for owner-only diagnostics')
    else:
        print('  [skip] SETUP_TOKEN is not set; owner diagnostics will be unavailable.')
    if voicepay.ALLOW_RESET:
        ok('ALLOW_RESET is enabled (use only for a controlled demo)')
    else:
        ok('demo reset is disabled by default')

if '--live' in sys.argv and voicepay is not None:
    print('\nLive Groq test')
    if voicepay.client is None:
        bad('Skipped: GROQ_API_KEY is not set.')
    else:
        try:
            cmd = voicepay.llm_parse('send five hundred rupees to Aarav for lunch')
            if str(cmd.get('recipient', '')).lower() == 'aarav' and voicepay.to_amount(cmd.get('amount')) == 500.0:
                ok('Groq understood the command: {}'.format(cmd))
            else:
                bad('Groq replied, but not as expected: {}'.format(cmd))
        except Exception as exc:
            bad('Groq request failed: {}. Check the key, your internet connection and the model names.'.format(exc))

print()
if problems:
    print('{} thing(s) to fix, see the [FIX] lines above.'.format(len(problems)))
    sys.exit(1)
print('All good. Start the app with: python app.py')
