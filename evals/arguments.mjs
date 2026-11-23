/** Exact values and omitted filters are both part of a tool-choice contract. */
export function wrongArguments(testCase, args = {}) {
  return [
    ...Object.entries(testCase.expectArgs ?? {})
      .filter(([key, value]) => args[key] !== value)
      .map(([key]) => key),
    ...(testCase.absentArgs ?? []).filter((key) => Object.hasOwn(args, key)),
  ];
}

/** Keep MCP's optional fields optional through OpenRouter's OpenAI adapter. */
export function functionTool(name, description, parameters) {
  return {
    type: "function",
    function: { name, description, parameters, strict: false },
  };
}
