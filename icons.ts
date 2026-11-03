// File-type icons: small SVG glyphs used as CSS masks (so they take the type's color, light and dark).
// Allowed by the page CSP (img-src data:). No external files, no scripts.

const W = (inner: string) =>
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='#000' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'>${inner}</svg>`;
const DOC = "M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3";

export const GLYPHS: Record<string, string> = {
  dir: "<path d='M1.5 4.2c0-.6.4-1 1-1h3.4l1.6 1.7h6c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1z' fill='#000' fill-opacity='.3'/>",
  text: `<path d='${DOC} M5.6 8h4.8 M5.6 10.3h4.8 M5.6 12.6h3'/>`,
  md: "<rect x='1' y='3.5' width='14' height='9' rx='1.6'/><path d='M3.6 10V6l2 2.3 2-2.3v4 M11.6 6v4 M9.9 8.4l1.7 1.7 1.7-1.7'/>",
  html: "<path d='M5 4.5 1.5 8 5 11.5 M11 4.5 14.5 8 11 11.5 M9.3 3 6.7 13'/>",
  code: "<path d='M5.5 2.5c-1.6 0-2 .8-2 2v1.6c0 .9-.5 1.6-1.6 1.9 1.1.3 1.6 1 1.6 1.9v1.6c0 1.2.4 2 2 2 M10.5 2.5c1.6 0 2 .8 2 2v1.6c0 .9.5 1.6 1.6 1.9-1.1.3-1.6 1-1.6 1.9v1.6c0 1.2-.4 2-2 2'/>",
  shell: "<rect x='1.5' y='2.5' width='13' height='11' rx='1.6'/><path d='M4.5 6.2 6.8 8l-2.3 1.8 M8.6 10.3h3'/>",
  config: "<path d='M2 4.5h12 M2 8h12 M2 11.5h12'/><circle cx='5' cy='4.5' r='1.6' fill='#000'/><circle cx='10.6' cy='8' r='1.6' fill='#000'/><circle cx='7' cy='11.5' r='1.6' fill='#000'/>",
  image: "<rect x='1.5' y='2.5' width='13' height='11' rx='1.6'/><circle cx='5.5' cy='6.2' r='1.3'/><path d='M2 12.2l4-4 3 3 2-2 3.5 3.3'/>",
  pdf: `<path d='${DOC}'/><rect x='1.6' y='8' width='9.4' height='4.6' rx='.9' fill='#000' stroke='none'/>`,
  table: "<rect x='1.5' y='2.5' width='13' height='11' rx='1.6'/><path d='M1.5 6.3h13 M1.5 9.8h13 M6.2 2.5v11'/>",
  archive: "<rect x='2.5' y='1.5' width='11' height='13' rx='1.6'/><path d='M7.2 3h1.6 M8 4.6h1.6 M7.2 6.2h1.6 M8 7.8h1.6'/><rect x='6.8' y='9.4' width='2.4' height='2.8' rx='.5'/>",
  diff: "<path d='M8 2.5v6 M5 5.5h6 M5 12.5h6'/>",
  db: "<ellipse cx='8' cy='3.8' rx='5.5' ry='2'/><path d='M2.5 3.8v8.4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V3.8 M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2'/>",
  lock: "<rect x='3' y='7' width='10' height='7.5' rx='1.4'/><path d='M5.3 7V5a2.7 2.7 0 0 1 5.4 0v2'/>",
  media: "<rect x='1.5' y='2.5' width='13' height='11' rx='1.6'/><path d='M6.5 5.6v4.8L10.5 8z' fill='#000'/>",
};

// Colors: mid-tones that read on both the light and the dark theme. No color = muted text color.
const COLORS: Record<string, string> = {
  md: "#4e94ce", html: "#e44d26", xml: "#e37933", ts: "#3a86d4", js: "#d4a72c", py: "#3d7cc9", go: "#00a7d0",
  rs: "#d0763b", rb: "#d0453b", php: "#7a7fc0", java: "#c07a2a", kt: "#9a6cf0", swift: "#f05138", c: "#5c8bd6",
  cs: "#9a5cc0", vue: "#3fb27f", svelte: "#ff5a1f", css: "#8b5cf6", scss: "#c6538c", lua: "#5b6fd6", json: "#b8a03a",
  shell: "#4eaa25", config: "#7d8c99", docker: "#2496ed", tf: "#7b42bc", image: "#a074c4", pdf: "#e5484d",
  table: "#2da44e", archive: "#b38b59", diff: "#d29922", db: "#e38c00", media: "#d6409f", dir: "#c9a227",
};

type Kind = { glyph: keyof typeof GLYPHS; color?: string };
const BY_EXT: Record<string, Kind> = {};
const add = (exts: string, glyph: keyof typeof GLYPHS, color?: string) => { for (const e of exts.split(" ")) BY_EXT[e] = { glyph, color }; };
add("md markdown mdx", "md", "md");
add("html htm", "html", "html");
add("xml xsl plist", "html", "xml");
add("ts tsx mts cts", "code", "ts");
add("js jsx mjs cjs", "code", "js");
add("py pyi", "code", "py");
add("go", "code", "go");
add("rs", "code", "rs");
add("rb", "code", "rb");
add("php", "code", "php");
add("java", "code", "java");
add("kt kts", "code", "kt");
add("swift", "code", "swift");
add("c h cc cpp hpp", "code", "c");
add("cs", "code", "cs");
add("vue", "code", "vue");
add("svelte", "code", "svelte");
add("css", "code", "css");
add("scss sass less", "code", "scss");
add("lua", "code", "lua");
add("json jsonc jsonl json5 ndjson", "code", "json");
add("sh bash zsh fish cron ps1 bat cmd", "shell", "shell");
add("yml yaml toml ini conf cfg env properties service timer socket nginx editorconfig", "config", "config");
add("dockerfile", "config", "docker");
add("tf hcl", "config", "tf");
add("png jpg jpeg gif webp svg avif ico bmp heic tif tiff", "image", "image");
add("pdf", "pdf", "pdf");
add("csv tsv xlsx xls ods", "table", "table");
add("zip tar gz tgz xz bz2 7z rar zst", "archive", "archive");
add("diff patch", "diff", "diff");
add("sql sqlite db", "db", "db");
add("mp4 mov webm mkv mp3 wav m4a ogg flac", "media", "media");
add("lock", "lock");
add("txt log text rst adoc org", "text");

const BY_NAME: Record<string, Kind> = {
  makefile: { glyph: "shell", color: "shell" }, justfile: { glyph: "shell", color: "shell" },
  ".gitignore": { glyph: "config", color: "config" }, ".gitattributes": { glyph: "config", color: "config" },
  ".dockerignore": { glyph: "config", color: "docker" }, ".editorconfig": { glyph: "config", color: "config" },
  "package-lock.json": { glyph: "lock" }, "pnpm-lock.yaml": { glyph: "lock" }, "yarn.lock": { glyph: "lock" }, "bun.lockb": { glyph: "lock" },
};

export function iconFor(rel: string, ext: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  const k = BY_NAME[base] ?? BY_EXT[ext] ?? (base.startsWith(".env.") ? BY_EXT.env : undefined) ?? { glyph: "text" as const };
  return `<span class="fi fi-${k.glyph}${k.color ? ` c-${k.color}` : ""}" aria-hidden="true"></span>`;
}
export const DIR_ICON = `<span class="fi fi-dir c-dir" aria-hidden="true"></span>`;

export const ICON_CSS =
  `.fi { display:inline-block; width:16px; height:16px; flex:none; background:currentColor; color:var(--muted); vertical-align:-3px; -webkit-mask:var(--i) center/contain no-repeat; mask:var(--i) center/contain no-repeat; }\n` +
  Object.entries(GLYPHS).map(([k, g]) => `.fi-${k} { --i:url("data:image/svg+xml,${encodeURIComponent(W(g))}"); }`).join("\n") + "\n" +
  Object.entries(COLORS).map(([k, c]) => `.fi.c-${k} { color:${c}; }`).join("\n") + "\n";

// For the preview sheet only.
export const svgFor = (glyph: string) => W(GLYPHS[glyph]);
