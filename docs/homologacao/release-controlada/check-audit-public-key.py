#!/usr/bin/python3 -I
"""Validate a PUBLIC authorized_keys entry only; never opens a private key.
The expected fingerprint must be approved out-of-band, not learned from the file.
No network, SSH, shell or subprocess execution.
"""
import base64
import hashlib
import hmac
import ipaddress
from pathlib import Path
import struct
import sys


def validate_key(text, expected_fingerprint, approved_from=None):
    lines = text.splitlines()
    if len(lines) != 1 or 'PRIVATE KEY' in text or 'REPLACE_' in text:
        raise ValueError('ONE_REAL_PUBLIC_KEY_REQUIRED')
    fields = lines[0].split()
    if len(fields) not in (3, 4):
        raise ValueError('INVALID_PUBLIC_KEY_ENTRY')
    options = 'restrict,command="/usr/local/libexec/kalend-dev-audit"'
    if approved_from is not None:
        networks = approved_from.split(',')
        if not networks:
            raise ValueError('INVALID_APPROVED_ORIGIN')
        for network in networks:
            ipaddress.ip_network(network, strict=True)
        options += ',from="' + approved_from + '"'
    if fields[0] != options or fields[1] != 'ssh-ed25519':
        raise ValueError('UNAPPROVED_KEY_OPTIONS_OR_ALGORITHM')
    blob = base64.b64decode(fields[2], validate=True)
    # RFC 4253 string algorithm + Ed25519 public key (32 bytes), no trailing data.
    if len(blob) != 51 or blob[:19] != struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32):
        raise ValueError('INVALID_ED25519_PUBLIC_BLOB')
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=')
    if not hmac.compare_digest(fingerprint, expected_fingerprint):
        raise ValueError('PUBLIC_KEY_FINGERPRINT_MISMATCH')
    return fingerprint


if __name__ == '__main__':
    try:
        if len(sys.argv) not in (3, 4):
            raise ValueError('PUBLIC_FILE_AND_APPROVED_FINGERPRINT_REQUIRED')
        fingerprint = validate_key(Path(sys.argv[1]).read_text(), sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
        print('AUDIT_PUBLIC_KEY_VALIDATED ' + fingerprint)
    except (OSError, ValueError, UnicodeError):
        sys.exit('AUDIT_PUBLIC_KEY_CHECK_BLOCKED')
