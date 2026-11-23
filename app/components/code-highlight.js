import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import rehypeHighlight from "rehype-highlight";

/**
 * Plain JavaScript with a hand-written `code-highlight.d.ts`, on purpose:
 * highlight.js's own types declare `/// <reference lib="dom" />`, and any
 * TypeScript import of it, even through rehype-highlight and lowlight, puts
 * the DOM library over the Workers types for the whole program.
 *
 * Syntax colours for fenced code in rendered Markdown. A fence is coloured
 * only when it names its language; nothing is guessed, because detection
 * runs every grammar over every block. The grammars are the languages agents
 * write in this console's sessions, not highlight.js's whole set, to keep the
 * route's bundle small. The colours are roles in `styles/valise.css`
 * (`.hljs-*`), so both themes follow.
 */
export const highlightCode = [
  [
    rehypeHighlight,
    {
      detect: false,
      languages: {
        bash,
        css,
        diff,
        go,
        ini,
        javascript,
        json,
        markdown,
        python,
        rust,
        shell,
        sql,
        typescript,
        xml,
        yaml,
      },
      aliases: {
        bash: ["sh", "zsh", "console"],
        ini: ["toml"],
        javascript: ["js", "jsx", "mjs", "cjs"],
        typescript: ["ts", "tsx", "mts"],
        xml: ["html", "svg"],
        yaml: ["yml"],
      },
    },
  ],
];
