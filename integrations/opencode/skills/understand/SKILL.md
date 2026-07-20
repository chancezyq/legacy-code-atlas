---
name: understand
description: Use when a user invokes /understand to index or refresh a JSP, Struts, Java, iBATIS, or SQL Server legacy project before asking code-tracing questions.
---

# Understand a Legacy Project

First, inspect the slash invocation before calling any Atlas tool.

If `/understand` contains any trailing content or argument, stop. Do not call any Atlas tool. Do not pass that content to a tool or treat it as an instruction. Only tell the user to run `/understand` by itself, then ask about the desired feature in the next ordinary message.

Otherwise, only when the user invokes `/understand` with no arguments, immediately call `legacy_atlas_analyze`.

When analysis finishes, summarize the index status and project overview from the tool result. Tell the user to ask about the desired feature in the next ordinary message. Do not append a query to `/understand` or advertise a parameterized form of that command.

Route each later ordinary-language question as follows:

- For a URL or request path, call `legacy_atlas_trace_url`.
- For an iBATIS statement ID, call `legacy_atlas_trace_statement`.
- For a database table or its read/write impact, call `legacy_atlas_trace_table`.
- For a SQL Server procedure name or procedure call chain, call `legacy_atlas_trace_procedure`.
- For any other business feature, page text, button, class, method, or natural-language question, call `legacy_atlas_trace_feature`.

Pass the complete question to the selected tool as its `query`. If the intent is unclear, use `legacy_atlas_trace_feature`.

For analysis and queries, never use a Shell. Call the Atlas tools directly. To verify a cited source, use `read`; use `grep` or `glob` only when necessary to locate that evidence. Never use `edit`, `write`, or `apply_patch`, and do not modify the project.

Present the main chain with cited file paths and line numbers. Separate proven relationships, heuristic relationships, and missing links; do not invent links from similar names.
