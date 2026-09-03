/**
 * Language mapping for the Codeium `document.language` (numeric enum) and
 * `document.editor_language` (raw string) fields. Both are required — Codeium
 * routes to a model using the enum, and passes the string through for context.
 *
 * See spec §7. Unknown languages map to `unspecified` (0) / "unspecified".
 */

/** Aliases applied before the enum lookup so editor ids resolve to Codeium ids. */
const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "shell",
  sh: "shell",
  cs: "csharp",
  javascriptreact: "javascript",
  objc: "objectivec",
  proto: "protobuf",
  make: "makefile",
  dosini: "ini",
  coffee: "coffeescript",
  cuda: "cudacpp",
  raku: "perl",
  text: "plaintext",
  tex: "latex",
};

/** Codeium's numeric language enum (§7). */
const LANGUAGE_ENUM: Record<string, number> = {
  unspecified: 0,
  c: 1,
  clojure: 2,
  coffeescript: 3,
  cpp: 4,
  csharp: 5,
  css: 6,
  cudacpp: 7,
  dockerfile: 8,
  go: 9,
  groovy: 10,
  handlebars: 11,
  haskell: 12,
  hcl: 13,
  html: 14,
  ini: 15,
  java: 16,
  javascript: 17,
  json: 18,
  julia: 19,
  kotlin: 20,
  latex: 21,
  less: 22,
  lua: 23,
  makefile: 24,
  markdown: 25,
  objectivec: 26,
  objectivecpp: 27,
  perl: 28,
  php: 29,
  plaintext: 30,
  protobuf: 31,
  pbtxt: 32,
  python: 33,
  r: 34,
  ruby: 35,
  rust: 36,
  sass: 37,
  scala: 38,
  scss: 39,
  shell: 40,
  sql: 41,
  starlark: 42,
  swift: 43,
  typescriptreact: 44,
  typescript: 45,
  visualbasic: 46,
  vue: 47,
  xml: 48,
  xsl: 49,
  yaml: 50,
  svelte: 51,
  toml: 52,
  dart: 53,
  rst: 54,
  ocaml: 55,
  cmake: 56,
  pascal: 57,
  elixir: 58,
  fsharp: 59,
  lisp: 60,
  matlab: 61,
  ps1: 62,
  solidity: 63,
  ada: 64,
  blade: 84,
  astro: 85,
};

export interface CodeiumLanguage {
  /** Numeric enum for model routing. */
  language: number;
  /** Raw string Codeium echoes for context; "unspecified" when unknown. */
  editorLanguage: string;
}

/**
 * Maps a Monaco language id to Codeium's `{ language, editorLanguage }`.
 * Applies aliases first; unknown ids collapse to `unspecified` (0).
 */
export function toCodeiumLanguage(languageId?: string): CodeiumLanguage {
  if (!languageId) return { language: 0, editorLanguage: "unspecified" };

  const normalized = languageId.trim().toLowerCase();
  const canonical = LANGUAGE_ALIASES[normalized] ?? normalized;
  const language = LANGUAGE_ENUM[canonical];

  if (language === undefined) {
    return { language: 0, editorLanguage: "unspecified" };
  }
  return { language, editorLanguage: canonical };
}
