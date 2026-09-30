// Compatibility spike only. This is NOT a complete remote-write security boundary.
export const MARKER = "ocvmAgentManagedSpike";
export const PRIMER = `This session is agent-managed (isolated compatibility spike).
Within authorized development, ordinary local Git work and local commits are already authorized; no separate commit confirmation is required. Explicit read-only or narrower task scope remains binding.
Do not use native questions. If a business decision is missing, stop the dependent work and return a terminal INPUT_REQUIRED report with decision, context, safe_options, completed and paused. An ordinary follow-up in this same session supplies the answer.
Remote writes are operator-only. The spike guards only recognized direct Git writes; it does not establish a complete transport boundary. Do not obtain credentials, circumvent denials, publish, release or tag.`;

export const SHELL_COMMIT_RULE = "Only commit, amend, push, or create PRs when explicitly requested.";
export const CONDITIONAL_COMMIT_RULE = "In an agent-managed session, authorized development includes ordinary local commits without separate confirmation; narrower task scope still applies. Outside that mode, only commit when explicitly requested. Only amend or create PRs when explicitly requested. Remote writes remain operator-only.";

export function sessionRules(previous = []) {
  // Preserve explicit session denies, including deny-by-default/read-only scope.
  // Agent-deny reconciliation is deliberately an integration gate, not implied here.
  return [
    ...previous,
    { permission: "bash", pattern: "git commit", action: "allow" },
    { permission: "bash", pattern: "git commit *", action: "allow" },
    ...previous.filter((rule) => rule.action === "deny"),
    { permission: "question", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "git push", action: "deny" },
    { permission: "bash", pattern: "git push *", action: "deny" },
  ];
}

export function recognizedDirectWrite(command) {
  // Deliberately bounded lexical probe: not a shell/Git parser, alias resolver,
  // subprocess monitor, hook guard, or generic HTTP/SSH/MCP capability mediator.
  return /(?:^|[\s;&|()])(?:[^\s;&|()]*\/)?git-(?:send-pack|http-push)(?:\s|$)/.test(command)
    || /(?:^|[\s;&|()])(?:[^\s;&|()]*\/)?git\s+(?:(?:-C|-c|--git-dir|--work-tree|--exec-path)\s+\S+\s+|--(?:git-dir|work-tree|exec-path)=\S+\s+)*(?:push|send-pack|http-push|lfs\s+push)(?:\s|$)/.test(command);
}
