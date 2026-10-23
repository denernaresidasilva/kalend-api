"""Local-only rehearsal of the approved private DEV snapshot. No SSH/network writes.
Creates a NEW private namespace cluster; never reuses a live database or .env.
Raw data and logs remain outside Git. Only aggregate results enter evidence.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
assert os.getuid() != 0, 'LOCAL_NONROOT_REQUIRED'
os.umask(0o077)
source_meta = json.loads((ROOT/'docs/homologacao/evidencias/2026-10-23-financeiro-real/resumo.json').read_text())
source = Path(source_meta['local_private_directory'])
assert source.parent == Path.home() and source.name.startswith('kalend-private-restore-')
assert not source.is_symlink() and source.stat().st_uid == os.getuid() and stat.S_IMODE(source.stat().st_mode) == 0o700
assert hashlib.sha256((source/'kalend_dev.dump').read_bytes()).hexdigest() == source_meta['backup_sha256']
work = Path(tempfile.mkdtemp(prefix='kalend-private-migration-', dir=Path.home()))
assert not work.is_relative_to(ROOT)
for name in ['kalend_dev.dump', 'snapshot-manifest.private.json']:
    shutil.copyfile(source/name, work/name); os.chmod(work/name, 0o600)
shutil.copytree(ROOT/'prisma/migrations', work/'migrations')
shutil.copyfile(ROOT/'prisma/schema.prisma', work/'schema.prisma')
shutil.copyfile(ROOT/'prisma/migrations/20261017090000_subscription_entitlement_evidence/migration.sql', work/'migration.sql')
shutil.copyfile(ROOT/'scripts/rehearsal/migration-sandbox.py', work/'migration-sandbox.py')
(work/'prisma.config.mjs').write_text("export default {schema:'/work/schema.prisma',migrations:{path:'/work/migrations'},datasource:{url:process.env.DATABASE_URL}};\n")
(work/'ISOLATED_REHEARSAL').write_text(source_meta['backup_sha256'])
node = Path.home()/'.nvm/versions/node/v24.21.0'
command = ['bwrap', '--unshare-user', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv']
for src, dst in [('/usr','/usr'),('/bin','/bin'),('/lib','/lib'),('/lib64','/lib64'),('/etc/passwd','/etc/passwd'),('/etc/group','/etc/group'),('/tmp/kalend-native-pg-packages/root','/pgroot'),(str(node),'/node'),(str(ROOT/'node_modules'),'/app/node_modules'),(str(ROOT/'dist'),'/app/dist'),(str(ROOT/'scripts/rehearsal/candidate-probe.mjs'),'/app/candidate-probe.mjs')]:
    command += ['--ro-bind', src, dst]
command += ['--proc','/proc','--dev','/dev','--tmpfs','/dev/shm','--tmpfs','/tmp','--bind',str(work),'/work','--chdir','/work','--setenv','PATH','/usr/bin:/bin','--setenv','HOME','/work','--setenv','LD_LIBRARY_PATH','/pgroot/usr/lib/x86_64-linux-gnu','--','/usr/bin/python3','/work/migration-sandbox.py']
with (work/'execution.private.log').open('x') as log:
    run = subprocess.run(command, stdout=log, stderr=log, timeout=300)
if run.returncode:
    print(json.dumps({'success':False,'private_work_directory':str(work),'exit':run.returncode}));raise SystemExit(1)
report = json.loads((work/'rehearsal.sanitized.json').read_text())
report['private_work_directory'] = str(work)
evidence = ROOT/'docs/homologacao/evidencias/2026-10-23-migration-real-copy'
evidence.mkdir(exist_ok=True)
(evidence/'rehearsal.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
