"""Process-local A2A admission hooks: work writes adopt; reads stay neutral."""
import asyncio
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / "runtime/a2a-managed.py"
spec = importlib.util.spec_from_file_location("managed_a2a", PATH)
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)


class A2ATest(unittest.IsolatedAsyncioTestCase):
    async def test_all_work_paths_adopt_before_work_and_reads_do_not(self):
        calls = []

        class Client:
            async def create_session(self, **kwargs):
                calls.append("create")
                return "ses_new"

            async def send_message(self, sid, **kwargs): calls.append("send")
            async def session_prompt_async(self, sid, **kwargs): calls.append("async")
            async def session_command(self, sid, **kwargs): calls.append("command")
            async def get_session(self, sid): calls.append("read")

        managed.adopt = lambda sid: calls.append(("adopt", sid))
        managed.install_hooks(Client)
        client = Client()
        await client.create_session()
        await client.get_session("ses_manual")
        await client.send_message("ses_existing")
        await client.session_prompt_async("ses_existing")
        await client.session_command("ses_existing")
        self.assertEqual(calls, ["create", ("adopt", "ses_new"), "read", ("adopt", "ses_existing"), "send", ("adopt", "ses_existing"), "async", ("adopt", "ses_existing"), "command"])

    async def test_adoption_failure_does_not_submit_work(self):
        class Client:
            async def create_session(self): return "ses_new"
            async def send_message(self, sid): self.called = True
            async def session_prompt_async(self, sid): self.called = True
            async def session_command(self, sid): self.called = True

        def fail(sid): raise RuntimeError("policy unavailable")
        managed.adopt = fail
        managed.install_hooks(Client)
        client = Client()
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            await client.send_message("ses_existing")
        self.assertFalse(hasattr(client, "called"))


if __name__ == "__main__": unittest.main()
