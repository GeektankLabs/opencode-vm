import assert from "node:assert/strict";
import test from "node:test";
import { policyDelta, remoteWrite, questionInResponse, terminalResponse, handback, permissionBlocker, matchesGlob, scopeAllowRules, authorizedFor, mergeScopeDirs } from "../runtime/managed-core.mjs";

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

// OpenCode 1.19.0 agent defaults carry external_directory "*": "ask". Copying
// agent rules into session rules would leak that interactive ask into
// deriveSubagentSessionPermission while the child drops the generic "*" allow.
test("agent-rule copies drop only the default external_directory ask; explicit user rules survive", () => {
  const agentRules = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "/tmp/opencode/*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
  ];
  const userRules = [{ permission: "external_directory", pattern: "/data/keep/*", action: "ask" }];
  const delta = policyDelta([], agentRules, userRules);
  assert.ok(!delta.some(r => r.permission === "external_directory" && r.pattern === "*" && r.action === "ask"), "default external ask must not be copied into session rules");
  assert.ok(!delta.some(r => r.permission === "*" && r.pattern === "*" && r.action === "allow"), "generic blanket allow must not become a session-level rule that overrides remaining agent asks");
  assert.ok(delta.some(r => r.permission === "external_directory" && r.pattern === "/tmp/opencode/*" && r.action === "allow"));
  assert.ok(delta.some(r => r.permission === "external_directory" && r.pattern === "/data/keep/*" && r.action === "ask"), "explicit user external ask survives");
  assert.ok(delta.some(r => r.permission === "doom_loop" && r.action === "ask"), "non-external asks stay untouched");
  assert.deepEqual(policyDelta(delta, agentRules, userRules), [], "composition stays idempotent");
});

test("authorized scope allows are emitted unless an explicit deny wins", () => {
  const none = [];
  const denied = [{ permission: "external_directory", pattern: "/srv/*", action: "deny" }];
  const wildcardDenied = [{ permission: "*", pattern: "*", action: "deny" }];
  assert.deepEqual(scopeAllowRules(none, none, ["/srv/data"]), [{ permission: "external_directory", pattern: "/srv/data/*", action: "allow" }]);
  assert.deepEqual(scopeAllowRules(denied, none, ["/srv/data", "/srv/other"]), [], "deny beats the authorized allow");
  assert.deepEqual(scopeAllowRules(none, wildcardDenied, ["/srv/data"]), [], "wildcard deny beats the authorized allow");
  assert.deepEqual(scopeAllowRules(none, none, []), []);
  const delta = policyDelta([], none, none, ["/srv/data"]);
  assert.ok(delta.some(r => r.permission === "external_directory" && r.pattern === "/srv/data/*" && r.action === "allow"));
});

test("glob matcher mirrors OpenCode wildcard semantics", () => {
  assert.equal(matchesGlob("external_directory", "*"), true);
  assert.equal(matchesGlob("/Users/admin/Documents/github/*", "*"), true);
  assert.equal(matchesGlob("/Users/admin/Documents/github/bi-archive/*", "/Users/admin/Documents/github/*"), true);
  assert.equal(matchesGlob("/Users/admin/Documents/github2/x", "/Users/admin/Documents/github/*"), false);
  assert.equal(matchesGlob("ls", "ls *"), true);
  assert.equal(matchesGlob("ls -la", "ls *"), true);
  assert.equal(matchesGlob("lsa", "ls *"), false);
  assert.equal(matchesGlob("a.b/c", "a*b/c"), true);
});

test("permission blocker is a bounded terminal INPUT_REQUIRED report", () => {
  const report = permissionBlocker({ patterns: ["/Users/admin/Documents/github/bi-archive/*"] });
  assert.match(report, /INPUT_REQUIRED:/);
  assert.match(report, /bi-archive/);
  assert.match(report, /not approved automatically/);
  const response = terminalResponse(report, "chat");
  return response.text().then(text => {
    assert.match(text, /finish_reason":"stop/);
    assert.doesNotMatch(text, /tool_calls/);
  });
});

// F2-a regression: a pattern-less (or unknown-pattern) external ask is never
// authorized — it must end in the terminal blocker, not a hidden wait.
test("authorized scope never authorizes empty or uncovered ask patterns", () => {
  const dirs = ["/srv/data"];
  assert.equal(authorizedFor(dirs, ["/srv/data/*"]), true);
  assert.equal(authorizedFor(dirs, ["/srv/data"]), true);
  assert.equal(authorizedFor(dirs, []), false, "empty patterns must fail closed");
  assert.equal(authorizedFor(dirs, undefined), false);
  assert.equal(authorizedFor(dirs, ["/srv/other/*"]), false);
  assert.equal(authorizedFor([], ["/srv/data/*"]), false);
  assert.equal(authorizedFor(undefined, []), false);
});

// F1-a regression: merging scope directories is atomic — an over-limit union
// is rejected, never silently truncated to a partial operator declaration.
test("scope directory merges are atomic and never silently truncated", () => {
  assert.deepEqual(mergeScopeDirs([], ["/a", "/a"]), ["/a"]);
  assert.deepEqual(mergeScopeDirs(["/a"], ["/a", "/b"]), ["/a", "/b"]);
  const sixteen = Array.from({ length: 16 }, (_, i) => `/d/${i}`);
  assert.deepEqual(mergeScopeDirs(sixteen, ["/d/0"]), sixteen);
  assert.throws(() => mergeScopeDirs(sixteen, ["/new"]), /MANAGED_SCOPE_LIMIT/);
  assert.throws(() => mergeScopeDirs([], Array.from({ length: 17 }, (_, i) => `/d/${i}`)), /MANAGED_SCOPE_LIMIT/);
});
