"""Operational failure regressions; no VPS, GitHub writes or financial tests."""
import importlib.util
from pathlib import Path
import unittest
import subprocess
import textwrap

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('safety', ROOT/'scripts/ops/release_safety.py')
S = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(S)


class ReleaseSafetyTests(unittest.TestCase):
    def approved(self):
        return {'database':'kalend_dev', 'api_sha':S.API_SHA, 'web_sha':S.WEB_SHA, **{g:True for g in S.GATES}}

    def test_every_missing_or_unknown_gate_blocks_before_any_step(self):
        for g in S.GATES:
            for v in [False, None, 'true']:
                with self.subTest(gate=g, value=v):
                    a=self.approved();a[g]=v
                    with self.assertRaises(ValueError):S.simulate(a)

    def test_prod_and_unapproved_versions_are_rejected(self):
        for key,value in [('database','kalend'),('api_sha','main'),('web_sha','f'*40)]:
            a=self.approved();a[key]=value
            with self.assertRaises(ValueError):S.simulate(a)

    def test_phase_order_separates_publication_schema_and_activation(self):
        self.assertEqual(S.simulate(self.approved())['done'],list(S.STEPS))

    def test_access_or_backup_failure_never_reaches_migration(self):
        for phase in ['publish_code','backup','classify']:
            r=S.simulate(self.approved(),phase)
            self.assertNotIn('migrate',r['done']);self.assertFalse(r['schema_committed'])
            self.assertFalse(r['automatic_old_api_restart'])

    def test_failed_migration_needs_actual_schema_ledger_inspection(self):
        r=S.simulate(self.approved(),'migrate')
        self.assertEqual(r['recovery'],'verify_schema_ledger_before_resolve')
        self.assertFalse(r['rollback_claim_accepted']);self.assertNotIn('api',r['done'])

    def test_startup_health_or_acceptance_failure_never_restores_old_code_or_database(self):
        for phase in ['api','web','activate','homologate']:
            r=S.simulate(self.approved(),phase)
            self.assertTrue(r['schema_committed']);self.assertTrue(r['keep_maintenance'])
            self.assertFalse(r['automatic_old_api_restart']);self.assertFalse(r['automatic_database_restore'])

    def test_fence_includes_both_dev_uids_and_every_subuid(self):
        text=S.render_fence({'root':0,'clp':1001,'kalend':1019,'kalend-api':1020,'kalend-dev':1021,'kalend-api-dev':1022,'kalend-dev-release':1500}, {'kalend-dev':[(1148576,65536)],'kalend-api-dev':[(1214112,65536)]})
        self.assertIn('1021-1022',text);self.assertIn('1148576-1279647',text)
        self.assertIn('tcp dport 5432 counter reject',text)
        self.assertNotIn('flush ruleset',text);self.assertNotIn('1019',text)

    def test_missing_migrator_root_uid_or_uid_drift_blocks_render(self):
        for accounts in [{'kalend-dev':1021,'kalend-api-dev':1022}, {'kalend-dev':1021,'kalend-api-dev':1022,'kalend-dev-release':0}, {'kalend-dev':1019,'kalend-api-dev':1022,'kalend-dev-release':1500}]:
            with self.assertRaises(ValueError):S.render_fence(accounts,{})

    def test_other_site_primary_or_subordinate_uid_overlap_blocks(self):
        a={'kalend-dev':1021,'kalend-api-dev':1022,'kalend-dev-release':1500,'other':2500}
        with self.assertRaises(ValueError):S.render_fence(a,{'kalend-dev':[(2500,100)]})
        with self.assertRaises(ValueError):S.render_fence(a,{'kalend-dev':[(3000,100)],'other':[(3050,100)]})

    def test_health_200_alone_does_not_accept_wrong_version_schema_or_restart_loop(self):
        evidence={'api_http':200,'web_http':200,'api_sha':S.API_SHA,'web_sha':S.WEB_SHA,'database':'kalend_dev','completed_migrations':19,'restart_loop':False,'sql_role_verified':True,'fence_live':True,'prod_pids_before':{'api':1299},'prod_pids_after':{'api':1299}}
        self.assertTrue(S.validate_activation(evidence))
        for key,value in [('api_http',502),('web_http',502),('api_sha','f'*40),('completed_migrations',18),('restart_loop',True),('fence_live',False),('prod_pids_after',{'api':1})]:
            bad={**evidence,key:value}
            with self.subTest(key=key):
                with self.assertRaises(ValueError):S.validate_activation(bad)

    def test_manual_workflow_shell_rejects_push_and_injected_refs(self):
        for repo in [ROOT,ROOT.parent/'kalend-web']:
            text=(repo/'.github/workflows/deploy-dev.yml').read_text()
            script=textwrap.dedent(text.split('        run: |\n',1)[1])
            good={'PATH':'/usr/bin:/bin','GITHUB_EVENT_NAME':'workflow_dispatch','API_SHA':S.API_SHA,'WEB_SHA':S.WEB_SHA}
            self.assertEqual(subprocess.run(['bash','-c',script],env=good,capture_output=True).returncode,0)
            for key,value in [('GITHUB_EVENT_NAME','push'),('API_SHA','$(exit 0)'),('WEB_SHA','main')]:
                self.assertNotEqual(subprocess.run(['bash','-c',script],env={**good,key:value},capture_output=True).returncode,0)

    def test_both_actual_local_workflows_are_manual_without_ssh_or_secrets(self):
        for repo in [ROOT,ROOT.parent/'kalend-web']:
            paths=list((repo/'.github/workflows').glob('*'))
            self.assertEqual(len(paths),1)
            text=paths[0].read_text()
            self.assertIn('workflow_dispatch:',text)
            for forbidden in ['push:', 'repository_dispatch:', 'workflow_run:', 'schedule:', 'secrets.', 'ssh-action', 'migrate deploy', 'pm2 restart']:
                self.assertNotIn(forbidden,text)
            self.assertIn('cancel-in-progress: false',text)


if __name__=='__main__':unittest.main()
