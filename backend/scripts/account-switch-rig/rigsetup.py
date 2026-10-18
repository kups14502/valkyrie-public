#!/usr/bin/env python3
# Writes the rig's scratch files: dummy store, dummy vault, fake accounts list,
# Claude Code scratch config. Dummy tokens only.
import json, os, sys, time

T = sys.argv[1]
PORT = sys.argv[2]

def w(p, d, mode=0o600):
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        if isinstance(d, str):
            f.write(d)
        else:
            json.dump(d, f)
    os.chmod(tmp, mode)
    os.replace(tmp, p)

far = int(time.time() * 1000) + 300 * 86400 * 1000
toks = {
    'fake-a': 'dummy-A-token-000000000000',
    'fake-b': 'dummy-B-token-000000000000',
    'fake-c': 'dummy-C-token-000000000000',
    'fake-d': 'dummy-D-token-000000000000',
}
w(T + '/store/.credentials.json', {
    'claudeAiOauth': {'accessToken': toks['fake-a'], 'refreshToken': None, 'expiresAt': far,
                      'scopes': ['user:inference'], 'subscriptionType': 'team', 'rateLimitTier': 'default_raven'},
    'mcpOAuth': {'keep-me': {'x': 1}},
})
for i, tok in toks.items():
    w(T + '/sw/tokens/' + i + '.json', {'accountId': i, 'accessToken': tok, 'expiresAt': far, 'scopes': ['user:inference'],
                                        'subscriptionType': 'team', 'rateLimitTier': 'default_raven',
                                        'label': 'Fake ' + i[-1].upper()})
w(T + '/accounts.json', [
    {'id': i, 'label': 'Fake ' + i[-1].upper(), 'email': i + '@example.invalid', 'configDir': T + '/none-' + i}
    for i in toks
])
w(T + '/cfg/.claude.json', {
    'hasCompletedOnboarding': True, 'lastOnboardingVersion': '2.1.283', 'numStartups': 5,
    'projects': {T + '/work': {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True}},
    'oauthAccount': {'accountUuid': '00000000-0000-0000-0000-00000000000a', 'emailAddress': 'account-a@example.invalid',
                     'organizationUuid': '00000000-0000-0000-0000-0000000000aa', 'organizationName': 'Fake Org A'},
})
w(T + '/cfg/settings.json', {'autoUpdates': False, 'autoContinueAtUsageLimit': True})
w(T + '/run.sh', '\n'.join([
    '#!/bin/bash',
    'cd ' + T + '/work',
    'export CLAUDE_CONFIG_DIR=' + T + '/cfg CLAUDE_SECURESTORAGE_CONFIG_DIR=' + T + '/store ANTHROPIC_BASE_URL=http://127.0.0.1:' + PORT,
    'export DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1',
    'export CLAUDE_CODE_NO_FLICKER=${NOFLICKER:-1} CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1',
    'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN',
    'exec ~/.local/bin/claude --model claude-haiku-4-5-20251001',
    '',
]), 0o700)
w(T + '/lilkups-stub', '#!/bin/sh\nprintf "%s\\n" "$*" >> ' + T + '/dm.log\n', 0o700)
print('files written')
