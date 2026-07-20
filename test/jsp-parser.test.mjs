import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractJavaScriptRequests, parseJsp } from "../src/parsers/jsp.mjs";

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
    ["orderId", "${order.id}"],
    ["method", "audit"],
    ["decision", ""],
  ]);
  assert.deepEqual(result.requests[0].parameters, { method: "audit", orderId: "${order.id}" });
  assert.deepEqual(result.requests[0].evidence, {
    file: "web/order/audit.jsp",
    line: 8,
    column: 24,
    snippet: '<form id="auditForm" action="${pageContext.request.contextPath}/order/audit.do" method="post">',
  });
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

test("JSP parser resolves relative actions and ignores external or javascript links", () => {
  const content = `<form action="save.do"></form><a href="https://example.com/x">external</a><a href="javascript:submitForm()">script</a>`;
  const result = parseJsp(content, "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [["form", "/order/save.do"]]);
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
  assert.deepEqual(result.requests[0].parameters, { method: "audit" });
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
    '<form action="${pageContext.request.contextPath}/order/save.do"></form>',
  ].join("\n"), "WebRoot/order/edit.jsp");

  assert.deepEqual(result.requests.map(({ kind, url }) => [kind, url]), [
    ["form", "/order/save.do"],
  ]);
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
