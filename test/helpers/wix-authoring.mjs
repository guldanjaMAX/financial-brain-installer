import assert from "node:assert/strict";

// Parse the element/attribute-only WiX authoring used by this package without
// a platform tool or dependency download. Unsupported XML fails closed; this
// contract complements, and never substitutes for, WiX's native MSI validation.
export function parseWix(source) {
  const document = { tag: "document", attributes: {}, children: [] };
  const stack = [document];
  const tokens = /<!--[\s\S]*?-->|<\?xml\s[^?]*\?>|<\/[\w:.-]+\s*>|<[\w:.-]+(?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>/g;
  let cursor = 0;
  for (const match of source.matchAll(tokens)) {
    assert.equal(source.slice(cursor, match.index).trim(), "", "unsupported WiX XML");
    cursor = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      assert.ok(stack.length > 1, "unmatched XML closing tag");
      assert.equal(stack.pop().tag, token.slice(2, -1).trim(), "mismatched XML closing tag");
      continue;
    }
    const tag = /^<([\w:.-]+)/.exec(token)[1];
    assert.doesNotMatch(tag, /:/, "namespace-prefixed WiX elements require explicit contract support");
    const attributes = {};
    for (const attribute of token.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      assert.ok(!Object.hasOwn(attributes, attribute[1]), "duplicate XML attribute");
      const raw = attribute[2] ?? attribute[3];
      assert.doesNotMatch(raw, /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/, "unsupported XML entity");
      attributes[attribute[1]] = raw.replace(/&([^;]+);/g, (_, entity) => {
        if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
        if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
        return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity];
      });
    }
    const element = { tag, attributes, children: [] };
    stack.at(-1).children.push(element);
    if (!token.endsWith("/>")) stack.push(element);
  }
  assert.equal(source.slice(cursor).trim(), "", "unsupported trailing XML");
  assert.equal(stack.length, 1, "unclosed XML element");
  assert.equal(document.children.length, 1, "one WiX document required");
  const root = document.children[0];
  assert.equal(root.tag, "Wix");
  assert.equal(root.attributes.xmlns, "http://wixtoolset.org/schemas/v4/wxs");
  return root;
}

export function inspectPerUserWix(source) {
  const root = parseWix(source);
  const directories = [], components = [], removals = [], issues = [];
  const packages = root.children.filter((element) => element.tag === "Package");
  assert.equal(packages.length, 1, "one Package required");
  assert.equal(root.children.length, 1, "additional WiX fragments require explicit contract support");
  assert.equal(packages[0].attributes.Scope, "perUser", "ICE91 warnings are valid only for the fixed per-user scope");
  const visit = (element, directory, component) => {
    const attrs = element.attributes;
    if (element.tag === "StandardDirectory") {
      // New destination roots require an explicit footprint review, never an
      // implicit exemption from the per-user directory/component checks.
      assert.ok(["LocalAppDataFolder", "ProgramMenuFolder"].includes(attrs.Id), "unreviewed directory root");
      directory = attrs.Id;
    }
    if (element.tag === "Directory") {
      assert.ok(directory, "directory outside a reviewed user root");
      directory = attrs.Id;
      assert.ok(directory, "directory Id required");
      directories.push(directory);
    }
    if (element.tag === "Component") {
      component = { id: attrs.Id, directory: attrs.Directory ?? directory, keys: [], registry: [] };
      components.push(component);
      if (attrs.KeyPath === "yes") component.keys.push(element);
    }
    if (component && element.tag !== "Component" && attrs.KeyPath === "yes") component.keys.push(element);
    if (component && element.tag === "RegistryValue") component.registry.push(attrs);
    if (element.tag === "RemoveFolder") {
      removals.push({ directory: attrs.Directory ?? component?.directory, on: attrs.On, component, property: attrs.Property });
    }
    for (const child of element.children) visit(child, directory, component);
  };
  visit(packages[0]);
  assert.ok(directories.length > 0 && components.length > 0, "directory and component decisions must be reached");
  assert.equal(new Set(directories).size, directories.length, "duplicate directory Id");
  assert.equal(new Set(components.map((component) => component.id)).size, components.length, "duplicate component Id");
  const registryIdentities = new Set();
  for (const component of components) {
    const key = component.keys[0];
    if (!directories.includes(component.directory) || component.keys.length !== 1 ||
        key?.tag !== "RegistryValue" || key.attributes.Root !== "HKCU" ||
        !key.attributes.Key || !key.attributes.Name) {
      issues.push(`ICE38/ICE43: ${component.id} needs exactly one HKCU registry KeyPath`);
    }
    for (const value of component.registry) {
      if (value.Root !== "HKCU") issues.push(`ICE57: ${component.id} mixes per-user files with machine registry state`);
      const identity = JSON.stringify([value.Root, value.Key, value.Name].map((part) => part?.toLowerCase()));
      if (registryIdentities.has(identity)) issues.push(`Shared registry marker: ${component.id}`);
      registryIdentities.add(identity);
    }
  }
  for (const directory of directories) {
    if (!removals.some((removal) => removal.component && removal.directory === directory &&
        !removal.property && removal.on === "uninstall")) {
      issues.push(`ICE64: ${directory} needs an uninstall RemoveFolder in a component`);
    }
  }
  return { directories, components, issues };
}
