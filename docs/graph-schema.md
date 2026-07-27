# Graph Schema

The index is a JSON object with `schemaVersion`, `project`, `summary`, `nodes`, `edges`, and `warnings`. The machine-readable JSON Schema is [`graph.schema.json`](graph.schema.json).

## Node Types

| Type | Identity | Meaning |
|---|---|---|
| `file` | project-relative path | Scanned source/config file |
| `page` | JSP path | User-visible JSP page or configured forward |
| `route` | normalized URL | Servlet/Struts/Spring/request URL |
| `java_type` | fully-qualified name | Java class, interface, or enum |
| `java_method` | owner, name, arity; same-arity overloads add parameter signature | Java method declaration |
| `spring_bean` | bean ID | Spring XML bean |
| `statement` | namespace plus ID | iBATIS statement |
| `procedure` | normalized qualified name | SQL Server stored procedure |
| `tiles_definition` | Tiles definition name | Tiles page composition definition |
| `table` | normalized qualified name | Database table |

## Edge Types

| Type | Typical direction |
|---|---|
| `contains` | file → contained node |
| `submits_to` | JSP page → form URL |
| `links_to` | JSP page → linked URL |
| `requests` | JSP/JS file → Ajax URL |
| `includes` | JSP page → included JSP page |
| `loads_script` | JSP page → external JavaScript file |
| `maps_to` | configured route → Java type |
| `dispatches_to` | configured route → selected Java entry method |
| `forwards_to` | Struts route → JSP page |
| `redirects_to` | Struts 2 route → Struts 2 route |
| `uses_tile` | Struts route → Tiles definition |
| `declares` | Java type → Java method |
| `implements` | implementation type → interface |
| `implemented_by` | interface type/method → implementation |
| `calls` | Java method → Java method, or procedure → procedure |
| `uses_statement` | DAO method → iBATIS statement |
| `calls_procedure` | iBATIS procedure statement → SQL Server procedure |
| `extends_tile` | Tiles definition → parent Tiles definition |
| `uses_template` | Tiles definition → template JSP |
| `puts` | Tiles definition → JSP put value |
| `reads_from` | statement/procedure → table |
| `writes_to` | statement/procedure → table |

SQL Server procedures also use `calls` for nested `EXEC` calls. Procedure nodes retain normalized parameters, body text, read/write table names, and referenced procedure names in `data`; all relationships cite the source procedure or mapping lines.

Each edge contains `confidence`, `reason`, and zero or more evidence objects. Evidence contains `file`, `line`, `column`, and `snippet`. Node and edge arrays are sorted so repeated analysis of unchanged source produces stable JSON.

## Route Request Hints

Route nodes may carry a `requestHints` array inside `node.data`. Each hint is scoped by its `evidence` location to one extracted form, link, or script request:

```json
{
  "method": "POST",
  "dispatchMethod": "save",
  "parameters": {
    "orderId": "",
    "mode": "save"
  },
  "parametersComplete": false,
  "hasDynamicParameterNames": true,
  "evidence": {
    "file": "web/order.jsp",
    "line": 12,
    "column": 3,
    "snippet": "<form action=\"/order.do\" method=\"post\">"
  }
}
```

- `method` is the statically resolved HTTP method, or an empty string when it is unresolved.
- `dispatchMethod` is the static Struts 2 method suffix extracted from an `action!method` request. It is omitted for ordinary requests. Multiple evidence-scoped method hints remain separate so consumers do not collapse ambiguous dynamic dispatch into one proven entry.
- `parameters` contains only statically resolved parameter names. A value is included only when it is a proven static default; an empty string means no static default was established.
- `parametersComplete=true` means the extracted parameter-name set is complete for that request. `false` means the map is partial and consumers must not infer that omitted parameter names are absent. A missing property preserves the legacy, unspecified completeness semantics.
- `hasDynamicParameterNames=true` identifies runtime-derived form-control or query parameter names as one reason the parameter map is incomplete. It is emitted only when true; a missing property is not independent proof that every name is static.
- `evidence` identifies the source request. Consumers should use it to keep hints from different forms or requests on the same page separate.

These optional fields refine existing route data and do not change `schemaVersion`.

## Struts Outcome Metadata

Configuration-derived Struts `forwards_to`, `redirects_to`, and `uses_tile` edges carry an `outcome` object inside `edge.data`:

```json
{
  "outcome": {
    "framework": "struts1",
    "name": "success",
    "classification": "configured-candidate",
    "codeEvidence": []
  }
}
```

- `framework` is `struts1` or `struts2`.
- `name` is the configured forward/result name.
- `classification` is `configured-candidate` or `code-confirmed`.
- `codeEvidence` contains the direct Java return locations supporting `code-confirmed`; configuration evidence remains in the edge's normal `evidence` array.

Every configured result starts as `configured-candidate`. Atlas upgrades it only when the route has one unambiguous Struts mapping, one resolved dispatch method, a unique configured result name, and that method contains a matching direct literal return (`findForward("name")` for Struts 1 or `return "name"` for Struts 2). Dynamic expressions, constants, multiple dispatch methods, duplicate result names, missing source, and unresolved mappings remain candidates.

Edge `confidence` is independent from this modality. It measures confidence in extracting the configured relationship, so `confidence=1` may still be a `configured-candidate`. Readers of older indexes, missing metadata, invalid classifications, or `code-confirmed` metadata without valid `codeEvidence` must conservatively treat the outcome as a configured candidate. This metadata addition does not change `schemaVersion`; consumers that ignore `edge.data.outcome` retain the existing graph structure.
