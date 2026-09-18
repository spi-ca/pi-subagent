export type JUnitTestOutcome = { tests: number; passed: number; skipped: number; failures: number; errors: number };

const XML_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;

function invalid(): never { throw new Error("invalid JUnit reporter outcome"); }

function validEntities(value: string): boolean {
	for (let index = value.indexOf("&"); index >= 0; index = value.indexOf("&", index + 1)) {
		const end = value.indexOf(";", index + 1);
		if (end < 0) return false;
		const entity = value.slice(index + 1, end);
		if (!/^(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+)$/.test(entity)) return false;
		index = end;
	}
	return true;
}

function tagEnd(xml: string, start: number): number {
	let quote: string | undefined;
	for (let index = start; index < xml.length; index += 1) {
		const character = xml[index]!;
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "\"" || character === "'") quote = character;
		else if (character === ">") return index;
	}
	return -1;
}

function parseStartTag(source: string): { name: string; attributes: Map<string, string>; selfClosing: boolean } {
	let index = 0;
	const nameMatch = XML_NAME.exec(source.slice(index));
	if (!nameMatch) return invalid();
	const name = nameMatch[0];
	index += name.length;
	const attributes = new Map<string, string>();
	while (index < source.length) {
		const whitespace = /^\s+/.exec(source.slice(index));
		if (whitespace) index += whitespace[0].length;
		if (source.slice(index) === "/") return { name, attributes, selfClosing: true };
		if (index === source.length) return { name, attributes, selfClosing: false };
		const attributeMatch = XML_NAME.exec(source.slice(index));
		if (!attributeMatch) return invalid();
		const attribute = attributeMatch[0];
		index += attribute.length;
		if (source[index] !== "=") return invalid();
		index += 1;
		const quote = source[index];
		if (quote !== "\"" && quote !== "'") return invalid();
		const end = source.indexOf(quote, index + 1);
		if (end < 0) return invalid();
		const value = source.slice(index + 1, end);
		if (value.includes("<") || !validEntities(value) || attributes.has(attribute)) return invalid();
		attributes.set(attribute, value);
		index = end + 1;
	}
	return { name, attributes, selfClosing: false };
}

/**
 * Bounded callers use this dependency-free structural parser before trusting
 * the JUnit suite totals. It accepts Bun's optional `errors` count as zero.
 */
export function parseJUnitXml(xml: string): JUnitTestOutcome {
	const stack: string[] = [];
	let rootAttributes: Map<string, string> | undefined;
	let rootClosed = false;
	let position = 0;
	while (position < xml.length) {
		const next = xml.indexOf("<", position);
		const text = xml.slice(position, next < 0 ? xml.length : next);
		if (!validEntities(text) || (stack.length === 0 && text.trim() !== "")) return invalid();
		if (next < 0) break;
		if (xml.startsWith("<!--", next)) {
			const end = xml.indexOf("-->", next + 4);
			if (end < 0 || xml.slice(next + 4, end).includes("--")) return invalid();
			position = end + 3;
			continue;
		}
		if (xml.startsWith("<![CDATA[", next)) {
			const end = xml.indexOf("]]>", next + 9);
			if (end < 0 || stack.length === 0) return invalid();
			position = end + 3;
			continue;
		}
		if (xml.startsWith("<?", next)) {
			const end = xml.indexOf("?>", next + 2);
			if (end < 0) return invalid();
			position = end + 2;
			continue;
		}
		if (xml.startsWith("<!", next)) return invalid(); // DTD/entity expansion is intentionally unsupported.
		const end = tagEnd(xml, next + 1);
		if (end < 0) return invalid();
		const token = xml.slice(next + 1, end);
		if (token.startsWith("/")) {
			const closing = /^\/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*$/.exec(token);
			if (!closing || stack.pop() !== closing[1]) return invalid();
			if (stack.length === 0) rootClosed = true;
		} else {
			if (rootClosed) return invalid();
			const tag = parseStartTag(token);
			if (stack.length === 0) {
				if (rootAttributes || tag.name !== "testsuites") return invalid();
				rootAttributes = tag.attributes;
			}
			if (!tag.selfClosing) stack.push(tag.name);
			else if (stack.length === 0) rootClosed = true;
		}
		position = end + 1;
	}
	if (!rootAttributes || !rootClosed || stack.length !== 0) return invalid();
	const number = (name: string, optional = false): number => {
		const value = rootAttributes!.get(name);
		if (value === undefined) {
			if (optional) return 0;
			return invalid();
		}
		if (!/^\d+$/.test(value)) return invalid();
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 0) return invalid();
		return parsed;
	};
	const tests = number("tests"), skipped = number("skipped"), failures = number("failures"), errors = number("errors", true);
	if (tests < skipped + failures + errors) return invalid();
	return { tests, skipped, failures, errors, passed: tests - skipped - failures - errors };
}
