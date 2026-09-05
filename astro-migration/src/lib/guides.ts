export interface Guide {
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  topic: string;
  published: string;
  updated: string;
  readingMinutes: number;
  image: string;
  imageAlt: string;
  toolHref: string;
  toolName: string;
}

export const guides: Guide[] = [
  {
    slug: 'read-java-thread-dump-find-deadlock',
    title: 'How to Read a Java Thread Dump and Find a Deadlock',
    shortTitle: 'Find a Java deadlock in a thread dump',
    description: 'A practical, evidence-first method for reading jstack and jcmd output, tracing monitor ownership, confirming deadlocks, and separating ordinary waits from incidents.',
    topic: 'JVM diagnostics',
    published: '2026-09-05',
    updated: '2026-09-05',
    readingMinutes: 8,
    image: '/og/thread-dump-analyzer.png',
    imageAlt: 'Java thread dump analyzer showing blocked threads, lock owners, and a deadlock cycle',
    toolHref: '/thread-dump-analyzer',
    toolName: 'Java Thread Dump Analyzer',
  },
  {
    slug: 'pem-vs-der-vs-cer-vs-p7b-certificate-formats',
    title: 'PEM vs DER vs CER vs P7B: Certificate Formats Explained',
    shortTitle: 'PEM, DER, CER, and P7B explained',
    description: 'Identify common X.509 certificate formats, inspect their contents, convert them safely with OpenSSL, and avoid confusing filename extensions with encodings.',
    topic: 'TLS and certificates',
    published: '2026-09-05',
    updated: '2026-09-05',
    readingMinutes: 7,
    image: '/og/certificate-inspector.png',
    imageAlt: 'X.509 certificate inspector showing identity, validity, fingerprints, and conversion options',
    toolHref: '/certificate-inspector',
    toolName: 'X.509 Certificate Inspector',
  },
  {
    slug: 'test-soap-api-from-wsdl-soap-11-vs-12',
    title: 'How to Test a SOAP API from a WSDL: SOAP 1.1 vs 1.2',
    shortTitle: 'Test a SOAP API from its WSDL',
    description: 'Turn a WSDL operation into a working request, choose the right SOAP version and headers, interpret faults, and recognize browser CORS limitations.',
    topic: 'SOAP and APIs',
    published: '2026-09-05',
    updated: '2026-09-05',
    readingMinutes: 8,
    image: '/og/soap-client.png',
    imageAlt: 'SOAP client with WSDL operation browser, XML request editor, and response inspector',
    toolHref: '/soap-client',
    toolName: 'SOAP and WSDL Client',
  },
  {
    slug: 'sql-ddl-to-er-diagram-data-dictionary',
    title: 'How to Turn SQL DDL into an ER Diagram and Data Dictionary',
    shortTitle: 'Turn SQL DDL into an ER diagram',
    description: 'Extract a schema-only database definition, visualize foreign-key relationships, add useful annotations, and export documentation without connecting another service.',
    topic: 'Database documentation',
    published: '2026-09-05',
    updated: '2026-09-05',
    readingMinutes: 7,
    image: '/og/schema-explorer.png',
    imageAlt: 'Interactive entity relationship diagram generated from SQL DDL',
    toolHref: '/schema-explorer',
    toolName: 'Database Schema Explorer',
  },
  {
    slug: 'convert-terminal-table-to-excel',
    title: 'How to Convert a Terminal Table to Excel Without Broken Columns',
    shortTitle: 'Convert terminal output to Excel',
    description: 'Turn ASCII pipes, Unicode box drawing, PostgreSQL results, or aligned console output into editable Excel, CSV, HTML, Word, and printable tables.',
    topic: 'Terminal productivity',
    published: '2026-09-05',
    updated: '2026-09-05',
    readingMinutes: 6,
    image: '/og/ascii-table-converter.png',
    imageAlt: 'Terminal ASCII table converted into editable spreadsheet rows and columns',
    toolHref: '/ascii-table-converter',
    toolName: 'Terminal Table Converter',
  },
];

export function guideBySlug(slug: string): Guide {
  const guide = guides.find((item) => item.slug === slug);
  if (!guide) throw new Error(`Unknown guide: ${slug}`);
  return guide;
}
