"""Threat checks for proposed SSH forced commands. No SSH, sudo or application execution."""
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import stat
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'docs/homologacao/release-controlada'


class ForcedCommandTests(unittest.TestCase):
    def run_template(self, name, user, command, owner=0, mode=0o100755, bad_ancestor=False, symlink=False, attrs=(), xattr_error=None):
        path = ROOT / name
        source = compile(path.read_text(), str(path), 'exec')
        output = io.StringIO()
        def file_info(candidate):
            is_final = str(candidate) in [str(path), '/usr/local/share/kalend-dev-audit/backfill-audit.sql']
            if is_final:
                return SimpleNamespace(st_uid=owner, st_mode=(stat.S_IFLNK | 0o777) if symlink else mode)
            return SimpleNamespace(st_uid=1021 if bad_ancestor else 0, st_mode=stat.S_IFDIR | 0o755)
        with patch('pwd.getpwuid', return_value=SimpleNamespace(pw_name=user)), \
             patch('os.getuid', return_value=1021), \
             patch('os.lstat', side_effect=file_info), \
             patch('os.listxattr', return_value=attrs, side_effect=xattr_error), \
             patch.dict('os.environ', {'SSH_ORIGINAL_COMMAND': command, 'DATABASE_URL': 'MUST_NOT_INHERIT'}, clear=True), \
             patch('subprocess.run', return_value=SimpleNamespace(stdout='a'*40+'\n')) as run, \
             patch('os.execve') as execute, contextlib.redirect_stdout(output):
            error = None
            try:
                exec(source, {'__file__': str(path), '__name__': '__main__'})
            except SystemExit as exc:
                error = str(exc)
            return error, output.getvalue(), run.call_args_list, execute.call_args_list

    def test_release_preflight_is_fixed_and_never_activates(self):
        for user, port in [('kalend-dev', 3002), ('kalend-api-dev', 3003)]:
            error, output, calls, executes = self.run_template('kalend-dev-release-gate', user, 'preflight')
            self.assertIsNone(error)
            self.assertEqual(json.loads(output)['port'], port)
            self.assertEqual(len(calls), 1)
            self.assertEqual(executes, [])
            self.assertNotIn('DATABASE_URL', calls[0].kwargs['env'])
            self.assertEqual(calls[0].args[0][-3:], ['rev-parse', '--verify', 'HEAD'])

    def test_release_rejects_other_identity(self):
        error, _, calls, executes = self.run_template('kalend-dev-release-gate', 'root', 'preflight')
        self.assertIn('COMMAND_NOT_ALLOWED', error)
        self.assertEqual(calls + executes, [])

    def test_release_rejects_command_injection_and_activation(self):
        for command in ['deploy', 'preflight; echo injected', 'preflight\nanything', '']:
            error, _, calls, executes = self.run_template('kalend-dev-release-gate', 'kalend-dev', command)
            self.assertIn('COMMAND_NOT_ALLOWED', error)
            self.assertEqual(calls + executes, [])

    def test_release_rejects_writable_or_non_root_gate(self):
        for owner, mode in [(1021, 0o100755), (0, 0o100775), (0, 0o100777)]:
            error, _, calls, executes = self.run_template('kalend-dev-release-gate', 'kalend-dev', 'preflight', owner, mode)
            self.assertEqual(error, 'UNSAFE_GATE_FILE')
            self.assertEqual(calls + executes, [])

    def test_audit_uses_fixed_sql_database_role_and_readonly_snapshot(self):
        error, _, calls, executes = self.run_template('kalend-dev-audit', 'kalend_dev_audit', 'backfill-audit')
        self.assertIsNone(error)
        self.assertEqual(calls, [])
        self.assertEqual(len(executes), 1)
        binary, args, env = executes[0].args
        self.assertEqual(binary, '/usr/lib/postgresql/16/bin/psql')
        self.assertIn('row_security=off', env['PGOPTIONS'])
        self.assertIn('search_path=pg_catalog,public', env['PGOPTIONS'])
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', args)
        self.assertEqual(args[args.index('-d') + 1], 'kalend_dev')
        self.assertEqual(args[args.index('-U') + 1], 'kalend_dev_audit')
        self.assertNotIn('DATABASE_URL', env)

    def test_audit_rejects_other_identity(self):
        error, _, calls, executes = self.run_template('kalend-dev-audit', 'kalend-api-dev', 'backfill-audit')
        self.assertEqual(error, 'AUDIT_IDENTITY_REQUIRED')
        self.assertEqual(calls + executes, [])

    def test_audit_rejects_arbitrary_sql_or_command(self):
        error, _, calls, executes = self.run_template('kalend-dev-audit', 'kalend_dev_audit', 'backfill-audit; SELECT 1')
        self.assertEqual(error, 'COMMAND_NOT_ALLOWED')
        self.assertEqual(calls + executes, [])

    def test_audit_rejects_unsafe_file(self):
        error, _, calls, executes = self.run_template('kalend-dev-audit', 'kalend_dev_audit', 'backfill-audit', 1021)
        self.assertEqual(error, 'UNSAFE_AUDIT_FILE')
        self.assertEqual(calls + executes, [])

    def test_parent_replacement_is_rejected(self):
        for name, user, command in [('kalend-dev-audit', 'kalend_dev_audit', 'backfill-audit'), ('kalend-dev-release-gate', 'kalend-dev', 'preflight')]:
            error, _, calls, executes = self.run_template(name, user, command, bad_ancestor=True)
            self.assertIn('UNSAFE_', error)
            self.assertEqual(calls + executes, [])

    def test_symlink_is_rejected_even_when_target_could_be_root_owned(self):
        error, _, calls, executes = self.run_template('kalend-dev-audit', 'kalend_dev_audit', 'backfill-audit', symlink=True)
        self.assertEqual(error, 'UNSAFE_AUDIT_FILE')
        self.assertEqual(calls + executes, [])

    def test_acl_and_capability_are_rejected_before_any_execution(self):
        for name, user, command in [('kalend-dev-audit', 'kalend_dev_audit', 'backfill-audit'), ('kalend-dev-release-gate', 'kalend-dev', 'preflight')]:
            for attr in ['system.posix_acl_access', 'system.posix_acl_default', 'security.capability', 'system.nfs4_acl']:
                error, _, calls, executes = self.run_template(name, user, command, attrs=[attr])
                self.assertIn('UNSAFE_', error)
                self.assertEqual(calls + executes, [])

    def test_unreadable_or_unsupported_xattrs_fail_closed(self):
        for name, user, command in [('kalend-dev-audit', 'kalend_dev_audit', 'backfill-audit'), ('kalend-dev-release-gate', 'kalend-dev', 'preflight')]:
            error, _, calls, executes = self.run_template(name, user, command, xattr_error=OSError('unsupported'))
            self.assertIn('UNSAFE_', error)
            self.assertEqual(calls + executes, [])


if __name__ == '__main__':
    unittest.main()
