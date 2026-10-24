"""Local regressions. No system accounts, sudo policy, SSH or remote mutation."""
import errno
import importlib.util
import os
from pathlib import Path
import stat
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('audit_files', ROOT / 'docs/homologacao/release-controlada/check-audit-files.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class AuditPermissionsTests(unittest.TestCase):
    def check_model(self, mode=0o640, attrs=(), error=None, symlink=False):
        def info(path):
            return SimpleNamespace(st_uid=0, st_gid=1234 if path == '/keys/audit' else 0,
                                   st_mode=(stat.S_IFLNK | 0o777 if symlink else stat.S_IFREG | mode) if path == '/keys/audit' else stat.S_IFDIR | 0o755)
        with patch('os.lstat', side_effect=info), patch('os.listxattr', return_value=attrs, side_effect=error):
            CHECK.check_path('/keys/audit', gid=1234, mode=0o640)

    def test_root_owned_group_readable_key_passes(self):
        self.check_model()

    def test_old_root_0600_and_world_or_group_writable_key_fail(self):
        for mode in [0o600, 0o660, 0o666, 0o644]:
            with self.assertRaises(ValueError):
                self.check_model(mode=mode)

    def test_symlink_fails(self):
        with self.assertRaises(ValueError):
            self.check_model(symlink=True)

    def test_access_default_and_unknown_acl_and_capability_fail(self):
        for attr in ['system.posix_acl_access', 'system.posix_acl_default', 'system.nfs4_acl', 'security.capability']:
            with self.assertRaises(ValueError):
                self.check_model(attrs=[attr])

    def test_xattr_permission_error_or_unsupported_is_not_absence(self):
        for number in [errno.EACCES, errno.ENOTSUP, errno.EIO]:
            with self.assertRaises(OSError):
                self.check_model(error=OSError(number, 'blocked'))

    def test_native_linux_acl_visible_without_getfacl(self):
        # Own disposable directory only; real Linux default ACL via xattr syscall.
        with tempfile.TemporaryDirectory(prefix='kalend-acl-regression-') as folder:
            path = Path(folder) / 'child'
            path.mkdir()
            acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', tag, perm, 0xffffffff)
                                                    for tag, perm in [(1, 7), (4, 5), (32, 0)])
            os.setxattr(path, 'system.posix_acl_default', acl)
            self.assertIn('system.posix_acl_default', os.listxattr(path, follow_symlinks=False))
            # Substitute only trust ownership/ancestors: actual ACL query remains real.
            original = os.lstat
            def info(p):
                s = original(p)
                return SimpleNamespace(st_uid=0, st_gid=s.st_gid, st_mode=s.st_mode & ~0o022)
            with patch('os.lstat', side_effect=info):
                with self.assertRaisesRegex(ValueError, 'ACL_OR_CAPABILITY_PRESENT'):
                    CHECK.check_path(str(path), directory=True)

    def test_acl_on_root_or_ancestor_also_fails(self):
        for bad in ['/', '/keys']:
            def attrs(path, **kwargs):
                return ['system.posix_acl_default'] if path == bad else []
            with patch('os.lstat', return_value=SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o755)), patch('os.listxattr', side_effect=attrs):
                with self.assertRaisesRegex(ValueError, 'ACL_OR_CAPABILITY_PRESENT'):
                    CHECK.check_path('/keys/audit')

    def test_wrong_key_group_fails(self):
        def info(path):
            return SimpleNamespace(st_uid=0, st_gid=0, st_mode=(stat.S_IFREG | 0o640) if path == '/keys/audit' else stat.S_IFDIR | 0o755)
        with patch('os.lstat', side_effect=info), patch('os.listxattr', return_value=[]):
            with self.assertRaisesRegex(ValueError, 'WRONG_GROUP'):
                CHECK.check_path('/keys/audit', gid=1234, mode=0o640)

    def test_group_shared_primary_or_supplementary_is_rejected(self):
        user = SimpleNamespace(pw_name='kalend_dev_audit', pw_gid=1234)
        for people, groups in [([user, SimpleNamespace(pw_name='other', pw_gid=1234)], []), ([user], [SimpleNamespace(gr_name='sudo', gr_gid=27, gr_mem=['kalend_dev_audit'])])]:
            with patch('sys.argv', ['check']), patch('os.getuid', return_value=0), patch('pwd.getpwnam', return_value=user), patch('grp.getgrgid', return_value=SimpleNamespace(gr_name='kalend_dev_audit', gr_mem=[])), patch('pwd.getpwall', return_value=people), patch('grp.getgrall', return_value=groups):
                with self.assertRaisesRegex(ValueError, 'AUDIT_GROUP_NOT_EXCLUSIVE'):
                    CHECK.main()

    def test_documented_key_installation_and_no_getfacl_command(self):
        doc = (ROOT / 'docs/homologacao/release-controlada/INTERVENCAO_ADMINISTRATIVA.md').read_text()
        self.assertIn('install -o root -g kalend_dev_audit -m 0640 audit.authorized_keys', doc)
        self.assertNotIn('\ngetfacl ', doc)


if __name__ == '__main__':
    unittest.main()
