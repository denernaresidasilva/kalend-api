#!/usr/bin/python3 -I
"""Read-only Phase A installation acceptance. No getfacl, writes or subprocesses.
Reject all ACLs/capabilities; unsupported/unreadable xattrs are a hard stop.
Run from the reviewed root-private staging after installation, before SSH reload.
"""
import grp
import os
import pwd
import stat
import sys


def check_path(path, *, uid=0, gid=None, mode=None, directory=False):
    if not path.startswith('/') or os.path.normpath(path) != path:
        raise ValueError('NON_CANONICAL_PATH')
    current = '/'
    for part in [''] + path.split('/')[1:]:
        current = os.path.join(current, part)
        info = os.lstat(current)
        attrs = os.listxattr(current, follow_symlinks=False)
        if any('acl' in a.lower() or a == 'security.capability' for a in attrs):
            raise ValueError('ACL_OR_CAPABILITY_PRESENT')
        if info.st_uid != uid or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError('UNTRUSTED_PATH')
        final = current == path
        if (not final or directory) and not stat.S_ISDIR(info.st_mode):
            raise ValueError('DIRECTORY_REQUIRED')
        if final:
            if not directory and not stat.S_ISREG(info.st_mode):
                raise ValueError('REGULAR_FILE_REQUIRED')
            if mode is not None and stat.S_IMODE(info.st_mode) != mode:
                raise ValueError('WRONG_MODE')
            if gid is not None and info.st_gid != gid:
                raise ValueError('WRONG_GROUP')


def main():
    if len(sys.argv) != 1 or os.getuid() != 0:
        raise ValueError('ADMIN_NO_ARGUMENTS_REQUIRED')
    user = pwd.getpwnam('kalend_dev_audit')
    group = grp.getgrgid(user.pw_gid)
    if (group.gr_name != user.pw_name or set(group.gr_mem) - {user.pw_name}
            or any(p.pw_gid == user.pw_gid and p.pw_name != user.pw_name
                   for p in pwd.getpwall())
            or any(user.pw_name in g.gr_mem and g.gr_gid != user.pw_gid
                   for g in grp.getgrall())):
        raise ValueError('AUDIT_GROUP_NOT_EXCLUSIVE')
    check_path('/home/kalend_dev_audit', gid=0, mode=0o755, directory=True)
    check_path('/etc/ssh/kalend-dev-keys', gid=0, mode=0o755, directory=True)
    check_path('/etc/ssh/kalend-dev-keys/kalend_dev_audit', gid=user.pw_gid, mode=0o640)
    check_path('/usr/local/libexec/kalend-dev-audit', gid=0, mode=0o755)
    check_path('/usr/local/share/kalend-dev-audit', gid=0, mode=0o755, directory=True)
    check_path('/usr/local/share/kalend-dev-audit/backfill-audit.sql', gid=0, mode=0o644)
    check_path('/etc/ssh/sshd_config.d/90-kalend-audit.conf', gid=0, mode=0o644)
    check_path('/etc/sudoers.d/zz-kalend-audit-deny', gid=0, mode=0o440)
    print('AUDIT_FILES_VALIDATED_NO_ACL_NO_CAPABILITY')


if __name__ == '__main__':
    try:
        main()
    except (OSError, KeyError, ValueError):
        sys.exit('AUDIT_FILE_CHECK_BLOCKED')
