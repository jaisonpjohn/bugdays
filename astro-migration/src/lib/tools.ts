// Central registry of all tools.
// Single source of truth for the sidebar, the command palette (Cmd+K),
// and any future tool listings. Add new tools here.

export interface Tool {
  name: string;
  href: string;
  description: string;
  /** Extra search terms beyond the name (synonyms, abbreviations, typos people use) */
  keywords: string[];
}

export interface ToolGroup {
  name: string;
  href?: string;
  icon: string;
  alwaysOpen?: boolean;
  items: Tool[];
}

export const toolGroups: ToolGroup[] = [
  {
    name: "Popular",
    icon: "star",
    alwaysOpen: true,
    items: [
      { name: "JSON Formatter", href: "/json-formatter", description: "Format, validate & view JSON", keywords: ["prettify", "beautify", "validate", "minify", "tree"] },
      { name: "JSON Diff", href: "/json-diff", description: "Compare two JSON documents", keywords: ["compare", "difference"] },
      { name: "Text Diff", href: "/text-diff", description: "Compare two texts line by line", keywords: ["compare", "difference"] },
      { name: "Join Lines", href: "/join-lines", description: "Join lines with a delimiter", keywords: ["merge", "concatenate", "comma"] },
      { name: "Compare Lists", href: "/list-compare", description: "Set operations on two lists", keywords: ["intersection", "union", "difference", "set ops"] },
      { name: "GZip & Base64", href: "/gzip-base64", description: "Compress & encode text", keywords: ["compress", "decompress", "deflate", "zlib"] },
      { name: "Schema Explorer", href: "/schema-explorer", description: "DDL to ER diagram & data dictionary", keywords: ["erd", "database", "diagram"] },
      { name: "SOAP Client", href: "/soap-client", description: "Online WSDL tester & SOAP requests", keywords: ["wsdl", "xml", "web service", "soapui"] },
      { name: "Thread Dump Analyzer", href: "/thread-dump-analyzer", description: "Analyze jstack, jcmd & deadlocks", keywords: ["java", "jvm", "jstack", "jcmd", "blocked", "virtual threads"] },
    ]
  },
  {
    name: "JSON Tools",
    href: "/json-tools",
    icon: "braces",
    items: [
      { name: "JSON Formatter", href: "/json-formatter", description: "Format, validate & view JSON", keywords: ["prettify", "beautify", "validate", "minify", "tree", "jq"] },
      { name: "JSON Diff", href: "/json-diff", description: "Compare two JSON documents", keywords: ["compare", "difference"] },
      { name: "YAML ↔ JSON", href: "/yaml-json-converter", description: "Convert YAML to JSON and back", keywords: ["yml", "convert"] },
      { name: "CSV ↔ JSON", href: "/csv-json-converter", description: "Convert CSV to JSON and back", keywords: ["spreadsheet", "excel", "convert"] },
    ]
  },
  {
    name: "YAML Tools",
    href: "/yaml-tools",
    icon: "document",
    items: [
      { name: "YAML Viewer", href: "/yaml-formatter", description: "View, format & validate YAML", keywords: ["yml", "prettify", "validate"] },
      { name: "YAML Diff", href: "/yaml-diff", description: "Compare two YAML documents", keywords: ["yml", "compare"] },
      { name: "YAML ↔ JSON", href: "/yaml-json-converter", description: "Convert YAML to JSON and back", keywords: ["yml", "convert"] },
    ]
  },
  {
    name: "TOML Tools",
    href: "/toml-tools",
    icon: "config",
    items: [
      { name: "TOML Viewer", href: "/toml-viewer", description: "View, format & validate TOML", keywords: ["cargo", "pyproject", "validate"] },
      { name: "TOML Diff", href: "/toml-diff", description: "Compare two TOML documents", keywords: ["compare"] },
      { name: "TOML Converter", href: "/toml-converter", description: "Convert TOML to JSON/YAML", keywords: ["convert"] },
    ]
  },
  {
    name: "XML Tools",
    href: "/xml-tools",
    icon: "code",
    items: [
      { name: "XML Formatter", href: "/xml-formatter", description: "Format & validate XML", keywords: ["prettify", "beautify", "validate"] },
      { name: "XML ↔ JSON", href: "/xml-json-converter", description: "Convert XML to JSON and back", keywords: ["convert"] },
    ]
  },
  {
    name: "Encoding",
    href: "/encoding-tools",
    icon: "lock",
    items: [
      { name: "Base64", href: "/base64-encoder-decoder", description: "Encode & decode Base64", keywords: ["b64", "encode", "decode"] },
      { name: "URL Encoder", href: "/url-encoder", description: "Encode & decode URLs", keywords: ["percent encoding", "uri", "escape", "unescape"] },
      { name: "Image ↔ Base64", href: "/image-base64", description: "Convert images to Base64", keywords: ["data uri", "png", "jpg", "encode"] },
      { name: "GZip & Base64", href: "/gzip-base64", description: "Compress & encode text", keywords: ["compress", "decompress", "deflate", "zlib"] },
      { name: "QR Code", href: "/qr-code", description: "Generate & scan QR codes", keywords: ["barcode", "scanner"] },
    ]
  },
  {
    name: "Text Tools",
    href: "/text-tools",
    icon: "text",
    items: [
      { name: "Text Diff", href: "/text-diff", description: "Compare two texts line by line", keywords: ["compare", "difference"] },
      { name: "ASCII Table Converter", href: "/ascii-table-converter", description: "Terminal tables to HTML, CSV & Excel", keywords: ["terminal", "console", "box drawing", "unicode table", "xlsx", "spreadsheet", "word", "outlook", "pdf"] },
      { name: "ASCII Table Generator", href: "/ascii-table-generator", description: "CSV, JSON & HTML to terminal tables", keywords: ["table maker", "unicode table", "markdown table", "postgres", "tsv", "text table"] },
      { name: "Case Converter", href: "/case-converter", description: "camelCase, snake_case & more", keywords: ["uppercase", "lowercase", "kebab", "pascal", "title"] },
      { name: "Join Lines", href: "/join-lines", description: "Join lines with a delimiter", keywords: ["merge", "concatenate", "comma"] },
      { name: "Split Text", href: "/split-text", description: "Split text by a delimiter", keywords: ["explode", "lines"] },
      { name: "Sort Lines", href: "/sort-lines", description: "Sort lines alphabetically", keywords: ["order", "alphabetize", "reverse"] },
      { name: "Remove Dupes", href: "/remove-duplicate-lines", description: "Remove duplicate lines", keywords: ["dedupe", "unique", "distinct"] },
      { name: "Compare Lists", href: "/list-compare", description: "Set operations on two lists", keywords: ["intersection", "union", "difference", "set ops"] },
      { name: "Text Extractor", href: "/text-extractor", description: "Extract text from large files", keywords: ["grep", "filter", "log"] },
      { name: "Regex Tester", href: "/regex-tester", description: "Test regular expressions", keywords: ["regexp", "pattern", "match", "grep"] },
    ]
  },
  {
    name: "Security",
    href: "/security-tools",
    icon: "shield",
    items: [
      { name: "Hash Generator", href: "/hash-generator", description: "MD5, SHA-1, SHA-256 & more", keywords: ["md5", "sha", "checksum", "digest"] },
      { name: "Certificate Inspector", href: "/certificate-inspector", description: "Inspect & convert X.509 certificates", keywords: ["ssl", "tls", "x509", "pem", "der", "cer", "crt", "p7b", "pkcs7", "certificate decoder"] },
      { name: "JWT Decoder", href: "/jwt-decoder", description: "Decode & inspect JWT tokens", keywords: ["token", "json web token", "claims"] },
      { name: "Password Gen", href: "/password-generator", description: "Generate strong passwords", keywords: ["random", "secure", "passphrase"] },
      { name: "DBeaver Decrypt", href: "/dbeaver-password-decrypter", description: "Recover credentials-config.json", keywords: ["credentials", "recover", "database"] },
    ]
  },
  {
    name: "Converters",
    href: "/converter-tools",
    icon: "arrows",
    items: [
      { name: "DateTime", href: "/datetime-converter", description: "Epoch, ISO & timezone conversion", keywords: ["epoch", "unix timestamp", "iso 8601", "timezone", "utc"] },
      { name: "Color", href: "/color-converter", description: "HEX, RGB, HSL conversion", keywords: ["hex", "rgb", "hsl", "picker"] },
      { name: "Protobuf", href: "/protobuf-converter", description: "Decode & convert Protobuf", keywords: ["proto", "protocol buffers", "grpc"] },
      { name: "Avro", href: "/avro-converter", description: "Decode & convert Avro", keywords: ["schema", "kafka"] },
      { name: "TOON", href: "/toon-converter", description: "Convert JSON to TOON format", keywords: ["token oriented object notation", "llm"] },
      { name: "Unix Perms", href: "/unix-permissions", description: "chmod permission calculator", keywords: ["chmod", "755", "rwx", "file permissions", "octal"] },
    ]
  },
  {
    name: "Database",
    href: "/database-tools",
    icon: "database",
    items: [
      { name: "Schema Explorer", href: "/schema-explorer", description: "ER diagram & data dictionary from DDL", keywords: ["erd", "er diagram", "entity relationship", "table relationships", "data dictionary", "postgres", "mysql", "oracle", "db2", "sql server", "ddl", "annotate"] },
      { name: "DBeaver Decrypt", href: "/dbeaver-password-decrypter", description: "Recover credentials-config.json", keywords: ["credentials", "recover", "database"] },
    ]
  },
  {
    name: "JVM Diagnostics",
    href: "/jvm-tools",
    icon: "activity",
    items: [
      { name: "Thread Dump Analyzer", href: "/thread-dump-analyzer", description: "Analyze jstack, jcmd & virtual threads", keywords: ["java", "jvm", "jstack", "jcmd", "thread dump", "deadlock", "blocked", "virtual threads", "hotspot", "openjdk"] },
    ]
  },
  {
    name: "Network",
    href: "/network-tools",
    icon: "globe",
    items: [
      { name: "CIDR Calculator", href: "/cidr-calculator", description: "Subnet & IP range calculator", keywords: ["subnet", "netmask", "ip range"] },
      { name: "API Client", href: "/api-client", description: "Send HTTP requests from the browser", keywords: ["http", "rest", "postman", "curl", "request"] },
      { name: "Bulk API Invoker", href: "/bulk-api-invoker", description: "Run templated API requests from CSV", keywords: ["batch", "http", "csv", "runner"] },
      { name: "SOAP Client", href: "/soap-client", description: "Online WSDL tester & SOAP requests", keywords: ["wsdl", "xml", "web service", "soapui", "soap 1.1", "soap 1.2"] },
      { name: "gRPC Client", href: "/grpc-client", description: "Call gRPC services", keywords: ["proto", "rpc"] },
      { name: "WebSocket", href: "/websocket-client", description: "Test WebSocket connections", keywords: ["ws", "wss", "socket"] },
      { name: "SSE Client", href: "/sse-client", description: "Test Server-Sent Events streams", keywords: ["eventsource", "stream"] },
      { name: "Cron Parser", href: "/cron-parser", description: "Explain & preview cron expressions", keywords: ["crontab", "schedule", "quartz"] },
    ]
  },
  {
    name: "Other",
    href: "/developer-tools",
    icon: "more",
    items: [
      { name: "UUID Generator", href: "/uuid-generator", description: "Generate UUIDs / GUIDs", keywords: ["guid", "v4", "random id"] },
      { name: "SVG Optimizer", href: "/svg-optimizer", description: "Minify & clean up SVG files", keywords: ["svgo", "minify", "compress"] },
      { name: "All Tools", href: "/developer-tools", description: "Browse every tool", keywords: ["index", "list"] },
    ]
  },
];

/** Flat, de-duplicated list of all tools (Popular contains duplicates of other groups). */
export const allTools: (Tool & { group: string })[] = (() => {
  const seen = new Set<string>();
  const list: (Tool & { group: string })[] = [];
  for (const group of toolGroups) {
    if (group.name === "Popular") continue;
    for (const tool of group.items) {
      if (seen.has(tool.href)) continue;
      seen.add(tool.href);
      list.push({ ...tool, group: group.name });
    }
  }
  return list;
})();
