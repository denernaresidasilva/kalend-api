"""Nonfinancial, local namespace-only checks of UID fence and SQL role/HBA scope.
Never connects to VPS. SQL/bootstrap roles exist only in a new disposable cluster.
"""
import ctypes
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT/'docs/homologacao/operacao-dev'


def network():
    assert os.getuid() == 0 and os.environ.get('KALEND_TEST_NETNS') == '1'
    # This process is namespace-root, mapped to the local unprivileged user.
    subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True)
    checks=[]
    def connect(port,family=socket.AF_INET):
        with socket.socket(family,socket.SOCK_STREAM) as s:
            s.settimeout(1)
            try:s.connect(('::1' if family==socket.AF_INET6 else '127.0.0.1',port));return True
            except OSError:return False
    sockets=[]
    for family,port in [(socket.AF_INET,5432),(socket.AF_INET6,5432),(socket.AF_INET,8080)]:
        s=socket.socket(family,socket.SOCK_STREAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        if family==socket.AF_INET6:s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
        s.bind(('::1' if family==socket.AF_INET6 else '127.0.0.1',port));s.listen(20);sockets.append(s)
        def accept(s=s):
            while True:
                try:c,_=s.accept();c.close()
                except OSError:return
        threading.Thread(target=accept,daemon=True).start()
    try:
        assert connect(5432) and connect(5432,socket.AF_INET6);checks.append('baseline_tcp_fixture_reachable_ipv4_ipv6')
        rule='table inet kalend_dev_release {\n chain postgres_tcp_fence {\n type filter hook output priority 10; policy accept;\n meta skuid 0 tcp dport 5432 counter reject\n }\n}\n'
        # Parse the actual rendered configuration as well as the matching-UID fixture.
        import importlib.util
        spec=importlib.util.spec_from_file_location('safety',ROOT/'scripts/ops/release_safety.py')
        safety=importlib.util.module_from_spec(spec);spec.loader.exec_module(safety)
        generated=safety.render_fence({'root':0,'kalend':1019,'kalend-api':1020,'kalend-dev':1021,'kalend-api-dev':1022,'kalend-dev-release':1500},{'kalend-dev':[(1148576,65536)],'kalend-api-dev':[(1214112,65536)]})
        subprocess.run(['/usr/sbin/nft','-c','-f','/dev/stdin'],input=generated,text=True,check=True)
        checks.append('actual_rendered_uid_and_subuid_configuration_parsed')
        subprocess.run(['/usr/sbin/nft','-c','-f','/dev/stdin'],input=rule,text=True,check=True)
        subprocess.run(['/usr/sbin/nft','-f','/dev/stdin'],input=rule,text=True,check=True)
        assert not connect(5432) and not connect(5432,socket.AF_INET6);checks.append('matching_uid_tcp_rejected_ipv4_ipv6')
        assert connect(8080);checks.append('unrelated_port_unaffected')
        subprocess.run(['/usr/sbin/nft','delete','table','inet','kalend_dev_release'],check=True)
        rule=rule.replace('meta skuid 0','meta skuid 1')
        subprocess.run(['/usr/sbin/nft','-f','/dev/stdin'],input=rule,text=True,check=True)
        assert connect(5432);checks.append('unmatched_uid_unaffected')
        # Deletion here affects only this disposable network namespace.
        subprocess.run(['/usr/sbin/nft','delete','table','inet','kalend_dev_release'],check=True)
    finally:
        for s in sockets:s.close()
    return checks


def sql_controls():
    binary=Path('/tmp/kalend-native-pg-packages/root/usr/lib/postgresql/16/bin')
    env={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'LD_LIBRARY_PATH':str(binary.parents[3]/'lib/x86_64-linux-gnu'),'LANG':'C'}
    folder=Path(tempfile.mkdtemp(prefix='kalend-ops-sql-'));os.chmod(folder,0o700)
    checks=[];started=False
    base=['-h',str(folder),'-p','55452','-X','-qAt','-w','-v','ON_ERROR_STOP=1']
    def command(name,args,content=None,good=True):
        r=subprocess.run([str(binary/name),*args],input=content,text=True,capture_output=True,env=env)
        if good and r.returncode:raise AssertionError(name+': '+r.stderr)
        if not good:assert r.returncode!=0
        return r
    def q(db,text,user='fixture_bootstrap',good=True):return command('psql',[*base,'-U',user,'-d',db],text,good)
    try:
        command('initdb',['-D',str(folder/'cluster'),'-U','fixture_bootstrap','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
        command('pg_ctl',['-D',str(folder/'cluster'),'-l',str(folder/'server.log'),'-o',f"-h '' -p 55452 -k {folder}",'-w','start']);started=True
        q('postgres','CREATE ROLE kalend LOGIN NOSUPERUSER; CREATE DATABASE kalend_ops_fixture_dev OWNER kalend; CREATE DATABASE kalend_ops_fixture_other OWNER kalend;')
        q('kalend_ops_fixture_dev',"CREATE TYPE public.fixture_state AS ENUM ('ACTIVE'); CREATE TABLE public.\"Subscription\"(id int PRIMARY KEY); CREATE TABLE public.\"Payment\"(id int PRIMARY KEY,sub_id int REFERENCES public.\"Subscription\"(id)); INSERT INTO public.\"Subscription\" VALUES(1); INSERT INTO public.\"Payment\" VALUES(1,1); CREATE FUNCTION public.fixture_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';",'kalend')
        q('kalend_ops_fixture_other','CREATE TABLE public.protected_fixture(id int); INSERT INTO public.protected_fixture VALUES(42);','kalend')
        capture=(PACKAGE/'capture-ownership-rollback.sql').read_text().replace("current_database()<>'kalend_dev'","current_database()<>'kalend_ops_fixture_dev'")
        rollback=q('kalend_ops_fixture_dev',capture).stdout.replace("current_database()<>'kalend_dev'","current_database()<>'kalend_ops_fixture_dev'").replace('DATABASE kalend_dev ','DATABASE kalend_ops_fixture_dev ')
        original=(PACKAGE/'isolate-dev.sql').read_text()
        q('kalend_ops_fixture_other',original,good=False)
        assert q('postgres',"SELECT count(*) FROM pg_roles WHERE rolname='kalend_dev_migrator'").stdout.strip()=='0';checks.append('wrong_database_guard_transactional_no_role_created')
        script=original.replace("current_database()<>'kalend_dev'","current_database()<>'kalend_ops_fixture_dev'").replace('DATABASE kalend_dev ','DATABASE kalend_ops_fixture_dev ')
        q('kalend_ops_fixture_dev',script)
        q('kalend_ops_fixture_dev',rollback)
        assert q('postgres',"SELECT count(*) FROM pg_roles WHERE rolname IN ('kalend_dev_runtime','kalend_dev_migrator')").stdout.strip()=='0'
        assert q('kalend_ops_fixture_dev',"SELECT relowner::regrole FROM pg_class WHERE oid='public.\"Payment\"'::regclass").stdout.strip()=='kalend'
        checks.append('pre_schema_ownership_rollback_removes_only_new_roles_and_restores_dev_owner')
        q('kalend_ops_fixture_dev',script)
        flags=q('kalend_ops_fixture_dev',"SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user",'kalend_dev_runtime').stdout.strip()
        assert flags=='f';checks.append('runtime_no_cluster_privileges')
        q('kalend_ops_fixture_dev','SELECT * FROM "Payment"; UPDATE "Payment" SET id=id;','kalend_dev_runtime');checks.append('runtime_app_select_and_update_allowed')
        for text in ['CREATE TABLE public.forbidden(id int);','ALTER TABLE public."Payment" ADD COLUMN forbidden int;','SET ROLE kalend;','CREATE DATABASE forbidden;','TRUNCATE public."Payment";']:
            q('kalend_ops_fixture_dev',text,'kalend_dev_runtime',good=False)
        checks.append('runtime_ddl_setrole_createdb_truncate_rejected')
        q('kalend_ops_fixture_dev','CREATE TABLE public.future_evidence(id int);','kalend_dev_migrator')
        q('kalend_ops_fixture_dev','INSERT INTO public.future_evidence VALUES(1); SELECT * FROM public.future_evidence;','kalend_dev_runtime');checks.append('future_migration_default_privileges_work')
        assert q('kalend_ops_fixture_other','SELECT * FROM protected_fixture;','kalend').stdout.strip()=='42';checks.append('other_database_owner_and_data_unchanged')
        q('kalend_ops_fixture_other','SELECT * FROM protected_fixture;','kalend_dev_migrator',good=False);checks.append('migrator_cannot_read_other_database_data')
        hba=(PACKAGE/'pg_hba.fragment.conf').read_text().replace('local kalend_dev ','local kalend_ops_fixture_dev ')
        (folder/'cluster/pg_hba.conf').write_text(hba+'\nlocal all all trust\n')
        osname=pwd.getpwuid(os.getuid()).pw_name
        (folder/'cluster/pg_ident.conf').write_text((PACKAGE/'pg_ident.fragment.conf').read_text().replace('kalend-api-dev',osname).replace('kalend-dev-release','never_local_migrator'))
        command('pg_ctl',['-D',str(folder/'cluster'),'reload'])
        import time;time.sleep(.2)
        q('kalend_ops_fixture_dev','SELECT current_user;','kalend_dev_runtime');checks.append('runtime_peer_dev_allowed')
        q('kalend_ops_fixture_other','SELECT 1;','kalend_dev_runtime',good=False);checks.append('runtime_other_database_connection_rejected_by_hba')
        q('kalend_ops_fixture_dev','SELECT 1;','kalend_dev_migrator',good=False);checks.append('runtime_os_identity_cannot_authenticate_as_migrator')
    finally:
        if started:command('pg_ctl',['-D',str(folder/'cluster'),'-m','fast','-w','stop'])
    return {'checks':checks,'cluster_stopped':True,'private_fixture_directory':str(folder),'scope':'synthetic metadata/privileges only; no financial backfill rerun'}


if __name__=='__main__':
    if len(sys.argv)==2 and sys.argv[1]=='--network-fixture':
        print(json.dumps(network()))
    else:
        net=subprocess.run(['unshare','--user','--map-root-user','--net','env','KALEND_TEST_NETNS=1',sys.executable,str(Path(__file__).resolve()),'--network-fixture'],text=True,capture_output=True)
        assert net.returncode==0,net.stderr
        result={'network_namespace':json.loads(net.stdout),'sql':sql_controls(),'no_remote_operations':True}
        out=ROOT/'docs/homologacao/evidencias/2026-10-23-operacao-dev';out.mkdir(exist_ok=True)
        (out/'native-controls.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
