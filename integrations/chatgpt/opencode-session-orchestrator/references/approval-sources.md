# Approval documentation notes

Documentation snapshot: 2026-09-27. This is not an MCP server version or a promise about every account's UI. Recheck official sources when giving live configuration advice.

## Sources and supported facts

**S1 — ChatGPT Developer mode**
https://developers.openai.com/api/docs/guides/developer-mode
Section: Reviewing and confirming tool calls. Describes write confirmation defaults, readOnlyHint, remembered choice per tool/conversation and prompting again after a conversation refresh or a new conversation. Also documents MCP initialize instructions for cross-tool guidance. Do not extrapolate to every published app surface.

**S2 — Admin controls, security, and compliance for plugins and apps**
https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-for-plugins-and-apps
Sections: App action controls; workspace default and individual app Permissions. Distinguishes allowed actions from when approval is requested. Lists app-specific Allow all actions when supported; the standard workspace-wide selector does not offer it. Workspace, provider and safety restrictions remain.

**S3 — Managing app permissions in ChatGPT**
https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt
The r3 source review had official indexed text, including localized official copies; direct full-page retrieval failed in that review. It distinguishes eligible personal-account persistent Always allow from managed-workspace prompts. Use S2 as the primary source for owner/admin instructions. Do not claim a complete live settings inspection from this note.

**S4 — Define tools**
https://developers.openai.com/plugins/plan/tools
Annotations must match actual behavior; bounded private resources differ from open-ended internet access. Hints do not replace authorization or validation.

**S5 — Submit plugins**
https://developers.openai.com/plugins/deploy/submission
Section: Tool annotations. Tools which enqueue, run jobs or start workflows are not read-only. Describe side effects accurately. An available rollback is not a blanket exception to destructive/overwrite classification.

**S6 — Connect and test your plugin**
https://developers.openai.com/plugins/deploy/connect-chatgpt
Section: Refresh metadata. Developer-mode connections use Refresh after changes; retest in a new conversation. Published MCP tool definitions follow continuous review/tool-update checks; changes to submitted plugin information or imported skills use the applicable version/review/publication flow. Do not confuse connector-metadata refresh with reloading a conversation page.

**S7 — MCP servers, Responses API**
https://developers.openai.com/api/docs/guides/tools-connectors-mcp
require_approval configures an API client request. It is not a ChatGPT skill setting and not an argument to an arbitrary MCP send tool.

**S8 — Plugins reference**
https://developers.openai.com/plugins/reference
Sections: Tool annotations and component bridge. Annotations influence presentation; servers enforce authorization. When a component exists, approval-gated input may be null before approval and arrive through the documented notification. This is not a general assistant-visible approval-status API.

**S9 — Connecting and managing app accounts in ChatGPT**
https://help.openai.com/en/articles/20001494-connecting-and-managing-app-accounts-in-chatgpt
Shows Settings > Plugins and connected-account review; provider authorization does not override workspace restrictions. UI labels and availability vary.

**S10 — Developer mode and MCP apps**
https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
Documents custom-app scanning, draft/published distinctions and Business publication limitations. Do not equate legacy custom-app management with the published-plugin flow in S6.

## Installation and voice references

**Skills in ChatGPT**
https://help.openai.com/en/articles/20001066-skills-in-chatgpt
Documents the Skills management page, Create > Upload from your computer, scan/review outcomes and account/workspace availability. Uploading in the Skills UI is distinct from attaching a ZIP to an ordinary conversation.

**Secure MCP Tunnel**
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
Documents private MCP transport, Platform/workspace association, tunnel permissions and selecting a tunnel for a developer-mode connection. Installing a skill does not create or authorize that connection.

**ChatGPT Voice**
https://help.openai.com/en/articles/20001274/
Distinguishes Voice in Chat from Voice in Work/Codex and surface-dependent tools. The documentation describes Live limitations for connected apps/plugins. Do not promise that installing this skill exposes MCP in an unsupported voice surface.

## Recommendations, not platform guarantees

One actual invocation for an authorized task, exact receipt verification, no redundant verbal approval and no blind retry are workflow choices in this skill. Idempotent submission and receipt lookup are usable only when exposed by the actual contract.

No source here establishes that failed calls are required to display an approval card, that a skill can disable host risk assessment, or that a server can set conversation approval state. Do not promise zero prompts or universal Voice support.
