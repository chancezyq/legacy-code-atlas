import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractJavaScriptRequests, parseJsp } from "../src/parsers/jsp.mjs";

function elapsedCpuMilliseconds(startedAt) {
  const elapsed = process.cpuUsage(startedAt);
  return (elapsed.user + elapsed.system) / 1_000;
}

const fixture = new URL("./fixtures/legacy-shop/web/order/audit.jsp", import.meta.url);
const jsFixture = new URL("./fixtures/legacy-shop/web/js/order.js", import.meta.url);

test("JSP parser extracts business text, requests, includes, and fields with evidence", async () => {
  const content = await readFile(fixture, "utf8");
  const result = parseJsp(content, "web/order/audit.jsp");

  assert.equal(result.visibleText.includes("订单审核"), true);
  assert.equal(result.visibleText.includes("审核通过"), true);
  assert.equal(result.textEntries.some((entry) => entry.text === "订单审核" && entry.evidence.line === 4), true);
  assert.deepEqual(
    result.requests.map(({ kind, url, method }) => [kind, url, method]),
    [
      ["form", "/order/audit.do", "POST"],
      ["link", "/order/list.do", "GET"],
      ["fetch", "/order/audit/status.do", "GET"],
      ["ajax", "/order/audit/history.do", "GET"],
    ],
  );
  assert.deepEqual(result.includes.map((entry) => entry.path), ["/common/tags.jsp", "/common/header.jsp"]);
  assert.deepEqual(result.scripts.map((entry) => entry.path), ["/js/order.js"]);
  assert.deepEqual(result.fields.map((entry) => [entry.name, entry.value]), [
    ["orderId", ""],
    ["method", "audit"],
    ["decision", "PASS"],
  ]);
  assert.deepEqual(result.requests[0].parameters, {
    decision: "PASS",
    method: "audit",
    orderId: "",
  });
  assert.deepEqual(result.requests[0].evidence, {
    file: "web/order/audit.jsp",
    line: 8,
    column: 24,
    snippet: '<form id="auditForm" action="${pageContext.request.contextPath}/order/audit.do" method="post">',
  });
});

test("JSP parser resolves static nested c:url attributes without inventing template-fragment routes", () => {
  const result = parseJsp([
    '<a href="<c:url value="/login.jsp"/>" class="current">Login</a>',
    '<a href="<c:out value="${link}"/>">Open upload</a>',
  ].join("\n"), "web/common/menu.jsp");

  assert.deepEqual(
    result.requests.map(({ kind, url }) => [kind, url]),
    [["link", "/login.jsp"]],
  );
  assert.equal(result.visibleText, "Login Open upload");
  assert.doesNotMatch(JSON.stringify(result), /%3Cc:(?:url|out)%20value=/u);
});

test("JSP parser resolves an unquoted static nested c:url form action", () => {
  const result = parseJsp(
    '<form action=<c:url value="/save.do"/> method=post></form>',
    "web/order/edit.jsp",
  );

  assert.deepEqual(
    result.requests.map(({ kind, url, method }) => [kind, url, method]),
    [["form", "/save.do", "POST"]],
  );
  assert.doesNotMatch(JSON.stringify(result), /%3Cc:url/u);
});

test("JSP parser rejects dynamic or malformed unquoted nested c:url form actions", () => {
  const result = parseJsp([
    '<form action=<c:url value="${dynamicAction}"/>></form>',
    '<form action=<c:url value="/broken.do">></form>',
  ].join("\n"), "web/order/edit.jsp");

  assert.deepEqual(result.requests, []);
});

test("JSP parser marks only relative Struts 2 tag actions for name-based alignment", () => {
  const result = parseJsp([
    '<s:form action="save"></s:form>',
    '<s:form action="/admin/save"></s:form>',
    '<s:form action="save" namespace="/review"></s:form>',
  ].join("\n"), "web/order/edit.jsp");

  assert.deepEqual(
    result.requests.map(({ url, struts2ActionRelative = false }) => ({ url, struts2ActionRelative })),
    [
      { url: "/save.action", struts2ActionRelative: true },
      { url: "/admin/save.action", struts2ActionRelative: false },
      { url: "/review/save.action", struts2ActionRelative: false },
    ],
  );
});

test("JSP parser preserves quoted JavaScript comparisons inside attributes", () => {
  const result = parseJsp(
    '<form action="/save.do" method="post" onclick="if (a < b && c) submitForm()"></form>',
    "web/order/edit.jsp",
  );

  assert.deepEqual(
    result.requests.map(({ url, method }) => [url, method]),
    [["/save.do", "POST"]],
  );
});

test("JSP parser omits punctuation-only template residue from visible text", () => {
  const result = parseJsp([
    '<img src=<c:url value="/images/calendar.gif"/>>',
    '<span>${dynamicOnly}</span>',
    '<select name="<c:out value="${leftId}"/>" multiple="multiple" onDblClick="moveSelectedOptions($(\'<c:out value="${rightId}"/>\'))">',
    '  <option value="all">All patients</option>',
    '</select>',
    '<button id="move<c:out value="${count}"/>" type="button" onclick="moveAllOptions()">Move all</button>',
    '<noscript>&lt;!-- fallback --&gt;&lt;ul&gt;&lt;li&gt;&lt;a href="/all"&gt;Fallback menu&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;</noscript>',
    '<p>Patient search</p>',
  ].join("\n"), "web/patient.jsp");

  assert.equal(result.visibleText, "All patients Move all Fallback menu Patient search");
  assert.deepEqual(
    result.textEntries.map(({ text }) => text),
    ["All patients", "Move all", "Fallback menu", "Patient search"],
  );
  assert.doesNotMatch(result.visibleText, /multiple=|onclick=|moveAllOptions|<\/?(?:ul|li|a)|fallback --/u);
});

test("JSP parser omits dynamic field names instead of presenting expressions as literal fields", () => {
  const result = parseJsp([
    '<form action="/move.do">',
    '  <select name="<c:out value="${param.leftId}"/>"></select>',
    '  <input name="${dynamicName}" value="dynamic">',
    '  <s:textfield name="%{#request.fieldName}" value="dynamic" />',
    '  <input name="staticName" value="known">',
    '</form>',
  ].join("\n"), "web/pickList.jsp");

  assert.deepEqual(result.fields.map(({ name }) => name), ["staticName"]);
  assert.deepEqual(result.requests[0].parameters, { staticName: "known" });
  assert.equal(result.requests[0].parametersComplete, false);
  assert.equal(result.requests[0].hasDynamicParameterNames, true);
  assert.deepEqual(result.warnings, [
    "dynamic JSP field name omitted in web/pickList.jsp at line 2",
    "dynamic JSP field name omitted in web/pickList.jsp at line 3",
    "dynamic JSP field name omitted in web/pickList.jsp at line 4",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /param\.leftId|dynamicName|fieldName/u);
});

test("JSP parser preserves quoted visible text containing comparison symbols", () => {
  const result = parseJsp('<p>"A > B"</p>', "web/comparison.jsp");

  assert.equal(result.visibleText, '"A > B"');
  assert.deepEqual(result.textEntries.map(({ text }) => text), ['"A > B"']);
});

test("JavaScript request extraction handles XHR and fetch without query expressions", async () => {
  const content = await readFile(jsFixture, "utf8");
  const requests = extractJavaScriptRequests(content, "web/js/order.js");

  assert.deepEqual(
    requests.map(({ kind, url, method }) => [kind, url, method]),
    [
      ["xhr", "/order/detail.do", "GET"],
      ["fetch", "/order/permission/check.do", "GET"],
      ["fetch", "/api/orders/list", "GET"],
    ],
  );
  assert.equal(requests[0].evidence.line, 3);
});

test("JavaScript request extraction reports only proven fetch methods", () => {
  const requests = extractJavaScriptRequests([
    "fetch('/default.do');",
    "fetch('/save.do', { method: 'POST', body: payload });",
    "fetch('/dynamic.do', { method: verb });",
  ].join("\n"), "web/js/order.js");

  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
    ["/default.do", "GET"],
    ["/save.do", "POST"],
    ["/dynamic.do", ""],
  ]);
});

test("JavaScript request extraction preserves static HEAD and OPTIONS methods", () => {
  const requests = extractJavaScriptRequests([
    "fetch('/fetch-head.do', { method: 'HEAD' });",
    "fetch('/fetch-options.do', { method: 'OPTIONS' });",
    "$.ajax({ url: '/ajax-head.do', method: 'HEAD' });",
    "$.ajax({ url: '/ajax-options.do', type: 'OPTIONS' });",
    "request.open('HEAD', '/xhr-head.do');",
    "request.open('OPTIONS', '/xhr-options.do');",
  ].join("\n"), "web/js/order.js");

  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
    ["/fetch-head.do", "HEAD"],
    ["/fetch-options.do", "OPTIONS"],
    ["/ajax-head.do", "HEAD"],
    ["/ajax-options.do", "OPTIONS"],
    ["/xhr-head.do", "HEAD"],
    ["/xhr-options.do", "OPTIONS"],
  ]);
});

test("JavaScript request extraction reads transport options only at object top level", () => {
  const requests = extractJavaScriptRequests([
    "fetch('/fetch-nested.do', { headers: { method: 'POST' } });",
    "$.ajax({ url: '/ajax-nested.do', data: { method: 'POST' } });",
    "$.ajax({ data: { url: '/nested-only.do' }, method: 'POST' });",
  ].join("\n"), "web/js/order.js");

  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
    ["/fetch-nested.do", "GET"],
    ["/ajax-nested.do", "GET"],
  ]);
});

test("JavaScript request extraction respects final and uncertain object overrides", () => {
  const requests = extractJavaScriptRequests([
    "fetch('/spread-after.do', { method: 'POST', ...options });",
    "fetch('/spread-before.do', { ...options, method: 'POST' });",
    "fetch('/duplicate.do', { method: 'POST', method: 'GET' });",
    "fetch('/computed-after.do', { method: 'POST', [key]: value });",
    "fetch('/computed-before.do', { [key]: value, method: 'POST' });",
    "$.ajax({ url: '/ajax-spread-after.do', method: 'POST', ...options });",
    "$.ajax({ ...options, url: '/ajax-spread-before.do', method: 'POST' });",
  ].join("\n"), "web/js/order.js");

  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
    ["/spread-after.do", ""],
    ["/spread-before.do", "POST"],
    ["/duplicate.do", "GET"],
    ["/computed-after.do", ""],
    ["/computed-before.do", "POST"],
    ["/ajax-spread-before.do", "POST"],
  ]);
});

test("JavaScript request extraction handles comments before fetch options", () => {
  const requests = extractJavaScriptRequests(
    "fetch('/save.do' /* request options */, { method: 'POST' });",
    "web/js/order.js",
  );

  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [["/save.do", "POST"]]);
});

test("JavaScript request extraction scans executable template interpolations", () => {
  const requests = extractJavaScriptRequests(
    "const pending = `status: ${fetch('/inside-template.do')}`;",
    "web/js/order.js",
  );

  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [["/inside-template.do", "GET"]]);
});

test("JavaScript request extraction ignores request-like text in regex literals", () => {
  const requests = extractJavaScriptRequests([
    'const fetchPattern = /fetch("fake-fetch.do")/;',
    'const ajaxPattern = /$.ajax({url:"fake-ajax.do"})/;',
    "const ratio = total / count;",
    "fetch('/real.do');",
  ].join("\n"), "web/js/order.js");

  assert.deepEqual(requests.map(({ url }) => url), ["/real.do"]);
});

test("JavaScript request extraction recognizes regex literals after control headers and blocks", () => {
  const requests = extractJavaScriptRequests([
    'if (enabled) /fetch("if-fake.do")/.test(value);',
    '{} /fetch("block-fake.do")/.test(value);',
    'fetch("/real.do");',
  ].join("\n"), "web/js/order.js");

  assert.deepEqual(requests.map(({ url }) => url), ["/real.do"]);
});

test("JavaScript request extraction keeps static URL prefixes from dynamic ajax expressions", () => {
  const requests = extractJavaScriptRequests(
    '$.ajax({ url: "/orders.do?id=" + orderId, method: "POST" });',
    "web/js/order.js",
  );

  assert.deepEqual(requests.map(({ url, method, parameters }) => [url, method, parameters]), [
    ["/orders.do", "POST", { id: "" }],
  ]);
});

test("JavaScript request extraction preserves proven static query parameters", () => {
  const requests = extractJavaScriptRequests([
    "fetch('/orders.do?method=list&id=7');",
    "fetch('/orders.do?id=' + orderId);",
  ].join("\n"), "web/js/order.js");

  assert.deepEqual(requests.map(({ url, parameters }) => [url, parameters]), [
    ["/orders.do", { method: "list", id: "7" }],
    ["/orders.do", { id: "" }],
  ]);
});

test("JSP parser resolves relative actions and ignores external or javascript links", () => {
  const content = [
    '<form action="save.do"></form>',
    '<form action="child/save.do"></form>',
    '<a href="child/list.do">child</a>',
    '<a href="https://example.com/x">external</a>',
    '<a href="javascript:submitForm()">script</a>',
  ].join("\n");
  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [
    ["form", "/order/save.do"],
    ["form", "/order/child/save.do"],
    ["link", "/order/child/list.do"],
  ]);
  assert.deepEqual(result.requests.map(({ relativeUrl }) => relativeUrl), [
    "save.do",
    "child/save.do",
    "child/list.do",
  ]);
});

test("JSP parser decodes markup URLs and preserves current-document requests", () => {
  const result = parseJsp([
    '<a href="/x.do?method=save&amp;id=7">Named entity</a>',
    '<a href="/y.do?method=delete&#38;id=8">Numeric entity</a>',
    '<form method="post"><input name="mode" value="save"></form>',
    '<a href="?method=list">Same page</a>',
    String.raw`<a href="\\evil.example\steal.do">External</a>`,
  ].join("\n"), "WebRoot/orders/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url, method, parameters }) => [kind, url, method, parameters]), [
    ["link", "/x.do", "GET", { method: "save", id: "7" }],
    ["link", "/y.do", "GET", { method: "delete", id: "8" }],
    ["form", "/orders/edit.jsp", "POST", { mode: "save" }],
    ["link", "/orders/edit.jsp", "GET", { method: "list" }],
  ]);
  assert.equal(result.requests[2].relativeUrl, "");
  assert.equal(result.requests[3].relativeUrl, "?method=list");
});

test("JSP parser extracts Struts 1 and Struts 2 taglib requests", () => {
  const content = [
    '<html:form action="/order/audit" method="post"></html:form>',
    '<html:link action="/order/list">Orders</html:link>',
    '<s:form action="save" namespace="/admin" method="post"></s:form>',
    '<s:url action="review" namespace="/order" />',
    '<s:a action="cancel" namespace="/order">Cancel</s:a>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url, method }) => [kind, url, method]), [
    ["form", "/order/audit.do", "POST"],
    ["link", "/order/list.do", "GET"],
    ["form", "/admin/save.action", "POST"],
    ["link", "/order/review.action", "GET"],
    ["link", "/order/cancel.action", "GET"],
  ]);
  assert.equal(result.requests[0].evidence.line, 1);
  assert.equal(result.requests[2].evidence.line, 3);
});

test("JSP form methods follow native and taglib defaults without inventing dynamic methods", () => {
  const content = [
    '<form action="/native-default.do"></form>',
    '<html:form action="/struts-one"></html:form>',
    '<s:form action="struts-two" namespace="/order"></s:form>',
    '<form:form action="/spring.do"></form:form>',
    '<form action="/native-dynamic.do" method="<%= verb %>"></form>',
    '<html:form action="/taglib-invalid" method="TRACE"></html:form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, method }) => [url, method]), [
    ["/native-default.do", "GET"],
    ["/struts-one.do", "POST"],
    ["/order/struts-two.action", "POST"],
    ["/spring.do", "POST"],
    ["/native-dynamic.do", ""],
    ["/taglib-invalid.do", ""],
  ]);
});

test("JSP taglib actions are context-relative and preserve existing extensions", () => {
  const content = '<html:form action="order/audit"></html:form>\n<s:url action="review.ACTION" namespace="/order" />';
  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url }) => url), ["/order/audit.do", "/order/review.ACTION"]);
});

test("JSP parser extracts Struts taglib fields for dispatch parameters", () => {
  const content = [
    '<html:form action="/order/audit" method="post">',
    '  <html:hidden property="method" value="audit" />',
    '  <html:text property="orderId" />',
    '</html:form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.fields.map(({ name, value }) => [name, value]), [
    ["method", "audit"],
    ["orderId", ""],
  ]);
  assert.deepEqual(result.requests[0].parameters, { method: "audit", orderId: "" });
});

test("JSP parser uses a static Struts 2 key as the fallback field binding", () => {
  const result = parseJsp([
    '<s:form action="save">',
    '  <s:hidden key="user.id" value="${user.id}" />',
    '  <s:textfield key="user.firstName" />',
    '  <s:select key="user.team" />',
    '  <s:textfield name="explicit" key="label.only" />',
    '</s:form>',
  ].join("\n"), "WebRoot/userForm.jsp");

  assert.deepEqual(result.fields.map(({ name, value }) => [name, value]), [
    ["user.id", ""],
    ["user.firstName", ""],
    ["user.team", ""],
    ["explicit", ""],
  ]);
  assert.deepEqual(result.requests[0].parameters, {
    explicit: "",
    "user.firstName": "",
    "user.id": "",
    "user.team": "",
  });
});

test("JSP parser does not present nested tag output as a static field value", () => {
  const result = parseJsp(
    '<form action="/roles.do"><input type="hidden" name="userRoles" value="<s:property value="value"/>"/></form>',
    "WebRoot/userForm.jsp",
  );

  assert.deepEqual(result.fields.map(({ name, value }) => [name, value]), [["userRoles", ""]]);
  assert.deepEqual(result.requests[0].parameters, { userRoles: "" });
});

test("JSP parser keeps repeated runtime-derived field defaults unresolved", () => {
  const result = parseJsp([
    '<form action="/text.do">',
    '  <input name="mode" value="${runtimeMode}">',
    '  <input name="mode" value="fixed">',
    '</form>',
    '<form action="/choice.do">',
    '  <input type="checkbox" checked name="flag" value="%{runtimeFlag}">',
    '  <input type="checkbox" checked name="flag" value="fixed">',
    '</form>',
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/text.do", { mode: "" }],
    ["/choice.do", { flag: "" }],
  ]);
  assert.deepEqual(result.requests.map(({ runtimeValueParameterNames }) => runtimeValueParameterNames), [
    ["mode"],
    ["flag"],
  ]);
});

test("JSP parser masks non-include directives without losing static include directives", () => {
  const content = [
    '<%@ page info="<form action=\'/ghost.do\'><input name=\'ghost\' value=\'x\'></form><a href=\'/ghost-link.do\'>ghost</a>" %>',
    '<%@ include file="/common/header.jsp" %>',
    '<form action="/real.do"><input name="real"></form>',
  ].join("\n");

  const result = parseJsp(content, "web/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [["form", "/real.do"]]);
  assert.deepEqual(result.requests[0].parameters, { real: "" });
  assert.deepEqual(result.fields.map(({ name }) => name), ["real"]);
  assert.deepEqual(result.includes.map(({ path }) => path), ["/common/header.jsp"]);
});

test("JSP parser scopes native field values to their containing form", () => {
  const content = [
    '<form action="/order/save.do" method="post">',
    '  <input name="mode" value="save">',
    '  <input name="orderId" value="42">',
    '</form>',
    '<input name="outside" value="not-submitted">',
    '<form action="/order/list.do">',
    '  <input name="mode" value="list">',
    '</form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/order/save.do", { mode: "save", orderId: "42" }],
    ["/order/list.do", { mode: "list" }],
  ]);
});

test("JSP parser scopes Struts field values to their containing form", () => {
  const content = [
    '<html:form action="/order/audit" method="post">',
    '  <html:hidden property="method" value="audit" />',
    '</html:form>',
    '<s:form action="save" namespace="/order" method="post">',
    '  <s:hidden name="method" value="save" />',
    '</s:form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/order/audit.do", { method: "audit" }],
    ["/order/save.action", { method: "save" }],
  ]);
});

test("JSP parser ignores form-like closing tags inside inert source regions", () => {
  const content = [
    '<html:form action="/order/audit" method="post">',
    '  <%-- </html:form> --%>',
    '  <!-- </html:form> -->',
    '  <script>const closing = "</html:form>";</script>',
    '  <textarea name="note">literal </html:form></textarea>',
    '  <html:hidden property="method" value="audit" />',
    '</html:form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests[0].parameters, { method: "audit", note: "literal </html:form>" });
});

test("JSP parser ignores requests and fields inside inert source regions", () => {
  const content = [
    '<%-- <form action="/retired.do"><input name="method" value="delete"></form> --%>',
    '<form action="/order/save.do">',
    '  <input name="method" value="save">',
    '  <%-- <input name="method" value="delete"> --%>',
    '</form>',
    '<script>const retired = \'<form action="/script.do"><input name="method" value="script"></form>\';</script>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/order/save.do", { method: "save" }],
  ]);
});

test("JSP parser assigns native controls through their explicit form owner", () => {
  const content = [
    '<form id="auditForm" action="/order/audit.do"></form>',
    '<input form="auditForm" name="method" value="audit">',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests[0].parameters, { method: "audit" });
});

test("JSP parser handles Spring form tags without confusing prefixed controls for forms", () => {
  const content = [
    '<form:form action="/order/save.do">',
    '  <form:input path="orderId" />',
    '  <input name="method" value="save">',
    '</form:form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/order/save.do", { method: "save", orderId: "" }],
  ]);
  assert.deepEqual(result.fields.map((field) => field.name), ["orderId", "method"]);
});

test("JSP parser reads attributes from the original source after structural masking", () => {
  const content = [
    '<form action="/order/save.do">',
    '  <input name="orderId" value="<%= bean.getId() %>">',
    '</form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.equal(result.fields[0].value, "");
  assert.deepEqual(result.requests[0].parameters, { orderId: "" });
});

test("JSP parser ignores dependencies and JavaScript requests in hidden source regions", () => {
  const content = [
    '<% String retired = "<jsp:include page=\\"/scriptlet.jsp\\"/><script src=\\"/scriptlet.js\\"></script>"; %>',
    '<%-- fetch("/jsp-comment.do") --%>',
    '<!-- fetch("/html-comment.do") -->',
    '<style>fetch("/style.do")</style>',
    '<textarea>fetch("/textarea.do")</textarea>',
    '<template><script>fetch("/template.do")</script></template>',
    '<jsp:include page="/real.jsp"/>',
    '<script src="/real.js">fetch("/real.do")</script>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.includes.map((entry) => entry.path), ["/real.jsp"]);
  assert.deepEqual(result.scripts.map((entry) => entry.path), ["/real.js"]);
  assert.deepEqual(result.requests, []);
});

test("JSP parser ignores dynamic include targets", () => {
  const result = parseJsp([
    '<%@ include file="${directiveTarget}" %>',
    '<jsp:include page="${runtimeTarget}" />',
    '<jsp:include page="/real.jsp" />',
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.includes.map(({ path }) => path), ["/real.jsp"]);
});

test("JSP parser scans executable script wrappers but ignores JavaScript comments and strings", () => {
  const result = parseJsp([
    "<script>",
    "// fetch('/line-comment.do')",
    "/* fetch('/block-comment.do') */",
    "const text = \"fetch('/string.do')\";",
    "<!--",
    "fetch('/wrapped.do');",
    "-->",
    "</script>",
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [["fetch", "/wrapped.do"]]);
});

test("JSP parser scans only executable JavaScript script types", () => {
  const result = parseJsp([
    '<script type="application/json">fetch("/json.do")</script>',
    '<script type="text/x-handlebars-template">fetch("/template.do")</script>',
    '<script type="importmap">{"imports":{"fetch(\\"/map.do\\")":"/x.js"}}</script>',
    '<script type="speculationrules">{"urls":["fetch(\\"/rules.do\\")"]}</script>',
    '<script type="application/json" src="/data.js"></script>',
    '<script type="">fetch("/empty-type.do")</script>',
    '<script type="module">fetch("/module.do")</script>',
    '<script src="/real.js">fetch("/ignored-body.do")</script>',
  ].join("\n"), "WebRoot/edit.jsp");

  assert.deepEqual(result.requests.map(({ url }) => url), ["/empty-type.do", "/module.do"]);
  assert.deepEqual(result.scripts.map(({ path }) => path), ["/real.js"]);
});

test("JSP parser scans JavaScript only inside executable inline scripts", () => {
  const result = parseJsp([
    '<p>fetch("/visible-fake.do")</p>',
    '<div></div>',
    '<script>fetch("/real.do")</script>',
  ].join("\n"), "WebRoot/edit.jsp");

  assert.deepEqual(result.requests.map(({ url }) => url), ["/real.do"]);
});

test("JSP parser treats legacy script wrapper markers as line comments", () => {
  const result = parseJsp([
    "<script>",
    "<!-- fetch('/opening-line.do')",
    "fetch('/middle-line.do')",
    "--> fetch('/closing-line.do')",
    "</script>",
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url }) => url), ["/middle-line.do"]);
});

test("JSP parser masks nested templates and unclosed raw-text elements", () => {
  const content = [
    '<template>',
    '  <template><span>nested</span></template>',
    '  <form action="/template.do"><input name="mode" value="template"></form>',
    '</template>',
    '<script><form action="/script.do"><input name="mode" value="script">',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.fields, []);
});

test("JSP parser keeps raw-text offsets stable after Unicode case expansion", () => {
  const result = parseJsp(
    'İ<script>const fake = \'<form action="/fake.do"></form>\';</script><form action="/real.do"></form>',
    "WebRoot/order/edit.jsp",
  );

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [["form", "/real.do"]]);
});

test("JSP parser masks repeated unclosed comments without quadratic rescanning", () => {
  const content = "<%--".repeat(24_000);
  const startedAt = process.cpuUsage();
  const result = parseJsp(content, "WebRoot/unclosed.jsp");
  const elapsedMs = elapsedCpuMilliseconds(startedAt);

  assert.deepEqual(result.requests, []);
  assert.ok(elapsedMs < 750, `24,000 unclosed comment markers took ${elapsedMs.toFixed(1)} ms`);
});

test("JSP parser rejects repeated malformed tags without quadratic rescanning", () => {
  const measure = (count) => {
    const startedAt = process.cpuUsage();
    const result = parseJsp("<form ".repeat(count), "WebRoot/malformed.jsp");
    return { elapsedMs: elapsedCpuMilliseconds(startedAt), result };
  };

  measure(200);
  const ratios = [];
  const largerSamples = [];
  let result;
  for (let sample = 0; sample < 5; sample += 1) {
    const smaller = measure(4_000);
    const larger = measure(8_000);
    ratios.push(larger.elapsedMs / smaller.elapsedMs);
    largerSamples.push(larger.elapsedMs);
    result = larger.result;
  }
  ratios.sort((left, right) => left - right);
  largerSamples.sort((left, right) => left - right);
  const ratio = ratios[2];
  const largerMs = largerSamples[2];

  assert.deepEqual(result.requests, []);
  assert.ok(largerMs < 750, `8,000 malformed tags took ${largerMs.toFixed(1)} ms`);
  assert.ok(
    ratio < 3.2,
    `doubling malformed tags had a median scaling ratio of ${ratio.toFixed(2)}x`,
  );
});

test("JSP parser keeps scanning after comparison text and rejects invalid markers linearly", () => {
  const parsed = parseJsp('1 < 2 <form action="/found.do"></form>', "WebRoot/edit.jsp");
  assert.deepEqual(parsed.requests.map(({ url }) => url), ["/found.do"]);

  const measure = (count) => {
    const startedAt = process.cpuUsage();
    parseJsp("<1".repeat(count), "WebRoot/invalid.jsp");
    return elapsedCpuMilliseconds(startedAt);
  };
  measure(500);
  const ratios = [];
  const largerSamples = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const smaller = measure(8_000);
    const larger = measure(16_000);
    ratios.push(larger / smaller);
    largerSamples.push(larger);
  }
  ratios.sort((left, right) => left - right);
  largerSamples.sort((left, right) => left - right);
  const ratio = ratios[2];
  const largerMs = largerSamples[2];
  assert.ok(largerMs < 750, `16,000 invalid markers took ${largerMs.toFixed(1)} ms`);
  assert.ok(ratio < 3.2, `doubling invalid markers had a median scaling ratio of ${ratio.toFixed(2)}x`);
});

test("JSP parser keeps explicit empty and duplicate form owners unassigned", () => {
  const content = [
    '<form action="/empty-owner.do"><input form="" name="mode" value="empty"></form>',
    '<form id="duplicate"></form>',
    '<form id="duplicate" action="/first.do"></form>',
    '<input form="duplicate" name="mode" value="ambiguous">',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/empty-owner.do", {}],
    ["/order/edit.jsp", {}],
    ["/first.do", {}],
  ]);
});

test("JSP parser does not assign nested mixed-form fields to both forms", () => {
  const content = [
    '<form action="/outer.do">',
    '  <html:form action="/inner" method="post">',
    '    <input name="mode" value="inner">',
    '  </html:form>',
    '</form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/outer.do", {}],
    ["/inner.do", { mode: "inner" }],
  ]);
});

test("JSP request evidence locates the exact action attribute", () => {
  const result = parseJsp(
    '<form class="action" action="/order/save.do"></form>',
    "WebRoot/order/edit.jsp",
  );

  assert.equal(result.requests[0].evidence.column, 22);
});

test("JSP parser does not let an unclosed form consume the next form", () => {
  const content = [
    '<form action="/order/broken.do">',
    '  <input name="mode" value="broken">',
    '<form action="/order/good.do">',
    '  <input name="mode" value="good">',
    '</form>',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/order/broken.do", {}],
    ["/order/good.do", { mode: "good" }],
  ]);
});

test("JSP parser assigns fields to many forms without quadratic rescanning", () => {
  const formCount = 16_000;
  const content = Array.from({ length: formCount }, (_, index) => (
    `<form action="/r${index}.do"><input name="value" value="${index}"></form>`
  )).join("\n");

  const startedAt = performance.now();
  const result = parseJsp(content, "WebRoot/many.jsp");
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.requests.length, formCount);
  assert.deepEqual(result.requests.at(-1).parameters, { value: String(formCount - 1) });
  assert.ok(elapsedMs < 1_500, `16,000 forms took ${elapsedMs.toFixed(1)} ms`);
});

test("JSP parser extracts static rewrite and value taglib URLs but skips dynamic targets", () => {
  const content = [
    '<html:rewrite page="/order/detail.do" />',
    '<html:link page="/order/list.do">Orders</html:link>',
    '<s:url value="/order/review.action" />',
    '<html:rewrite page="${order.nextUrl}" />',
    '<s:url value="%{#request.nextUrl}" />',
  ].join("\n");

  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [
    ["link", "/order/detail.do"],
    ["link", "/order/list.do"],
    ["link", "/order/review.action"],
  ]);
});

test("JSP parser ignores taglib URL elements without a target", () => {
  assert.doesNotThrow(() => parseJsp("<html:rewrite /><s:url />", "WebRoot/order/edit.jsp"));
  assert.deepEqual(parseJsp("<html:rewrite /><s:url />", "WebRoot/order/edit.jsp").requests, []);
});

test("JSP parser extracts static hrefs from Struts link tags", () => {
  const result = parseJsp(
    '<html:link href="/order/help.do">Help</html:link>\n<s:a href="/order/help.action">Help</s:a>',
    "WebRoot/order/edit.jsp",
  );

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [
    ["link", "/order/help.do"],
    ["link", "/order/help.action"],
  ]);
});

test("JSP parser skips dynamic Struts action targets", () => {
  const result = parseJsp([
    '<html:form action="${order.nextAction}"></html:form>',
    '<s:url action="%{#request.nextAction}" />',
    '<s:a action="${link.action}">Next</s:a>',
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests, []);
});

test("JSP parser skips dynamic native form and link targets", () => {
  const result = parseJsp([
    '<form action="${bean.action}"></form>',
    '<a href="${bean.url}">Next</a>',
    '<form action="<%= bean.getAction() %>"></form>',
    '<a href="<%= bean.getUrl() %>">Next</a>',
    '<form action="${pageContext.request.contextPath}/order/save.do"></form>',
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [
    ["form", "/order/save.do"],
  ]);
});

test("JSP parser resolves the action pathname before inspecting query parameters", () => {
  const result = parseJsp(
    '<form action="save.do?next=/home.do"></form>',
    "web/order/edit.jsp",
  );

  assert.deepEqual(result.requests.map(({ url }) => url), ["/order/save.do"]);
});

test("JSP parser preserves static and dynamic query parameters on local routes", () => {
  const result = parseJsp([
    '<a href="/orders.do?method=delete&id=7">Delete</a>',
    '<form action="/orders.do?method=save"><input name="id" value="8"></form>',
    '<a href="/orders.do?id=${bean.id}">Details</a>',
  ].join("\n"), "web/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url, parameters }) => [kind, url, parameters]), [
    ["link", "/orders.do", { method: "delete", id: "7" }],
    ["form", "/orders.do", { method: "save", id: "8" }],
    ["link", "/orders.do", { id: "" }],
  ]);
});

test("JSP parser preserves a static route with a scriptlet query value", () => {
  const result = parseJsp(
    '<form action="/orders.do?id=<%= bean.getId() %>"></form>',
    "web/order/edit.jsp",
  );

  assert.deepEqual(result.requests.map(({ kind, url, parameters }) => [kind, url, parameters]), [
    ["form", "/orders.do", { id: "" }],
  ]);
});

test("JSP parser marks omitted dynamic query parameter names as incomplete", () => {
  const result = parseJsp(
    '<form action="/orders.do?${runtimeName}=x&method=save"></form>',
    "web/order/edit.jsp",
  );

  assert.deepEqual(result.requests[0].parameters, { method: "save" });
  assert.deepEqual(result.requests[0].queryParameterNames, ["method"]);
  assert.equal(result.requests[0].parametersComplete, false);
  assert.equal(result.requests[0].hasDynamicParameterNames, true);
});

test("JSP parser accepts common unquoted static attributes", () => {
  const result = parseJsp(
    '<form action=/order/save.do method=post><input name=orderId value=42></form>',
    "web/order/edit.jsp",
  );

  assert.deepEqual(result.requests.map(({ url, method, parameters }) => [url, method, parameters]), [
    ["/order/save.do", "POST", { orderId: "42" }],
  ]);
});

test("JSP parser does not treat unchecked choice values as submitted defaults", () => {
  const result = parseJsp([
    '<form action="/preferences.do">',
    '  <input type="checkbox" name="digest" value="yes">',
    '  <input type="checkbox" name="alerts" value="yes" checked>',
    '  <input type="radio" name="mode" value="compact">',
    '  <input type="radio" name="mode" value="full" checked>',
    '</form>',
  ].join("\n"), "web/preferences.jsp");

  assert.deepEqual(result.fields.map(({ name, value }) => [name, value]), [
    ["digest", ""],
    ["alerts", "yes"],
    ["mode", ""],
    ["mode", "full"],
  ]);
  assert.deepEqual(result.requests[0].parameters, {
    alerts: "yes",
    digest: "",
    mode: "full",
  });
});

test("JSP parser aggregates duplicate choice names without letting unchecked controls win", () => {
  const result = parseJsp([
    '<form action="/display.do">',
    '  <input type="radio" name="mode" value="full" checked>',
    '  <input type="radio" name="mode" value="compact">',
    '</form>',
  ].join("\n"), "web/display.jsp");

  assert.deepEqual(result.requests[0].parameters, { mode: "full" });
});

test("JSP parser extracts native select and textarea defaults", () => {
  const result = parseJsp([
    '<form action="/dispatch.do">',
    '  <select name="method"><option value="save">Save</option><option value="delete">Delete</option></select>',
    '  <select name="decision"><option value="PASS">Pass</option><option value="REJECT" selected>Reject</option></select>',
    '  <textarea name="note">hello &amp; goodbye</textarea>',
    '</form>',
  ].join("\n"), "WebRoot/edit.jsp");

  assert.deepEqual(result.fields.map(({ name, value }) => [name, value]), [
    ["method", "save"],
    ["decision", "REJECT"],
    ["note", "hello & goodbye"],
  ]);
  assert.deepEqual(result.requests[0].parameters, {
    decision: "REJECT",
    method: "save",
    note: "hello & goodbye",
  });
});

test("JSP parser excludes disabled and non-submitting controls from form defaults", () => {
  const result = parseJsp([
    '<form action="/dispatch.do">',
    '  <button name="method" value="save">Save</button>',
    '  <button name="method" value="delete">Delete</button>',
    '  <input type="reset" name="reset" value="yes">',
    '  <input type="button" name="plain" value="yes">',
    '  <input disabled name="disabled" value="yes">',
    '</form>',
  ].join("\n"), "WebRoot/edit.jsp");

  assert.deepEqual(result.requests[0].parameters, { method: "" });
});

test("JSP parser honors disabled fieldsets and static false taglib attributes", () => {
  const result = parseJsp([
    '<form action="/native.do">',
    '  <fieldset disabled>',
    '    <legend><input name="legendValue" value="yes"></legend>',
    '    <input name="disabledByFieldset" value="no">',
    '  </fieldset>',
    '  <input name="enabled" value="yes">',
    '</form>',
    '<html:form action="/taglib">',
    '  <html:hidden property="enabled" value="yes" disabled="false" />',
    '  <html:hidden property="disabled" value="no" disabled="true" />',
    '</html:form>',
  ].join("\n"), "WebRoot/edit.jsp");

  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/native.do", { enabled: "yes", legendValue: "yes" }],
    ["/taglib.do", { enabled: "yes" }],
  ]);
});

test("JSP parser does not absorb self-closing slashes into unquoted attributes", () => {
  const result = parseJsp(
    '<form action=/save.do/><input name=outside/>',
    "web/edit.jsp",
  );

  assert.deepEqual(result.requests.map(({ url }) => url), ["/save.do"]);
  assert.deepEqual(result.fields.map(({ name }) => name), ["outside"]);
});

test("JSP parser rejects external URLs with arbitrary schemes", () => {
  const result = parseJsp([
    '<a href="ftp://example.com/foreign.do">FTP</a>',
    '<form action="custom+app://example.com/save.do"></form>',
    '<a href="/local.do">Local</a>',
  ].join("\n"), "web/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [["link", "/local.do"]]);
});

test("JSP parser counts unresolved forms for downstream scope decisions", () => {
  const result = parseJsp([
    '<form action="/known.do"><input name="known"></form>',
    '<form action="${dynamic.action}"><input name="dynamic"></form>',
  ].join("\n"), "web/edit.jsp");

  assert.equal(result.formCount, 2);
  assert.deepEqual(result.requests.map(({ url, parameters }) => [url, parameters]), [
    ["/known.do", { known: "" }],
  ]);
});

test("JSP parser reports fields that are not assigned to any form", () => {
  const result = parseJsp([
    '<form action="/known.do"><input name="inside"></form>',
    '<input name="outside">',
  ].join("\n"), "web/edit.jsp");

  assert.equal(result.formCount, 1);
  assert.equal(result.unassignedFieldCount, 1);
  assert.deepEqual(result.requests[0].parameters, { inside: "" });
});

test("JSP parser skips Struts targets with dynamic namespaces", () => {
  const result = parseJsp([
    '<s:form action="save" namespace="${bean.namespace}"></s:form>',
    '<s:url action="review" namespace="%{#request.namespace}" />',
    '<s:a action="cancel" namespace="/order">Cancel</s:a>',
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [
    ["link", "/order/cancel.action"],
  ]);
});

test("JSP parser treats Struts anchor values as labels instead of URLs", () => {
  const result = parseJsp([
    '<s:a action="save" namespace="/order" value="Save order" />',
    '<s:a href="/order/help.action" value="Help" />',
    '<s:a value="Label only" />',
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [
    ["link", "/order/save.action"],
    ["link", "/order/help.action"],
  ]);
});
