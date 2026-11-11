# Verdict Gate as an MCP server

`mcp/verdict_gate_mcp.py` exposes the verifiers to any agent that speaks the Model Context Protocol (stdio transport, JSON-RPC 2.0). Standard library only.

Tools: `verify_flaky`, `verify_upgrade`, `verify_i18n`, `verify_perf`, `verify_api`, `bisect_flaky`, `check_verdict`, `get_policy`, `demo`. Every verify tool returns the verdict-gate/1 object the verifier printed. The server never alters an outcome.

## GitLab Duo Agent Platform (MCP client)

In the Duo Agent Platform MCP client configuration add:

```json
{
  "mcpServers": {
    "verdict-gate": {
      "command": "python3",
      "args": ["mcp/verdict_gate_mcp.py"]
    }
  }
}
```

An agent can then say: *"Run verify_flaky on this MR for test X and post the verdict"*. See `.gitlab/duo/flows/verdict-gate.yaml` for the flow that does this on pipeline events.

## Other MCP clients

`.mcp.json` at the repository root is a project-level MCP configuration file that some clients read automatically. Other clients take the same command and args.

## Try it without a client

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"demo","arguments":{"verifier":"i18n"}}}' \
  | python3 mcp/verdict_gate_mcp.py
```
