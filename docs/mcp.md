# Calink MCP

Calink exposes a Streamable HTTP MCP endpoint for calendar automation:

```json
{
  "mcpServers": {
    "calink": {
      "url": "https://<deployment>.convex.site/mcp",
      "headers": {
        "Authorization": "Bearer <token shown once by createMcpKey>"
      }
    }
  }
}
```

Supported tools:

- `list_calendars`
- `create_calendar`
- `get_feed_url`
- `list_events`
- `create_event`
- `update_event`
- `delete_event`
- `undo`
