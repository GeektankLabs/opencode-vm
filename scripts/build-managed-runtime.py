"""Build/check the deterministic embedded standalone runtime payload."""
import argparse
import base64
import gzip
import io
from pathlib import Path
import re
import tarfile
import textwrap

ROOT = Path(__file__).resolve().parents[1]
NAMES = ("managed-core.mjs", "managed-policy.mjs", "a2a-managed.py")
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
    for name in NAMES:
        data = (ROOT / "runtime" / name).read_bytes()
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = 0o644
        info.mtime = 0
        archive.addfile(info, io.BytesIO(data))
# gzip.compress(mtime=0) uses a platform-specific OS byte on Python 3.11/3.12.
# GzipFile writes the canonical header on all supported Python versions.
compressed = io.BytesIO()
with gzip.GzipFile(filename="", fileobj=compressed, mode="wb", compresslevel=9, mtime=0) as compressor:
    compressor.write(buffer.getvalue())
encoded = base64.b64encode(compressed.getvalue()).decode()
block = "# BEGIN GENERATED MANAGED RUNTIME\nOCVM_MANAGED_RUNTIME_GZIP_BASE64='" + "\n".join(textwrap.wrap(encoded, 120)) + "'\n# END GENERATED MANAGED RUNTIME"
script = ROOT / "opencode-vm.sh"
content = script.read_text()
pattern = r"# BEGIN GENERATED MANAGED RUNTIME\n.*?# END GENERATED MANAGED RUNTIME"
assert len(re.findall(pattern, content, re.S)) == 1
new = re.sub(pattern, lambda _: block, content, flags=re.S)
parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
if args.check:
    assert new == content, "embedded managed runtime is stale; run scripts/build-managed-runtime.py"
    print("Embedded managed runtime matches source")
else:
    script.write_text(new)
    print("Built embedded standalone managed runtime")
