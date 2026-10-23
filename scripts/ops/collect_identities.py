#!/usr/bin/python3 -I
"""Future root read-only collector. No env, SQL passwords, shell commands or writes."""
import grp
import json
import os
from pathlib import Path
import pwd
import sys

if os.getuid()!=0 or os.uname().nodename!='srv1119527' or len(sys.argv)!=1:
    sys.exit('HOST_ADMIN_REQUIRED')
accounts={p.pw_name:p.pw_uid for p in pwd.getpwall()}
ranges={}
for line in Path('/etc/subuid').read_text().splitlines():
    name,start,count=line.split(':');ranges.setdefault(name,[]).append([int(start),int(count)])
selected={}
for name in ['kalend-dev','kalend-api-dev','kalend-dev-release']:
    if name not in accounts:sys.exit('EXPECTED_IDENTITY_ABSENT')
    p=pwd.getpwnam(name)
    selected[name]={'uid':p.pw_uid,'primary_gid':p.pw_gid,'supplementary_groups':[g.gr_name for g in grp.getgrall() if name in g.gr_mem and g.gr_gid!=p.pw_gid]}
print(json.dumps({'hostname':os.uname().nodename,'accounts':accounts,'subordinate_ranges':ranges,'selected':selected},indent=2))
