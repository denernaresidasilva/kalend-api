"""Offline release planning and simulation. NEVER executes SSH, SQL, PM2 or root actions.
Assertions are review gates, not a substitute for measured technical controls.
"""
import json
from pathlib import Path
import re
import sys

API_SHA = 'db182667ca565bdb18370dc1c209d129e6e139a0'
WEB_SHA = '5c7bf8c792050cb9ed9d69a4dd73c2062bc5f326'
NAMES = {'kalend-dev', 'kalend-api-dev', 'kalend-dev-release'}
GATES = (
    'cloudpanel_dependencies_accepted', 'effective_sudo_denied', 'filesystem_prod_denied',
    'all_uid_aliases_fenced', 'fence_live_and_persistent', 'firewall_manager_preserves_fence',
    'peer_roles_verified', 'old_sql_credentials_cannot_reach_tcp', 'runtime_credentials_dev_only',
    'github_actions_disabled_both_repos', 'webhooks_apps_and_external_ci_paused',
    'no_remote_runs_or_deploy_sessions', 'recovery_independent_verified',
    'worker_timer_in_window_manifest', 'maintenance_authorized', 'fresh_backup_restore_verified',
    'fresh_legacy_unambiguous', 'artifact_hashes_and_versions_verified',
)


def validate_gate(observed):
    if observed.get('database') != 'kalend_dev' or observed.get('api_sha') != API_SHA or observed.get('web_sha') != WEB_SHA:
        raise ValueError('TARGET_OR_VERSION_MISMATCH')
    missing = [g for g in GATES if observed.get(g) is not True]
    if missing:
        raise ValueError('BLOCKED:' + ','.join(missing))
    return True


def render_fence(accounts, subordinate_ranges):
    """Use fresh getent/subuid metadata. Root reviewer must approve the generated UID set."""
    if not NAMES <= set(accounts):
        raise ValueError('MISSING_DEV_IDENTITY')
    selected = [accounts[n] for n in sorted(NAMES)]
    if any(type(u) is not int or u <= 0 for u in selected) or len(set(selected)) != 3:
        raise ValueError('INVALID_UIDS')
    if any(accounts.get(n) != u for n, u in [('kalend-dev', 1021), ('kalend-api-dev', 1022)]):
        raise ValueError('DEV_UID_DRIFT')
    intervals = [(u, u) for u in selected]
    for name in NAMES:
        for start, count in subordinate_ranges.get(name, []):
            if type(start) is not int or type(count) is not int or start <= 0 or count <= 0:
                raise ValueError('INVALID_SUBUID_RANGE')
            intervals.append((start, start + count - 1))
    outsiders = {uid for name, uid in accounts.items() if name not in NAMES}
    if any(a <= u <= b for a, b in intervals for u in outsiders):
        raise ValueError('OTHER_ACCOUNT_UID_WOULD_BE_FENCED')
    for name, ranges in subordinate_ranges.items():
        if name not in NAMES:
            if any(max(a, start) <= min(b, start + count - 1) for a, b in intervals for start, count in ranges):
                raise ValueError('OTHER_ACCOUNT_SUBUID_OVERLAP')
    ordered = sorted(intervals)
    merged = []
    for a, b in ordered:
        if merged and a <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
        else:
            merged.append((a, b))
    values = ', '.join(str(a) if a == b else f'{a}-{b}' for a, b in merged)
    return ('table inet kalend_dev_release {\n'
            ' chain postgres_tcp_fence {\n'
            '  type filter hook output priority 10; policy accept;\n'
            f'  meta skuid {{ {values} }} tcp dport 5432 counter reject\n'
            ' }\n}\n')


def validate_activation(evidence):
    # SHAs are measured from promoted artifacts, not invented health endpoint fields.
    expected = {'api_http':200, 'web_http':200, 'api_sha':API_SHA, 'web_sha':WEB_SHA,
                'database':'kalend_dev', 'completed_migrations':19,
                'restart_loop':False, 'sql_role_verified':True, 'fence_live':True}
    if any(type(evidence.get(k)) is not type(v) or evidence.get(k)!=v for k,v in expected.items()):
        raise ValueError('ACTIVATION_NOT_ACCEPTED')
    before=evidence.get('prod_pids_before');after=evidence.get('prod_pids_after')
    if not isinstance(before,dict) or not before or before!=after:
        raise ValueError('PRODUCTION_PIDS_NOT_PRESERVED')
    return True


STEPS = ('publish_code', 'backup', 'classify', 'migrate', 'api', 'web', 'activate', 'homologate')


def simulate(observed, fail_at=None, rollback_proven=False):
    validate_gate(observed)
    if fail_at not in (None, *STEPS):
        raise ValueError('UNKNOWN_STEP')
    done = []
    schema = False
    for step in STEPS:
        if step == fail_at:
            return {'done': done, 'failed': step, 'schema_committed': schema,
                    'automatic_old_api_restart': False, 'automatic_database_restore': False,
                    'keep_maintenance': True,
                    'recovery': 'verify_schema_ledger_before_resolve' if step == 'migrate' else
                                'schema_compatible_forward_fix' if schema else 'abort_without_activation',
                    'rollback_claim_accepted': bool(rollback_proven and step == 'migrate')}
        done.append(step)
        if step == 'migrate':
            schema = True
    return {'done': done, 'schema_committed': True, 'ready_for_acceptance': True}


if __name__ == '__main__':
    # Read-only/offline: even fabricated inputs can never trigger deployment.
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--render-fence':
            inventory = json.loads(Path(sys.argv[2]).read_text())
            print(render_fence(inventory['accounts'], inventory['subordinate_ranges']), end='')
            sys.exit(0)
        if len(sys.argv) != 2:
            raise ValueError('OBSERVATION_FILE_REQUIRED')
        observed = json.loads(Path(sys.argv[1]).read_text())
        validate_gate(observed)
        print(json.dumps({'plan_only': True, 'steps': list(STEPS), 'no_commands_executed': True}))
    except (OSError, ValueError):
        sys.exit('RELEASE_BLOCKED_OR_INPUT_INVALID')
