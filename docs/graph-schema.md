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
