<!-- Vendored from https://zauth.inc/docs/vector on 2026-06-10 -->

# Vector

Vector is an AI-powered black-box vulnerability scanner. Point it at any web application and it autonomously discovers attack surfaces, tests for vulnerabilities across multiple categories, and generates detailed security reports with proof-of-concept exploits.

Built on Claude's agent capabilities, Vector doesn't rely on signature databases or predefined rules. It reasons about your application the way a human pentester would, adapting its approach based on what it discovers during reconnaissance. It runs a real Chromium browser, injects crypto wallets, creates disposable email accounts, analyzes JavaScript bundles, and can even route through proxy browsers to bypass geo-blocks and CAPTCHAs. Every scan runs in its own isolated worker node with dedicated resources, and the infrastructure autoscales to handle concurrent scans without contention. Each worker gets its own browser instance, its own database connection pool, and its own memory space. There's no cross-contamination between scans. Cookies, sessions, localStorage, and network state from one scan never leak into another.

Vector Demo: Black-Box Scanning (White-Box Coming Soon)

[Launch Vector](https://zauth.inc/vector)

## Domain Verification

Before scanning, you must prove ownership of the target domain. Vector uses two verification methods depending on your domain type:

### Custom domains — DNS TXT record

Add a TXT record to your domain's DNS with the value `vector-verify=<your-token>`. Vector queries multiple public resolvers (Cloudflare, Google, Quad9) to check for recently propagated records. This is the default method for any custom domain.

### Platform subdomains — .well-known endpoint

If your site is hosted on a shared platform (Railway, Vercel, Netlify, Fly, Render, Cloudflare Pages, etc.), you can't modify DNS. Instead, serve a JSON response at `/.well-known/vector-verify` containing `{"token": "<your-token>"}`. Vector checks both root and www variants automatically.

Verification tokens expire after 1 hour. Multiple users can attempt verification simultaneously — first to verify wins exclusive ownership. Shared platform parent domains (e.g. vercel.app itself) are blocked to prevent claiming shared infrastructure.

## Scan Depths

Vector offers two scan depths. Each controls the number of AI turns, timeout, and maximum budget. Quick scans skip account creation and authenticated testing to stay fast and cheap. Deep scans enable wallet injection, disposable email account creation, and multi-wave category testing.

Quick

$15 / 30 min

75 AI turns. Surface-level recon and category testing. No account creation or authenticated flows. Good for a fast health check on public-facing endpoints.

Deep

$49 / 3 hours

500 AI turns. Full multi-category scan across all five categories with wallet injection, disposable email account creation, three-wave exploitation, and bonus deep-dive turns for categories that find vulnerabilities. For production security audits.

## Billing & Refunds

No subscriptions or seat licenses. You buy credits and pay a flat fee per scan.

### Quick Scan

Fast surface-level check. No auth testing.

$15 per scan

Endpoint & header scanning

Misconfiguration detection

Subdomain discovery

CORS & rate limit checks

Basic injection & XSS testing

### Deep Scan

Full multi-pass pentest with auth and exploit chains.

$49 per scan

Everything in Quick

Site crawling & JS analysis

Auth flow testing

CORS & SSRF probing

Session & privilege escalation

IDOR & token analysis

When you start a scan, the flat fee is charged from your credit balance upfront. Every transaction is logged as an auditable ledger entry with before/after balance snapshots.

## AI-Powered Reconnaissance

Every scan begins with an autonomous recon phase using 30% of the total turn budget. The AI agent crawls your application with a real browser, discovers endpoints, intercepts network traffic to find hidden API calls in SPAs, analyzes JavaScript bundles for hardcoded routes and secrets, enumerates subdomains via Certificate Transparency logs and DNS brute force, and maps authentication flows.

The recon agent produces structured intelligence: technology stack, authentication mechanisms, all discovered endpoints, API patterns, form inventories, security headers, and potential entry points. This data feeds directly into each category scanner so vulnerability testing is targeted, not generic.

## Scan Categories

Vector tests across five vulnerability categories, executed in two waves. Wave 1 establishes authenticated sessions and maps data structures. Wave 2 leverages those sessions for deeper testing. Each category runs its own specialized AI agent with a three-stage pipeline: vulnerability detection, queue extraction, and exploitation verification.

Wave 1Authentication

Tests login flows, session management, password reset mechanisms, OAuth implementations, JWT validation, and credential handling. Creates real accounts using disposable email, then inspects session cookies (HttpOnly, Secure, SameSite), tests for session fixation, token rotation, and logout invalidation. Follows an 11-step methodology checklist with strict evidence requirements.

Wave 1Injection

SQL injection, NoSQL injection, command injection, LDAP injection, and template injection. Tests both classic and blind techniques (time-based, error-based, out-of-band) across all discovered input vectors including URL parameters, form fields, headers, and JSON bodies.

Wave 2Cross-Site Scripting (XSS)

Reflected, stored, and DOM-based XSS testing. The agent executes payloads in a real Chrome instance and verifies actual script execution via `browser_evaluate`, not pattern matching against response bodies.

Wave 2Authorization (IDOR / Access Control)

Insecure direct object references, horizontal and vertical privilege escalation, missing function-level access controls, and API authorization bypasses. Uses accounts created during Wave 1 to test cross-user access patterns.

Wave 2Server-Side Request Forgery (SSRF)

Tests URL parameters, file upload handlers, webhook endpoints, and any functionality that makes server-side HTTP requests. Includes private IP range detection to prevent the scanner itself from being used as an SSRF vector.

Categories that discover vulnerabilities receive bonus deep-dive turns (5% of budget) to escalate findings, gather stronger evidence, and explore related attack paths.

## Scanner Tooling

The AI agent has access to 14+ specialized security tools during scans, plus full bash access for running curl, wget, and custom scripts. These aren't wrappers around existing scanners. Each tool is purpose-built for the Vector pipeline.

HTTP Requests

Raw GET/POST/PUT/DELETE/PATCH/OPTIONS with redirect control and private IP blocking

Browser Navigation

Real Chromium with full JS execution, form filling, clicking, and JS evaluation

Network Interception

Captures all XHR, fetch, and WebSocket requests during navigation for SPA API discovery

Site Crawler

Multi-page crawling with tech fingerprinting, form inventory, and inline API hint extraction

JavaScript Analysis

Parses JS bundles with 40+ regex patterns to extract API routes, secrets, and config values

Subdomain Discovery

Certificate Transparency log enumeration + DNS brute force across 27 common prefixes

Rate Limit Probing

Sends 50 rapid requests to empirically detect 429s, timing delays, and CAPTCHA triggers

CORS Testing

Tests 8+ origin variations (reflected, wildcard, null) to detect CORS misconfigurations

GraphQL Introspection

Full schema extraction with sensitive field detection (tokens, passwords, keys, roles)

Disposable Email

Generate addresses, poll inboxes, and auto-extract verification links for account creation

## Browser-Based Testing

Vector runs a real Chromium browser instance during every scan. This isn't headless HTTP requests pretending to be a browser. The agent navigates pages, fills forms, clicks buttons, intercepts all network traffic (XHR, fetch, WebSocket), evaluates arbitrary JavaScript in the page context, and inspects cookies, localStorage, and sessionStorage directly.

Each scan gets an isolated BrowserContext with memory protection. Chrome is configured with a 512MB V8 heap cap and WebGL disabled to prevent memory-heavy sites (ThreeJS, heavy canvas apps) from crashing the worker. This doesn't affect authentication flows, CAPTCHA rendering, or any functional testing. The agent can still read console logs, inspect the network log, and take screenshots throughout the scan.

## Wallet Injection

For Web3 applications, Vector injects fully functional crypto wallets into the browser before navigating to your site. These are real wallets with real cryptographic signing, not mocks.

The **Ethereum wallet** implements the full MetaMask JSON-RPC interface: eth_requestAccounts, personal_sign, eth_signTypedData_v4 (EIP-712), and eth_sendTransaction. It generates real secp256k1 keypairs, produces valid checksummed addresses, and auto-approves all signing requests. It even announces itself via EIP-6963 so web3 libraries discover it automatically.

The **Solana wallet** implements the Phantom provider interface: connect, signMessage, signTransaction, and signAllTransactions. It uses Ed25519 signing via Web Crypto with base58-encoded public keys. Both `window.solana` and `window.phantom.solana` access patterns are supported.

This enables Vector to test wallet-gated flows, sign-in-with-Ethereum (SIWE), token-gated access, and any authentication that requires a connected wallet. Standard and Deep scans enable wallet injection by default.

## Disposable Email Server

Vector operates its own email infrastructure on the `zauthvector.com` domain via Cloudflare Email Routing and a custom Worker. During scans, the agent generates disposable addresses (like `[[email protected]](https://zauth.inc/cdn-cgi/l/email-protection)`), uses them to register accounts on your site, then polls the inbox for verification emails.

Incoming emails are parsed for both plain text and HTML content, and verification URLs are automatically extracted and ranked by relevance. Links containing "verify", "confirm", or "activate" are prioritized over generic URLs. Common non-verification links (analytics, schema.org, image files) are filtered out. The agent then visits the verification link to complete account creation and proceeds to test the authenticated attack surface.

## Proxy Browser (Bright Data CDP)

Some targets are hard to test. They might block datacenter IPs, require solving CAPTCHAs, enforce geo-restrictions, or serve persistent interstitial pages. When the agent's local browser can't get through, it can fall back to a remote proxy browser via Bright Data's WebSocket CDP connection.

The proxy browser connects over CDP (Chrome DevTools Protocol), swaps in as the active browser session, and all subsequent browser tools automatically route through it. The agent decides when to use this. If normal navigation works, it stays local. If it hits a wall, it escalates to the proxy. This means Vector can test sites that would be completely unreachable by traditional scanners running from a single datacenter IP.

## False Positive Prevention

Vector applies automated severity validation to every finding before it lands in your report. The AUTH category operates under a "assume false until proven" default stance, and Critical findings require Level 3+ proof (demonstrated exploitation, not theoretical attack chains).

The validator catches common misidentifications that trip up other scanners:

CORS + localStorage conflation

CORS does not grant cross-origin localStorage access. Same-origin policy is independent of CORS headers. Findings claiming this are downgraded.

Critical without exploitation proof

A Critical finding must include actual exploitation evidence ("successfully accessed", "data extracted"), not theoretical chains ("if victim visits"). Unsupported Criticals are downgraded to High.

Header names reported as vulnerabilities

Access-Control-Expose-Headers listing header names is not a vulnerability without demonstrated data extraction. Capped at Medium.

localStorage as architectural observation

Using localStorage for tokens is an architectural choice, not a vulnerability, unless paired with proven XSS. Downgraded to Low without XSS evidence.

## Security Reports

Each scan produces a detailed security report with every finding categorized by severity. Findings include descriptions, affected endpoints, proof-of-concept reproduction steps, and remediation guidance. Each finding carries a verdict badge indicating whether the vulnerability was fully exploited, blocked by defenses, or remains a potential risk.

Security Assessment

Vulnerability Assessment Report

example-app.com

Mar 5, 2026|a1b2c3d4

1 CRITICAL1 HIGH2 MEDIUM1 LOW

View Report

example-app.com5 findings

Reports stream in real time as the scan runs. Progress events are broadcast via Redis pub/sub so you can watch recon discoveries, tool executions, and findings appear live in the dashboard. Screenshots are captured throughout the scan so you can see exactly what the agent saw at each step.
