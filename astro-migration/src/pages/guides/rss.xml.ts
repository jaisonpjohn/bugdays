import type { APIRoute } from 'astro';
import { guides } from '../../lib/guides';

const escapeXml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

export const GET: APIRoute = () => {
  const items = guides.map((guide) => {
    const link = `https://bugdays.com/guides/${guide.slug}/`;
    return `<item>
      <title>${escapeXml(guide.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${new Date(`${guide.published}T09:00:00-07:00`).toUTCString()}</pubDate>
      <category>${escapeXml(guide.topic)}</category>
      <description>${escapeXml(guide.description)}</description>
    </item>`;
  }).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Bug Days Developer Guides</title>
    <link>https://bugdays.com/guides/</link>
    <description>Practical field guides for JVM diagnostics, APIs, certificates, databases, and developer workflows.</description>
    <language>en-us</language>
    <atom:link href="https://bugdays.com/guides/rss.xml" rel="self" type="application/rss+xml" />
    ${items}
  </channel>
</rss>`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
