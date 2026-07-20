import { createEvidenceLocator } from "../evidence.mjs";
import { findXmlElements, findXmlText, withoutXmlComments, xmlStructureWarnings } from "./xml-utils.mjs";

function webConfigContext(content, filePath, context = {}) {
  const source = context.source ?? withoutXmlComments(content);
  const locator = context.locator ?? createEvidenceLocator(source, filePath);
  locator.assertSource(source, filePath);
  return { source, locator };
}

export function createWebConfigContext(content, filePath) {
  return webConfigContext(content, filePath);
}

function strutsUrl(path) {
  if (!path) return "";
  return /\.[a-z0-9]+$/i.test(path) ? path : `${path}.do`;
}

export function parseWebXml(content, filePath, context) {
  const { source, locator } = webConfigContext(content, filePath, context);
  const servlets = findXmlElements(source, "servlet", filePath, locator)
    .map((element) => ({
      name: findXmlText(element.inner, "servlet-name"),
      className: findXmlText(element.inner, "servlet-class"),
      evidence: element.evidence,
    }))
    .filter((servlet) => servlet.name && servlet.className);
  const classByName = new Map(servlets.map((servlet) => [servlet.name, servlet.className]));
  const routes = [];
  for (const mapping of findXmlElements(source, "servlet-mapping", filePath, locator)) {
    const servletName = findXmlText(mapping.inner, "servlet-name");
    const urlPattern = findXmlText(mapping.inner, "url-pattern");
    if (!servletName || !urlPattern) continue;
    routes.push({
      url: urlPattern,
      servletName,
      targetClass: classByName.get(servletName) ?? "",
      source: "servlet",
      evidence: mapping.evidence,
    });
  }
  return { servlets, routes, warnings: xmlStructureWarnings(content, filePath, "web-app") };
}

export function parseStrutsConfig(content, filePath, context) {
  const { source, locator } = webConfigContext(content, filePath, context);
  const actions = [];
  for (const element of findXmlElements(source, "action", filePath, locator)) {
    const { path, type, name: formName = "", parameter = "" } = element.attributes;
    if (!path || !type) continue;
    const innerOffset = element.offset + element.raw.indexOf(">") + 1;
    const forwards = findXmlElements(element.inner, "forward", filePath).map((forward) => ({
      name: forward.attributes.name ?? "",
      path: forward.attributes.path ?? "",
      evidence: locator.at(innerOffset + forward.offset, forward.raw.length),
    }));
    actions.push({
      path,
      url: strutsUrl(path),
      type,
      formName,
      parameter,
      forwards,
      evidence: element.evidence,
    });
  }
  return { actions, warnings: xmlStructureWarnings(content, filePath, "struts-config") };
}

function joinedUrl(namespace, name, extension) {
  const prefix = namespace && namespace !== "/" ? `/${namespace.replace(/^\/+|\/+$/g, "")}` : "";
  const action = String(name ?? "").replace(/^\/+/, "");
  return `${prefix}/${action}${action.toLowerCase().endsWith(extension.toLowerCase()) ? "" : extension}`.replace(/\/{2,}/g, "/");
}

function struts2ActionExtension(source, filePath, locator) {
  const constants = findXmlElements(source, "constant", filePath, locator)
    .filter((element) => element.attributes.name?.toLowerCase() === "struts.action.extension");
  if (constants.length === 0) return ".action";

  const value = constants.at(-1).attributes.value
    ?? constants.at(-1).inner.replace(/<[^>]+>/g, "").trim();
  const extension = String(value).split(",")[0].trim().replace(/^\.+/, "");
  return extension ? `.${extension}` : "";
}

export function parseStruts2Config(content, filePath, context) {
  const { source, locator } = webConfigContext(content, filePath, context);
  const extension = struts2ActionExtension(source, filePath, locator);
  const actions = [];
  for (const packageElement of findXmlElements(source, "package", filePath, locator)) {
    const namespace = packageElement.attributes.namespace ?? "";
    for (const action of findXmlElements(packageElement.inner, "action", filePath)) {
      const name = action.attributes.name ?? "";
      const className = action.attributes.class ?? "";
      if (!name || !className) continue;
      const packageInnerOffset = packageElement.offset + packageElement.raw.indexOf(">") + 1;
      const actionOffset = packageInnerOffset + action.offset;
      const actionInnerOffset = actionOffset + action.raw.indexOf(">") + 1;
      const results = findXmlElements(action.inner, "result", filePath).map((result) => {
        const resultOffset = actionInnerOffset + result.offset;
        const params = Object.fromEntries(
          findXmlElements(result.inner, "param", filePath)
            .map((param) => [param.attributes.name ?? "", param.inner.replace(/<[^>]+>/g, "").trim()])
            .filter(([name, value]) => name && value),
        );
        const resultText = result.inner
          .replace(/<param\b[^>]*>[\s\S]*?<\/param\s*>/gi, " ")
          .replace(/<param\b[^>]*\/\s*>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .trim();
        return {
          name: result.attributes.name ?? "success",
          type: result.attributes.type ?? "",
          path: params.actionName ?? resultText,
          actionName: params.actionName ?? "",
          namespace: params.namespace ?? "",
          evidence: locator.at(resultOffset, result.raw.length),
        };
      });
      actions.push({
        name,
        namespace,
        extension,
        url: joinedUrl(namespace, name, extension),
        className,
        method: action.attributes.method ?? "execute",
        methodExplicit: Object.hasOwn(action.attributes, "method"),
        results,
        evidence: locator.at(actionOffset, action.raw.length),
      });
    }
  }
  return { actions, warnings: xmlStructureWarnings(content, filePath, "struts") };
}

export function parseTilesDefinitions(content, filePath, context) {
  const { source, locator } = webConfigContext(content, filePath, context);
  const definitions = [];
  for (const definition of findXmlElements(source, "definition", filePath, locator)) {
    const name = definition.attributes.name ?? "";
    if (!name) continue;
    const definitionInnerOffset = definition.offset + definition.raw.indexOf(">") + 1;
    const puts = ["put", "put-attribute"].flatMap((tag) => findXmlElements(definition.inner, tag, filePath))
      .map((put) => {
        const offset = definitionInnerOffset + put.offset;
        return {
          name: put.attributes.name ?? "",
          value: put.attributes.value ?? put.inner.replace(/<[^>]+>/g, "").trim(),
          evidence: locator.at(offset, put.raw.length),
          offset,
        };
      })
      .filter((put) => put.name && put.value)
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset: _offset, ...put }) => put);
    definitions.push({
      name,
      extendsName: definition.attributes.extends ?? "",
      template: definition.attributes.template ?? "",
      puts,
      evidence: definition.evidence,
    });
  }
  return { definitions, warnings: xmlStructureWarnings(content, filePath, "tiles-definitions") };
}

export function parseSpringConfig(content, filePath, context) {
  const { source, locator } = webConfigContext(content, filePath, context);
  const beanElements = findXmlElements(source, "bean", filePath, locator);
  const beans = beanElements
    .map((element) => ({
      id: element.attributes.id ?? element.attributes.name ?? "",
      className: element.attributes.class ?? "",
      evidence: element.evidence,
    }))
    .filter((bean) => bean.id && bean.className);
  const classById = new Map(beans.map((bean) => [bean.id, bean.className]));
  const routes = [];
  for (const handler of beanElements.filter((element) => /(?:^|\.)SimpleUrlHandlerMapping$/.test(element.attributes.class ?? ""))) {
    for (const property of findXmlElements(handler.inner, "property", filePath).filter((element) => element.attributes.name === "mappings")) {
      for (const match of property.inner.matchAll(/<prop\b[^>]*\bkey\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/prop\s*>/gi)) {
        const url = match[2].trim();
        const beanId = match[3].replace(/<[^>]+>/g, "").trim();
        if (!url.startsWith("/") || !beanId) continue;
        const absoluteOffset = handler.offset + handler.raw.indexOf(match[0]);
        routes.push({
          url,
          beanId,
          targetClass: classById.get(beanId) ?? "",
          source: "spring-simple-url",
          evidence: locator.at(absoluteOffset, match[0].length),
          offset: absoluteOffset,
        });
      }
      for (const entry of findXmlElements(property.inner, "entry", filePath)) {
        const url = entry.attributes.key ?? entry.attributes["key-ref"] ?? "";
        const beanId = entry.attributes["value-ref"] ?? entry.attributes.value ?? "";
        if (!url.startsWith("/") || !beanId) continue;
        const absoluteOffset = handler.offset + handler.raw.indexOf(entry.raw);
        routes.push({
          url,
          beanId,
          targetClass: classById.get(beanId) ?? "",
          source: "spring-simple-url",
          evidence: locator.at(absoluteOffset, entry.raw.length),
          offset: absoluteOffset,
        });
      }
    }
  }
  routes.sort((left, right) => left.offset - right.offset);
  return {
    beans,
    routes: routes.map(({ offset: _offset, ...route }) => route),
    warnings: xmlStructureWarnings(content, filePath, "beans"),
  };
}
