"""Real guest resolver/install/registry/handover entries in isolated fixtures.
VM lifecycle is not simulated as physical acceptance. No live services touched.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'runtime/guest-state.py'
TASK = 'task_11111111-1111-4111-8111-111111111111'


class GuestStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ocvm-phase2-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / 'project ä space'
        self.project.mkdir()
        self.artifacts = self.base / 'artifacts'
        self.env = {k: v for k, v in os.environ.items() if k not in
                    {'OCVM_PROJECT_PATH', 'OCVM_PROJ_HASH', 'OCVM_MONITOR_STATE_DIR'}}
        self.env.update(OCVM_ARTIFACT_ROOT=str(self.artifacts), OCVM_GUEST_STATE_HELPER=str(HELPER),
                        PYTHONDONTWRITEBYTECODE='1', PYTHONPATH=str(ROOT),
                        OCVM_INTERNAL_SOURCE_ONLY='1', OCVM_DISABLE_UPDATE_CHECK='1')

    def command(self, args, env=None, ok=True, **kw):
        r = subprocess.run(args, env=env or self.env, capture_output=True, text=True, timeout=90, **kw)
        if ok:
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        else:
            self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    def state(self, create=False, env=None):
        return self.command(['python3', str(HELPER), 'resolve', str(self.project), 'monitor']
                            + (['--create'] if create else []), env=env).stdout.strip()

    def node(self, code, env=None):
        return self.command(['node', '--input-type=module', '-e', code], env=env, cwd=ROOT / 'adapters/mcp')

    def seed(self):
        self.node(f'''import {{defaultMonitorRecord,withRegistry}} from './dist/monitor.js';
          await withRegistry({json.dumps(str(self.project))}, r=>{{
            const m=defaultMonitorRecord('fixture',{json.dumps(TASK)},{{}}, Date.now());
            m.session.session_id='old-session'; m.history.push({{at:new Date().toISOString(),type:'evidence'}});
            r.monitors.push(m);
          }});''')

    def test_identity_parallel_checkouts_and_keep_state(self):
        path = Path(self.state(True))
        self.assertEqual(path, self.artifacts / hashlib.md5(str(self.project).encode()).hexdigest() / 'monitor')
        (path / 'checkpoint.txt').write_text('retained')
        self.assertEqual(self.state(True), str(path))
        self.assertEqual((path / 'checkpoint.txt').read_text(), 'retained')
        other = self.base / 'other-checkout'
        other.mkdir()
        value = self.command(['python3', str(HELPER), 'resolve', str(other), 'monitor', '--create']).stdout.strip()
        self.assertNotEqual(value, str(path))

    def test_host_mount_override_and_symlink_ancestors_refused(self):
        env = {**self.env, 'OCVM_ARTIFACT_ROOT': str(ROOT / '.opencode-vm/guest-should-not-exist')}
        self.command(['python3', str(HELPER), 'resolve', str(self.project), 'monitor', '--create'], env, ok=False)
        victim = self.base / 'victim'
        victim.mkdir()
        marker = victim / 'foreign-marker'
        marker.write_text('keep')
        self.artifacts.symlink_to(victim)
        self.command(['python3', str(HELPER), 'resolve', str(self.project), 'monitor', '--create'], ok=False)
        self.assertEqual(marker.read_text(), 'keep')

    def test_foreign_existing_monitor_directory_retained(self):
        path = self.artifacts / hashlib.md5(str(self.project).encode()).hexdigest() / 'monitor'
        path.mkdir(parents=True)
        # Test fixture dirs are made private, never adjust any product path.
        for p in (self.artifacts, path.parent, path): p.chmod(0o700)
        (path / 'foreign.json').write_text('{"monitors": []}')
        self.command(['python3', str(HELPER), 'resolve', str(self.project), 'monitor', '--create'], ok=False)
        self.assertTrue((path / 'foreign.json').exists())

    def test_all_registry_consumers_reject_host_override_and_parent_links(self):
        marker = self.base / 'foreign-marker'
        marker.write_text('keep')
        self.artifacts.symlink_to(ROOT)  # actual fuse-mounted checkout
        js = f'''import {{withRegistry}} from './dist/monitor.js';
          await withRegistry({json.dumps(str(self.project))},()=>{{}});'''
        self.command(['node', '--input-type=module', '-e', js], ok=False, cwd=ROOT / 'adapters/mcp')
        self.command(['python3', '-B', '-c', f'''
from pathlib import Path
from hub.monitor import mutate
mutate(Path({str(self.project)!r}), lambda r: None)
'''], ok=False)
        self.assertEqual(marker.read_text(), 'keep')
        self.assertTrue(self.artifacts.is_symlink())

    def test_foreign_vm_identity_is_not_retained_binding_evidence(self):
        self.seed()
        state = Path(self.state())
        marker = state / '.ocvm-owner.json'
        data = json.loads(marker.read_text())
        data['guest_id'] = 'lost-other-vm'
        marker.write_text(json.dumps(data))
        self.command(['python3', str(HELPER), 'resolve', str(self.project), 'monitor', '--create'], ok=False)
        self.assertIn('old-session', (state / 'registry.json').read_text())  # preserved, not imported

    def test_ts_and_hub_read_write_the_same_registry_and_workers(self):
        self.seed()
        path = self.state()
        py = self.command(['python3', '-B', '-c', f'''
from pathlib import Path
from hub.monitor import snapshot,mutate,registry_directory
p=Path({str(self.project)!r})
assert len(snapshot(p)['monitors']) == 1
mutate(p, lambda r: r['monitors'][0].update(title='hub-write'))
print(registry_directory(p))
'''])
        self.assertEqual(py.stdout.strip(), path)
        self.node(f'''import {{readRegistrySnapshot,monitorWorkersDirectory}} from './dist/monitor.js';
          const p={json.dumps(str(self.project))}; const r=await readRegistrySnapshot(p);
          if(r.registry.monitors[0].title!=='hub-write') throw Error('split registry');
          if(!monitorWorkersDirectory(p).startsWith({json.dumps(path)})) throw Error('host workers');''')

    def test_new_guest_root_ignores_old_host_registry(self):
        self.seed()
        old = self.project / '.opencode-vm/monitor'
        old.mkdir(parents=True)
        marker = old / 'registry.json'
        marker.write_text('{"monitors": [{"state":{"work":"active"}}]}')
        fresh_env = {**self.env, 'OCVM_ARTIFACT_ROOT': str(self.base / 'fresh-guest')}
        self.node(f'''import {{readRegistrySnapshot}} from './dist/monitor.js';
          const r=await readRegistrySnapshot({json.dumps(str(self.project))});
          if(r.registry.monitors.length) throw Error('old registry adopted');''', fresh_env)
        self.assertTrue(marker.exists())

    def test_dependencies_install_on_guest_and_resolve_local_plugin(self):
        local = self.base / 'local'
        local.mkdir()
        (local / 'package.json').write_text('{"name":"local-fixture","version":"1.0.0","main":"index.js"}')
        (local / 'index.js').write_text('module.exports = 42')
        package = self.base / 'config'
        package.mkdir()
        (package / 'package.json').write_text('{"name":"fixture","dependencies":{"local-fixture":"file:../local"}}')
        def install():
            return self.command(['python3', str(HELPER), 'dependencies', str(self.project), 'oc-config', str(package), 'config']).stdout.strip()
        destination = install()
        self.assertTrue((package / 'node_modules').is_symlink())
        self.assertTrue(destination.startswith(str(self.artifacts)))
        self.command(['node', '-e', 'if(require(process.argv[1])!==42)process.exit(1)', str(package / 'node_modules/local-fixture')])
        self.assertEqual(install(), destination)  # idempotent; original manifests untouched
        self.assertIn('file:../local', (package / 'package.json').read_text())
        self.assertFalse((package / 'package-lock.json').exists())
        previous = Path(destination)
        (previous / 'retained-marker').write_text('keep')
        cfg = json.loads((package / 'package.json').read_text())
        cfg['version'] = '2.0.0'
        (package / 'package.json').write_text(json.dumps(cfg))
        new = install()
        self.assertNotEqual(new, destination)
        self.assertEqual((previous / 'retained-marker').read_text(), 'keep')

    def test_foreign_node_modules_never_removed(self):
        package = self.base / 'config'
        package.mkdir()
        (package / 'package.json').write_text('{"name":"fixture"}')
        nm = package / 'node_modules'
        nm.mkdir()
        (nm / 'foreign-marker').write_text('keep')
        self.command(['python3', str(HELPER), 'dependencies', str(self.project), 'oc-config', str(package), 'config'], ok=False)
        self.assertEqual((nm / 'foreign-marker').read_text(), 'keep')

    def test_handover_real_cli_pack_preview_no_yes_duplicates(self):
        self.seed()
        cli = ROOT / 'adapters/mcp/dist/monitor-handover-main.js'
        file = self.project / '.opencode-vm/handover/monitor-restart.json'
        self.command(['node', str(cli), 'pack', str(self.project), str(file)])
        value = json.loads(file.read_text())
        self.assertEqual(set(value['monitors'][0]), {'reference_id','title','task_id','interval_seconds',
                          'autonomy_profile','runtime_profile','expiry_at','investigation_config'})
        self.assertNotIn('old-session', file.read_text())
        env = {**self.env, 'OCVM_ARTIFACT_ROOT': str(self.base / 'new-guest')}
        preview = self.command(['node', str(cli), 'unpack', str(self.project), str(file)], env)
        self.assertTrue(json.loads(preview.stdout)['decision_required'])
        self.assertFalse((self.base / 'new-guest').exists())
        no = self.command(['node', str(cli), 'unpack', str(self.project), str(file), '--no'], env)
        self.assertEqual(json.loads(no.stdout)['created'], [])
        self.assertFalse((self.base / 'new-guest').exists())
        yes = json.loads(self.command(['node', str(cli), 'unpack', str(self.project), str(file), '--yes'], env).stdout)
        self.assertEqual(len(yes['created']), 1)
        self.assertNotEqual(yes['created'][0], value['monitors'][0]['reference_id'])
        again = json.loads(self.command(['node', str(cli), 'unpack', str(self.project), str(file), '--yes'], env).stdout)
        self.assertEqual(again['created'], [])
        self.assertEqual(again['retained'], [TASK])

    def test_handover_foreign_receipt_and_unowned_pairs_retained(self):
        self.seed()
        cli = ROOT / 'adapters/mcp/dist/monitor-handover-main.js'
        file = self.project / '.opencode-vm/handover/monitor-restart.json'
        self.command(['node', str(cli), 'pack', str(self.project), str(file)])
        value = json.loads(file.read_text())
        registry = Path(self.state(True)) / 'registry.json'
        before = registry.read_bytes()
        receipt = Path(str(file) + '.decision.json')
        # A foreign decision receipt is refused BEFORE any registry write.
        receipt.write_text('{"schema": 1, "decision": "maybe"}\n')
        self.command(['node', str(cli), 'unpack', str(self.project), str(file), '--yes'], ok=False)
        self.assertEqual(receipt.read_text(), '{"schema": 1, "decision": "maybe"}\n')
        self.assertEqual(registry.read_bytes(), before, 'refused unpack must not touch the registry')
        receipt.unlink()
        # A consistent foreign-project pair is retained, never overwritten by pack.
        foreign = json.loads(file.read_text())
        foreign['project'] = '/foreign/project'
        foreign_text = json.dumps(foreign, indent=2) + '\n'
        file.write_text(foreign_text)
        manifest = Path(str(file) + '.manifest.json')
        manifest.write_text(json.dumps({'schema': 1, 'files': [{'path': str(file),
            'sha256': hashlib.sha256(foreign_text.encode()).hexdigest()}]}) + '\n')
        self.command(['node', str(cli), 'pack', str(self.project), str(file)], ok=False)
        self.assertEqual(file.read_text(), foreign_text)
        # An owned description without its manifest is an inconsistent pair.
        owned_text = json.dumps(value, indent=2) + '\n'
        file.write_text(owned_text)
        manifest.unlink()
        self.command(['node', str(cli), 'pack', str(self.project), str(file)], ok=False)
        self.assertEqual(file.read_text(), owned_text)
        self.assertFalse(manifest.exists())

    def test_materialized_web_entry_passes_state_across_systemd_boundary(self):
        share = self.base / 'share'
        adapter = share / 'dashboard/adapter'
        (adapter / 'dist').mkdir(parents=True)
        (adapter / '.ocvm-managed').write_text('opencode-vm-mcp-staging-v1\n')
        (adapter / 'dist/monitor-main.js').write_text('// fixture')
        capture = self.base / 'systemd-args'
        script = f'''
set -euo pipefail
source "{ROOT}/opencode-vm.sh"
OC_PORT=4001
eval "$OCVM_WEB_LIB_SH"
OC_MODE=web; SESS_SHARE="{share}"; PROJ_DIR="{self.project}"; OC_HUB_GENERATION=g
OC_OPENLIVE_PROJECT_HASH="{hashlib.md5(str(self.project).encode()).hexdigest()}"
OC_PORT_INTERNAL=4000; OC_PORT=4001
managed_policy_install "$SESS_SHARE"
init_guest_state
stop_monitor() {{ :; }}
load_session_auth() {{ :; }}
opencode() {{ printf fixture; }}
sudo() {{ printf '%s\\0' "$@" > "{capture}"; }}
monitor_wait_heartbeat() {{ return 0; }}
start_monitor
'''
        self.command(['bash', '-c', script], cwd=self.project)
        args = capture.read_bytes().split(b'\0')
        state = self.state()
        self.assertIn(f'--setenv=OCVM_MONITOR_STATE_DIR={state}'.encode(), args)
        self.assertIn(f'--setenv=OCVM_PROJECT_PATH={self.project}'.encode(), args)
        self.assertIn(f'{state}/run/runtime-input.json'.encode(), args)


if __name__ == '__main__':
    unittest.main()
