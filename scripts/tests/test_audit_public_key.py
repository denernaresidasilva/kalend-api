"""Actual public key/fingerprint and option-policy regressions; no private key read."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'docs/homologacao/release-controlada'
SPEC = importlib.util.spec_from_file_location('audit_public', PACKAGE / 'check-audit-public-key.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class PublicKeyTests(unittest.TestCase):
    def setUp(self):
        self.text = (PACKAGE / 'audit.authorized_keys').read_text()
        self.fingerprint = json.loads((PACKAGE / 'audit-key-public.json').read_text())['fingerprint_sha256']

    def test_actual_ed25519_and_fingerprint_match_ssh_keygen(self):
        self.assertEqual(CHECK.validate_key(self.text, self.fingerprint), self.fingerprint)
        actual = subprocess.check_output(['ssh-keygen', '-lf', str(PACKAGE / 'audit.authorized_keys'), '-E', 'sha256'], text=True).split()[1]
        self.assertEqual(actual, self.fingerprint)

    def test_wrong_fingerprint_rejected(self):
        with self.assertRaises(ValueError):
            CHECK.validate_key(self.text, 'SHA256:OTHER')

    def test_shell_forwarding_pty_and_other_commands_rejected(self):
        for options in ['command="/bin/sh"', 'restrict', 'restrict,command="/bin/bash"', 'restrict,command="/usr/local/libexec/kalend-dev-audit",pty', 'restrict,command="/usr/local/libexec/kalend-dev-audit",agent-forwarding']:
            bad = options + ' ' + self.text.split(' ', 1)[1]
            with self.assertRaises(ValueError):
                CHECK.validate_key(bad, self.fingerprint)

    def test_multiple_keys_placeholders_private_and_malformed_fail(self):
        for text in [self.text + self.text, self.text.replace('ssh-ed25519', 'ssh-rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n', self.text.replace(self.text.split()[2], 'REPLACE_KEY'), self.text.replace(self.text.split()[2], 'AAAA')]:
            with self.assertRaises(ValueError):
                CHECK.validate_key(text, self.fingerprint)

    def test_approved_origin_is_required_and_preserved_when_supplied(self):
        text = self.text.replace('" ssh-ed25519', '",from="192.0.2.0/24" ssh-ed25519')
        self.assertEqual(CHECK.validate_key(text, self.fingerprint, '192.0.2.0/24'), self.fingerprint)
        for approved in [None, '198.51.100.0/24', '*']:
            with self.assertRaises(ValueError):
                CHECK.validate_key(text, self.fingerprint, approved)


if __name__ == '__main__':
    unittest.main()
