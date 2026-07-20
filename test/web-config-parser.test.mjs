import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseSpringConfig, parseStrutsConfig, parseWebXml } from "../src/parsers/web-config.mjs";

async function fixture(relativePath) {
  return readFile(new URL(`./fixtures/legacy-shop/${relativePath}`, import.meta.url), "utf8");
}

test("web.xml parser joins servlet declarations to URL mappings without resolving DTDs", async () => {
  const content = await fixture("WEB-INF/web.xml");
  const result = parseWebXml(content, "WEB-INF/web.xml");

  assert.deepEqual(result.servlets.map(({ name, className }) => [name, className]), [
    ["legacyReport", "com.acme.web.LegacyReportServlet"],
    ["apiServlet", "com.acme.api.ApiServlet"],
  ]);
  assert.deepEqual(result.routes.map(({ url, targetClass, source }) => [url, targetClass, source]), [
    ["/report/export.do", "com.acme.web.LegacyReportServlet", "servlet"],
    ["/api/*", "com.acme.api.ApiServlet", "servlet"],
  ]);
  assert.equal(result.routes[0].evidence.line, 8);
  assert.deepEqual(result.warnings, []);
});

test("Struts parser extracts actions and forwards with normalized .do routes", async () => {
  const content = await fixture("WEB-INF/struts-config.xml");
  const result = parseStrutsConfig(content, "WEB-INF/struts-config.xml");

  assert.deepEqual(
    result.actions.map(({ path, url, type, formName, parameter }) => [path, url, type, formName, parameter]),
    [["/order/audit", "/order/audit.do", "com.acme.order.web.OrderAuditAction", "orderAuditForm", "method"]],
  );
  assert.deepEqual(result.actions[0].forwards.map(({ name, path }) => [name, path]), [
    ["success", "/order/auditSuccess.jsp"],
    ["error", "/order/audit.jsp"],
  ]);
  assert.equal(result.actions[0].evidence.line, 5);
});

test("Spring XML parser extracts beans and SimpleUrlHandlerMapping routes", async () => {
  const content = await fixture("WEB-INF/applicationContext.xml");
  const result = parseSpringConfig(content, "WEB-INF/applicationContext.xml");

  assert.deepEqual(result.beans.map(({ id, className }) => [id, className]), [
    ["orderAuditService", "com.acme.order.service.impl.OrderAuditServiceImpl"],
    ["orderDao", "com.acme.order.dao.IbatisOrderDao"],
    ["legacyController", "com.acme.legacy.LegacyController"],
    ["ordinarySettings", "com.acme.config.OrdinarySettings"],
  ]);
  assert.deepEqual(result.routes.map(({ url, beanId, targetClass }) => [url, beanId, targetClass]), [
    ["/legacy/save.do", "legacyController", "com.acme.legacy.LegacyController"],
    ["/legacy/other.do", "legacyController", "com.acme.legacy.LegacyController"],
  ]);
  assert.equal(result.routes.some((route) => route.url === "/not-a-route"), false);
});

test("web.xml parser keeps complete facts and warns when XML is truncated", () => {
  const content = `<web-app>\n<servlet><servlet-name>report</servlet-name><servlet-class>com.acme.ReportServlet</servlet-class></servlet>\n<servlet-mapping><servlet-name>report</servlet-name><url-pattern>/report</url-pattern></servlet-mapping>`;

  const result = parseWebXml(content, "WEB-INF/broken-web.xml");

  assert.deepEqual(result.routes.map(({ url, targetClass }) => [url, targetClass]), [
    ["/report", "com.acme.ReportServlet"],
  ]);
  assert.equal(result.warnings.some((warning) => warning.includes("unclosed <web-app>")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("WEB-INF/broken-web.xml")), true);
});

test("Struts and Spring parsers warn about truncated root elements", () => {
  const struts = parseStrutsConfig("<struts-config><action path='/x' type='X'/>", "broken-struts.xml");
  const spring = parseSpringConfig("<beans><bean id='x' class='X'/>", "broken-spring.xml");

  assert.equal(struts.warnings.some((warning) => warning.includes("unclosed <struts-config>")), true);
  assert.equal(spring.warnings.some((warning) => warning.includes("unclosed <beans>")), true);
});
