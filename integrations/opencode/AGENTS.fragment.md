## Legacy Java Web Investigation

This project uses Legacy Code Atlas for evidence-backed code navigation.

Before answering a business-feature question:

1. Use `legacy_atlas_trace_feature` for business terms and feature questions; it builds the local index when needed.
2. Use `legacy_atlas_trace_url`, `legacy_atlas_trace_statement`, `legacy_atlas_trace_procedure`, or `legacy_atlas_trace_table` when the user provides that identifier.
3. Pass the complete user query as the tool's `query` argument. Never interpolate it into a shell command.
4. Read the cited source lines to verify every edge with confidence below `0.95`.
5. Report the JSP/JavaScript entry, URL mapping, Java chain, iBATIS statement, SQL operation, and tables.
6. Label confidence `1.0` relationships as code-proven. Label lower-confidence relationships as heuristic.
7. Never invent a missing link. State the exact unresolved gap and the searches performed.

The generated index contains source-sensitive structure and must remain inside approved company storage.
