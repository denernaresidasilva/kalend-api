"""Local sshd syntax/effective-context, sudoers parse and shell syntax checks.
No sshd daemon, sudo command execution, system configuration writes or SSH.
"""
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'docs/homologacao/release-controlada'
EVIDENCE = ROOT / 'docs/homologacao/evidencias/2026-10-23-preparacao-definitiva'
EVIDENCE.mkdir(exist_ok=True)


def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(f'{args[0]} exit={r.returncode}: {r.stderr}')
    return r.stdout


with tempfile.TemporaryDirectory(prefix='kalend-audit-static-') as folder:
    folder = Path(folder)
    run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(folder / 'host')])
    base = f'HostKey {folder}/host\nPidFile {folder}/pid\nUsePAM no\nPasswordAuthentication yes\nPermitUserEnvironment no\nAcceptEnv LANG LC_*\n'
    (folder / 'base').write_text(base)
    (folder / 'review').write_text(base + (PACKAGE / 'sshd-audit.fragment.conf').read_text())
    run(['/usr/sbin/sshd', '-t', '-f', str(folder / 'review')])
    controls = ['root', 'clp', 'kalend', 'kalend-api', 'kalend-dev', 'kalend-api-dev']
    for user in controls:
        for addr in ['127.0.0.1', '192.0.2.10']:
            args = ['-T', '-C', f'user={user},host=review.example,addr={addr}']
            assert run(['/usr/sbin/sshd', '-f', str(folder / 'base'), *args]) == run(['/usr/sbin/sshd', '-f', str(folder / 'review'), *args])
    effective = dict(l.split(' ', 1) for l in run(['/usr/sbin/sshd', '-T', '-f', str(folder / 'review'), '-C', 'user=kalend_dev_audit,host=review.example,addr=192.0.2.10']).splitlines())
    expected = dict(forcecommand='/usr/local/libexec/kalend-dev-audit', authorizedkeysfile='/etc/ssh/kalend-dev-keys/%u', disableforwarding='yes', permittty='no', permituserrc='no', passwordauthentication='no', kbdinteractiveauthentication='no', authenticationmethods='publickey', authorizedkeyscommand='none', trustedusercakeys='none', permituserenvironment='no')
    for key, value in expected.items():
        assert effective[key] == value, key
    # Parse real sudo policy grammar, including the broad rule before the scoped deny.
    sudo = 'clp ALL=(ALL) NOPASSWD: ALL\nALL ALL=(ALL) NOPASSWD: /usr/bin/clpctlWrapper\n'
    sudo += (PACKAGE / 'sudoers-audit-only.conf').read_text()
    (folder / 'sudoers').write_text(sudo)
    run(['/usr/sbin/visudo', '-c', '-f', str(folder / 'sudoers')])
    converted = json.loads(run(['/usr/bin/cvtsudoers', '-f', 'json', str(folder / 'sudoers')]))
    # Keep actual parser output as local-model evidence; no claim of live sudo acceptance.
    assert converted['User_Specs'][-1]['User_List'] == [{'username': 'kalend_dev_audit'}]
    assert converted['User_Specs'][-1]['Cmnd_Specs'][0]['Commands'] == [{'command': 'ALL', 'negated': True}]
    blocks = 0
    for doc in ['INTERVENCAO_ADMINISTRATIVA.md', 'DEPENDENCIAS_CLOUDPANEL.md', 'SANDBOX_RESTORE.md', 'PREPARACAO_FINAL_AUDITOR_2026-10-23.md']:
        for code in re.findall(r'```sh\n(.*?)```', (PACKAGE / doc).read_text(), re.S):
            script = folder / 'block.sh'
            script.write_text(code)
            run(['/bin/bash', '-n', str(script)])
            blocks += 1
    summary = dict(ssh_syntax=True, ssh_binary_version=subprocess.run(['/usr/sbin/sshd', '-V'], capture_output=True, text=True).stderr.strip(), controls_unchanged=12, audit_settings=expected, sudoers_syntax=True, sudoers_parsed_last_rule_deny_all=True, shell_blocks=blocks, scope='LOCAL_ONLY_NO_SSH_DAEMON_NO_SUDO_EXECUTION; live sudo -l acceptance remains mandatory')
    (EVIDENCE / 'static.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))
