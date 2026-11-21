import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';

const startUrl = process.argv[2];
const outputFile = process.argv[3] ?? 'website-evidence.txt';

if (!startUrl) throw new Error('Usage: node fetch-tool-website.mjs <url> [output-file]');

const MAX_PAGES = 14;
const MAX_PAGE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 180_000;
const TIMEOUT_MS = 12_000;

const usefulPath = /(pricing|price|plans|privacy|legal|terms|security|trust|compliance|cookie|dpa|data-processing|subprocessor|imprint|impressum|about|company|contact|open-source|opensource|github|license|licence|docs|documentation|self-host|selfhost)/i;

function isForbiddenIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  if (net.isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') ||
      v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
  }
  return true;
}

async function assertPublicHttpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported protocol: ${url.protocol}`);
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('Localhost is not allowed');

  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isForbiddenIp(address))) {
    throw new Error(`Host does not resolve exclusively to public IP addresses: ${url.hostname}`);
  }
  return url;
}

function normalizeHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function linksFromHtml(html, base) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], base);
      if (['http:', 'https:'].includes(url.protocol)) {
        url.hash = '';
        links.push(url.href);
      }
    } catch {}
  }
  return [...new Set(links)];
}

async function fetchPage(urlString) {
  let current = await assertPublicHttpUrl(urlString);
  for (let redirect = 0; redirect <= 5; redirect++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'awesome-nocode-lowcode-review/1.0 (+https://github.com/valentin-vogel/awesome-nocode-lowcode)',
          accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect without Location from ${current.href}`);
      current = await assertPublicHttpUrl(new URL(location, current).href);
      continue;
    }

    const type = response.headers.get('content-type') ?? '';
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!type.includes('text/html') && !type.includes('text/plain')) throw new Error(`Unsupported content type: ${type}`);

    const body = (await response.text()).slice(0, 500_000);
    return { finalUrl: current.href, body, type };
  }
  throw new Error(`Too many redirects for ${urlString}`);
}

const initial = await assertPublicHttpUrl(startUrl);
const officialHost = normalizeHost(initial.hostname);
const queue = [initial.href];
const queued = new Set(queue);
const visited = new Set();
const evidence = [];
const officialExternalLinks = new Set();
let totalChars = 0;

while (queue.length && visited.size < MAX_PAGES && totalChars < MAX_TOTAL_CHARS) {
  const requested = queue.shift();
  if (visited.has(requested)) continue;
  visited.add(requested);

  try {
    const page = await fetchPage(requested);
    const final = new URL(page.finalUrl);
    if (normalizeHost(final.hostname) !== officialHost) {
      evidence.push(`URL: ${requested}\nFETCH NOTE: Redirected outside the submitted official host to ${page.finalUrl}; content was not used.\n`);
      continue;
    }

    const text = htmlToText(page.body).slice(0, MAX_PAGE_CHARS);
    totalChars += text.length;
    evidence.push(`URL: ${page.finalUrl}\nCONTENT:\n${text}\n`);

    if (page.type.includes('text/html')) {
      for (const link of linksFromHtml(page.body, page.finalUrl)) {
        const linked = new URL(link);
        const sameOfficialHost = normalizeHost(linked.hostname) === officialHost;
        if (sameOfficialHost && usefulPath.test(linked.pathname + linked.search) && !queued.has(link)) {
          queued.add(link);
          queue.push(link);
        } else if (!sameOfficialHost && /(^|\.)github\.com$/i.test(linked.hostname)) {
          officialExternalLinks.add(link);
        }
      }
    }
  } catch (error) {
    evidence.push(`URL: ${requested}\nFETCH ERROR: ${error.message}\n`);
  }
}

if (officialExternalLinks.size) {
  evidence.push(`OFFICIAL WEBSITE LINKS TO GITHUB:\n${[...officialExternalLinks].sort().join('\n')}\n`);
}

await fs.writeFile(outputFile, evidence.join('\n---\n').slice(0, MAX_TOTAL_CHARS + 20_000));
console.log(`Collected ${visited.size} page(s) into ${outputFile}`);
