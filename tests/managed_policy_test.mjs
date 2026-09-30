import assert from "node:assert/strict";
import test from "node:test";
import { policyDelta, remoteWrite, questionInResponse, terminalResponse, handback } from "../runtime/managed-core.mjs";

test("policy composition is idempotent and preserves independent agent/session denies", () => {
  const scope = [{ permission: "read", pattern: "secret*", action: "deny" }, { permission: "bash", pattern: "git commit *", action: "deny" }];
  const first = policyDelta(scope, [{ permission: "edit", pattern: "*", action: "deny" }], scope);
  assert.deepEqual(policyDelta([...scope, ...first], [{ permission: "edit", pattern: "*", action: "deny" }], scope), []);
  assert.ok(first.some(r => r.permission === "edit" && r.action === "deny"));
  assert.ok(first.findLastIndex(r => r.pattern === "git commit *") > first.findIndex(r => r.pattern === "git *"));
  assert.ok(policyDelta([{ permission: "question", pattern: "*", action: "allow" }]).some(r => r.permission === "question" && r.action === "deny"));
});

test("publishing forms deny, local Git and ordinary reads remain allowed", () => {
  for (const command of ["git push", "git -C . push --dry-run", "git -c user.name=x send-pack remote", "/usr/bin/git push", "env git push", "git status\ngit push", "g\\\nit push", "git -c 'alias.publish=push --force' publish", "git-lfs upload", "git lfs pre-push", "/usr/lib/git-core/git-http-push remote", "sh -c 'git push remote'", "gh release create v1"])
    assert.equal(remoteWrite(command), true, command);
  assert.equal(remoteWrite("git publish", { publish: "push" }), true);
  assert.equal(remoteWrite("git publish", { publish: "!git send-pack remote" }), true);
  for (const command of ["git status", "git diff", "git log", "git add file", "git restore file", "git switch -c branch", "git tag local", "git commit -m 'git push is operator-only'", "git fetch local", "git ls-remote local", "curl https://example.invalid"])
    assert.equal(remoteWrite(command), false, command);
});

test("split question arguments are converted into a concrete bounded handback", () => {
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "question", arguments: '{"questions":[{"question":"Choose?","options":[' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"label":"A","description":"Local"}]}]}' } }] } }] },
  ];
  const report = questionInResponse(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(""), "chat").report;
  assert.match(report, /INPUT_REQUIRED:[\s\S]*Choose\?[\s\S]*A: Local/);
  assert.equal(questionInResponse('data: {"choices":[{"delta":{"content":"ordinary text"}}]}\n\n', "chat"), undefined);
});

test("all supported terminal protocols contain ordinary text and a terminal reason", async () => {
  for (const kind of ["chat", "responses", "anthropic", "google"]) {
    const response = terminalResponse(handback([{ question: "Decision?", options: [] }]), kind);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /INPUT_REQUIRED/);
    assert.match(text, /stop|completed|end_turn|STOP/);
    assert.doesNotMatch(text, /"type":"function_call"|"type":"tool_use"/);
  }
});
