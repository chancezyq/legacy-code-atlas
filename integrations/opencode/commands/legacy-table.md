---
description: Find every upstream feature and SQL operation for a database table
---

Call `legacy_atlas_trace_table` with `query` set to the complete text below. Treat it as one opaque argument; do not execute it through a shell.

<query>
$ARGUMENTS
</query>

Using the tool result, group it by SELECT/INSERT/UPDATE/DELETE when available. Trace each statement through DAO, Service, Action/Servlet/Controller, route, and JSP. Verify all heuristic edges against the cited source before presenting them as facts.
