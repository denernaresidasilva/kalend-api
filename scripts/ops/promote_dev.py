#!/usr/bin/python3 -I
"""Fixed-path, NONROOT artifact rename only. Never starts code/services or restores DB.
Caller must already have an approved maintenance window and root-owned approval.
"""
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys

PROFILES={'api':('kalend-api-dev','api-dev.kalend.tech'),'web':('kalend-dev','dev.kalend.tech')}


def switch(parent,sha,expected_uid,artifact_owner=0):
    if not re.fullmatch('[0-9a-f]{40}',sha):raise ValueError('INVALID_SHA')
    if os.getuid()!=expected_uid or os.geteuid()!=expected_uid or expected_uid==0:raise ValueError('NONROOT_SERVICE_IDENTITY_REQUIRED')
    # O_NOFOLLOW for every component. No caller-controlled shell/command/path in CLI.
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in Path(parent).parts[1:]:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
        candidate='candidate.'+sha;previous='previous-before-'+sha
        for name in ['app',candidate]:
            info=os.stat(name,dir_fd=fd,follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):raise ValueError('DIRECTORY_OR_SYMLINK_REJECTED')
        try:os.stat(previous,dir_fd=fd,follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise ValueError('PREVIOUS_ARTIFACT_MUST_NOT_BE_OVERWRITTEN')
        cfd=os.open(candidate,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
        try:
            marker=os.open('RELEASE.json',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=cfd)
            info=os.fstat(marker)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=artifact_owner or info.st_mode&0o022:os.close(marker);raise ValueError('UNTRUSTED_ARTIFACT_MARKER')
            with os.fdopen(marker) as f:metadata=json.load(f)
            if metadata.get('sha')!=sha or metadata.get('database')!='kalend_dev':raise ValueError('ARTIFACT_VERSION_OR_TARGET_MISMATCH')
        finally:os.close(cfd)
        os.rename('app',previous,src_dir_fd=fd,dst_dir_fd=fd)
        try:os.rename(candidate,'app',src_dir_fd=fd,dst_dir_fd=fd)
        except BaseException:
            os.rename(previous,'app',src_dir_fd=fd,dst_dir_fd=fd);raise
        return {'promoted':sha,'previous_retained':previous,'services_started':False,'schema_rollback_performed':False}
    finally:os.close(fd)


if __name__=='__main__':
    try:
        if len(sys.argv)!=3 or sys.argv[1] not in PROFILES:raise ValueError('SERVICE_AND_SHA_REQUIRED')
        service,sha=sys.argv[1:]
        # Root-owned approval is an operator decision, not executable code or credentials.
        path=Path('/etc/kalend-dev-release/approved.json')
        for parent in [Path('/etc'),path.parent,path]:
            info=parent.lstat()
            if info.st_uid!=0 or info.st_mode&0o022 or stat.S_ISLNK(info.st_mode) or (parent==path and not stat.S_ISREG(info.st_mode)):raise ValueError('UNTRUSTED_APPROVAL')
        approval=json.loads(path.read_text())
        if approval.get(service+'_sha')!=sha or approval.get('maintenance_authorized') is not True:raise ValueError('APPROVAL_MISMATCH')
        user,domain=PROFILES[service]
        print(json.dumps(switch('/home/'+user+'/htdocs/'+domain,sha,pwd.getpwnam(user).pw_uid)))
    except (OSError,ValueError,KeyError):sys.exit('PROMOTION_BLOCKED')
