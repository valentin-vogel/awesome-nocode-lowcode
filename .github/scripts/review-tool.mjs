import { readFile } from 'node:fs/promises';

const MARKER = '<!-- awesome-tool-review -->';
const apiKey = process.env.OPENAI_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const model = process.env.OPENAI_MODEL || 'gpt-5.4';

if (!apiKey) throw new Error('Missing OPENAI_API_KEY repository secret.');
if (!githubToken) throw new Error('Missing GITHUB_TOKEN.');
if (!repository || !prNumber) throw new Error('Missing GitHub PR context.');

const githubHeaders = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${githubToken}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'awesome-nocode-lowcode-reviewer',
};

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...githubHeaders, ...options.headers },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function urlsFrom(text = '') {
  return [...text.matchAll(/https?:\/\/[^\s)\]>"']+/gi)].map((match) => {
    try {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ''));
      return url.href;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function isPlaceholder(url) {
  return /your-awesome-tool\.url|example\.com/i.test(url);
}

function isOwnRepository(url) {
  return url.includes(`github.com/${repository}`) || url.includes(`api.github.com/repos/${repository}`);
}

async function findSubmittedUrl() {
  const bodyUrls = urlsFrom(process.env.PR_BODY || '')
    .filter((url) => !isPlaceholder(url) && !isOwnRepository(url));

  // The PR template puts the submitted website in the body. Prefer a non-GitHub
  // URL because a product's website is the review starting point.
  const bodyWebsite = bodyUrls.find((url) => new URL(url).hostname !== 'github.com');
  if (bodyWebsite) return bodyWebsite;
  if (bodyUrls[0]) return bodyUrls[0];

  // Fallback for contributors who only add the website to README.md.
  const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
    headers: { ...githubHeaders, Accept: 'application/vnd.github.v3.diff' },
  });
  if (!response.ok) throw new Error(`Could not read PR diff: ${response.status}`);
  const diff = await response.text();
  const addedLines = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  const diffUrls = urlsFrom(addedLines).filter((url) => !isPlaceholder(url) && !isOwnRepository(url));
  const diffWebsite = diffUrls.find((url) => new URL(url).hostname !== 'github.com');
  return diffWebsite || diffUrls[0] || null;
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'open_source', 'eligibility', 'legal', 'pricing', 'awesome', 'recommendation'],
  properties: {
    tool: {
      type: 'object', additionalProperties: false,
      required: ['name', 'website'],
      properties: { name: { type: 'string' }, website: { type: 'string' } },
    },
    open_source: {
      type: 'object', additionalProperties: false,
      required: ['status', 'license', 'github_url', 'self_hostable', 'summary'],
      properties: {
        status: { type: 'string', enum: ['OPEN_SOURCE', 'SOURCE_AVAILABLE', 'OPEN_CORE', 'CLOSED_SOURCE', 'UNKNOWN'] },
        license: { type: 'string' },
        github_url: { type: 'string' },
        self_hostable: { type: 'boolean' },
        summary: { type: 'string' },
      },
    },
    eligibility: {
      type: 'object', additionalProperties: false,
      required: ['classification', 'confidence', 'checks', 'summary'],
      properties: {
        classification: { type: 'string', enum: ['NO_CODE', 'LOW_CODE', 'BOTH', 'NOT_APPLICABLE', 'UNCLEAR'] },
        confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        checks: { $ref: '#/$defs/checks' },
        summary: { type: 'string' },
      },
    },
    legal: {
      type: 'object', additionalProperties: false,
      required: ['rating', 'checks', 'certifications', 'summary'],
      properties: {
        rating: { type: 'string', enum: ['EXCELLENT', 'GOOD', 'BASIC', 'INSUFFICIENT', 'CRITICAL'] },
        checks: { $ref: '#/$defs/checks' },
        certifications: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
    },
    pricing: {
      type: 'object', additionalProperties: false,
      required: ['available', 'checks', 'offers', 'market_position', 'advisory'],
      properties: {
        available: { type: 'boolean' },
        checks: { $ref: '#/$defs/checks' },
        offers: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: 'string' } },
          },
        },
        market_position: { type: 'string', enum: ['VERY_COMPETITIVE', 'COMPETITIVE', 'MARKET_AVERAGE', 'EXPENSIVE', 'VERY_EXPENSIVE', 'INSUFFICIENT_DATA'] },
        advisory: { type: 'string' },
      },
    },
    awesome: {
      type: 'object', additionalProperties: false,
      required: ['rating', 'checks', 'summary'],
      properties: {
        rating: { type: 'string', enum: ['AWESOME', 'GOOD_FIT', 'BORDERLINE', 'NOT_AWESOME', 'NOT_ELIGIBLE'] },
        checks: { $ref: '#/$defs/checks' },
        summary: { type: 'string' },
      },
    },
    recommendation: {
      type: 'object', additionalProperties: false,
      required: ['verdict', 'reason'],
      properties: {
        verdict: { type: 'string', enum: ['ACCEPT', 'MANUAL_REVIEW', 'REJECT'] },
        reason: { type: 'string' },
      },
    },
  },
  $defs: {
    checks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['question', 'answer'],
        properties: { question: { type: 'string' }, answer: { type: 'boolean' } },
      },
    },
  },
};

function outputText(response) {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  throw new Error('OpenAI response contained no output text.');
}

async function reviewTool(website) {
  const rubric = await readFile(new URL('./review-prompt.md', import.meta.url), 'utf8');
  const input = `${rubric}\n\n## Tool to review\n\nSubmitted website: ${website}\nPR title: ${process.env.PR_TITLE || ''}\n\nResearch the current website now. Answer every requested check. Keep summaries concise and evidence-based.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      tools: [{ type: 'web_search' }],
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'awesome_tool_review',
          strict: true,
          schema,
        },
      },
    }),
  });

  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${await response.text()}`);
  return JSON.parse(outputText(await response.json()));
}

const yesNo = (value) => value ? '✅ Yes' : '❌ No';
const label = (value) => String(value).replaceAll('_', ' ');

function renderChecks(checks) {
  return checks.map(({ question, answer }) => `- ${answer ? '✅' : '❌'} ${question}`).join('\n');
}

function renderReview(r) {
  const verdictIcon = { ACCEPT: '✅', MANUAL_REVIEW: '⚠️', REJECT: '❌' }[r.recommendation.verdict];
  const github = r.open_source.github_url || 'Not found on the official website';
  const license = r.open_source.license || 'Not identified';
  const certs = r.legal.certifications.length ? r.legal.certifications.join(', ') : 'None found';
  const offers = r.pricing.offers.length
    ? r.pricing.offers.map((offer) => `- ${offer.name} — ${offer.price}`).join('\n')
    : '- No public offers found';

  return `${MARKER}
## 🔎 Awesome List Review

**Tool:** ${r.tool.name}  
**Website:** ${r.tool.website}  
**Recommendation:** ${verdictIcon} **${label(r.recommendation.verdict)}**

### 1. Open Source

**Status:** ${label(r.open_source.status)}  
**License:** ${license}  
**GitHub:** ${github}  
**Self-hostable:** ${yesNo(r.open_source.self_hostable)}

${r.open_source.summary}

### 2. No-code / Low-code

**Classification:** ${label(r.eligibility.classification)}  
**Confidence:** ${label(r.eligibility.confidence)}

${renderChecks(r.eligibility.checks)}

**Assessment:** ${r.eligibility.summary}

### 3. Legal, Data Governance & Security

**Public legal transparency:** **${label(r.legal.rating)}**

${renderChecks(r.legal.checks)}

**Certifications / standards explicitly claimed:** ${certs}

${r.legal.summary}

> This rating assesses publicly available information only. It is not a determination of legal or regulatory compliance and is not legal advice.

### 4. Pricing

**Pricing available:** ${yesNo(r.pricing.available)}

${renderChecks(r.pricing.checks)}

#### Offers

${offers}

**Market position:** **${label(r.pricing.market_position)}**  
${r.pricing.advisory}

### 5. Awesome Check

**Rating:** **${label(r.awesome.rating)}**

${renderChecks(r.awesome.checks)}

**Assessment:** ${r.awesome.summary}

### Final Recommendation

${verdictIcon} **${label(r.recommendation.verdict)}**

${r.recommendation.reason}

---
_Automated AI-assisted review based on public web information. Maintainer verification is recommended before merging._
`;
}

async function upsertComment(body) {
  const comments = await github(`/repos/${repository}/issues/${prNumber}/comments?per_page=100`);
  const existing = comments.find((comment) => comment.body?.includes(MARKER));

  if (existing) {
    await github(`/repos/${repository}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log(`Updated review comment ${existing.id}.`);
    return;
  }

  await github(`/repos/${repository}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  console.log('Created review comment.');
}

const website = await findSubmittedUrl();
if (!website) {
  await upsertComment(`${MARKER}\n## 🔎 Awesome List Review\n\n⚠️ **MANUAL REVIEW**\n\nI could not identify a submitted tool website in the PR description or added lines. Add the official product URL and update the PR.`);
  process.exit(0);
}

console.log(`Reviewing ${website} with ${model}...`);
const review = await reviewTool(website);
await upsertComment(renderReview(review));
