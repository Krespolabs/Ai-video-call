<!-- Vendored from https://zauth.inc/docs/reposcan on 2026-06-10 -->

# RepoScan

RepoScan is an AI-powered Telegram bot that analyzes GitHub repositories in real-time. Share any GitHub repository URL in your Telegram group and RepoScan will run deep analysis, reporting back with a trust score and detailed findings within seconds.

Built for crypto communities who need to quickly vet project codebases, RepoScan combines AI-driven code analysis and pattern matching to surface red flags before they become expensive mistakes.

RepoScan Demo - Similarity Scores & Diff Viewer

[Try RepoScan](https://zauth.inc/reposcan)[Add to Telegram](https://t.me/zpointz)[Use with Rick](https://t.me/RickBurpBot)

## AI Scrapers

When you share a GitHub URL, RepoScan's AI scrapers go to work. They pull the full repository structure, README content, smart contracts, deployment scripts, and configuration files. The scrapers understand code context. They know which files matter most for security analysis and prioritize accordingly.

The scrapers handle rate limiting and large repositories automatically, breaking down complex codebases into digestible chunks for AI analysis. They extract not just the code itself, but metadata like commit history, contributor patterns, and repository age.

## Code Search

RepoScan performs deep code analysis across the entire repository, comparing files against millions of other public repositories. The search identifies similar code across the ecosystem, surfacing where the code likely originated and how much of it is original versus copied.

For each file scanned, RepoScan returns a list of similar files found in other repositories along with similarity scores. The built-in diff viewer lets you compare the scanned code against these matches side-by-side, making it easy to spot copy-pasted code, identify the original source, and assess how much unique work actually went into a project.

If a project claims to be original but their codebase is 95% identical to another public repo, you'll see it immediately. This transparency helps communities distinguish between projects with genuine development effort and those that are simply repackaging existing code.

## Trust Score

Every scan produces a trust score from 0 to 100. This score combines multiple signals: code originality, repository age, commit history, contributor diversity, and overall development effort. High similarity to other repos lowers the score, while unique code and active development history raise it.

A high score doesn't guarantee safety, but it means the project passed automated checks and shows signs of legitimate development. A low score is a strong warning signal. The score is accompanied by specific findings so you can understand exactly what triggered concerns, rather than blindly trusting a number.

0-30

High Risk

31-70

Caution

71-100

Lower Risk

## Why It Matters

The crypto space moves fast. New tokens launch every minute, and communities need to make quick decisions about what to trust. Manual code review takes hours and requires expertise most people don't have. RepoScan automates the first layer of due diligence, giving communities instant visibility into whether a project's code raises red flags.

This doesn't replace thorough research, it accelerates it. When someone drops a new token in your group, RepoScan gives everyone the same baseline information within seconds. Legitimate projects benefit from the transparency, and scams get exposed before they can do damage.

## Partnerships

RepoScan is available as an embeddable component for trading platforms and crypto tools. Partners can integrate RepoScan directly into their interfaces, giving users instant code analysis without leaving the platform.

### Axiom Memescope Integration

RepoScan is integrated into [Axiom's memescope](https://axiom.trade), one of the leading Solana trading terminals. When viewing any token, users can access RepoScan analysis directly in the interface. The integration pulls repository URLs from token metadata and displays trust scores, code similarity findings, and red flags inline.

### Embeddable Component

Partners embed RepoScan using a simple iframe component. Pass a GitHub repository URL as a query parameter and the component handles everything: fetching the repo, running analysis, displaying results with the trust score, file similarity tree, and AI summary.

/iframe?repo=owner/repo

### REST API

Partners can integrate RepoScan via our REST API. All endpoints are served from `api.zauth.inc`. Authenticate with an API key, trigger scans, stream real-time progress via Server-Sent Events, and retrieve detailed results programmatically.

GET`/api/bot/scan`Trigger or retrieve scan

# Request

GET https://api.zauth.inc/api/bot/scan?repo=owner/repo

Header: X-API-Key: your_api_key

# Response (scan started)
    
    
    {
      "status": "scanning",
      "scanId": "cc5e877a-...",
      "message": "Scan started",
      "progressUrl": "https://api.zauth.inc/api/bot/progress/cc5e877a-..."
    }

GET`/api/bot/progress/:scanId`Stream progress (SSE)

# Request

GET https://api.zauth.inc/api/bot/progress/:scanId

# Server-Sent Events stream
    
    
    data: {"type": "files_listed", "filesToScan": 12}
    data: {"type": "file_fetching", "current": 1, "total": 12}
    data: {"type": "search_completed", "current": 5, "total": 20}
    data: {"type": "analyzing"}
    data: {"type": "completed", "zauthScore": 25}

GET`/api/bot/scan`Completed scan results

# Request

GET https://api.zauth.inc/api/bot/scan?repo=owner/repo

# Response (completed)
    
    
    {
      "status": "completed",
      "scanId": "cc5e877a-...",
      "repoName": "owner/repo",
      "repoUrl": "https://github.com/owner/repo",
      "tldr": "AI-generated summary...",
      "zauthScore": 25,
      "diffUrl": "https://zauth.inc/scan/...",
      "iframeUrl": "https://zauth.inc/iframe?scanId=...",
      "metadata": {
        "stars": 1234,
        "forks": 56,
        "totalCommits": 892,
        "contributorCount": 12,
        "contributors": ["alice", "bob", "..."],
        "description": "Repository description",
        "createdAt": "2023-01-15T...",
        "pushedAt": "2024-12-01T...",
        "ageInDays": 685,
        "isFork": false,
        "parentRepo": null,
        "redFlags": ["Low commit count", "..."],
        "greenFlags": ["Active development", "..."],
        "lastCommit": {
          "sha": "abc123...",
          "date": "2024-12-01T...",
          "message": "Fix bug in...",
          "author": "alice"
        }
      }
    }

Interested in integrating RepoScan? [Reach out on Telegram](https://t.me/zpointz) to get an API key and discuss partnership opportunities.

## x402 Payment API

RepoScan is available as an [x402](https://x402.org) payment-gated API. Pay per scan with any EVM or Solana wallet - no API key or account required. AI agents and automated tools can call this endpoint directly using the x402 protocol.

### Pricing & Free Tier

Per Scan

$0.05

USDC on Base or Solana

SIWX Free

Sign In With X

Free after first payment via wallet signature

### Supported Networks

Network| CAIP-2 ID| Asset  
---|---|---  
Base| eip155:8453| USDC  
Solana| solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp| USDC  
  
### How It Works

1

Send a `POST` to `/x402/reposcan` with no payment header. Server responds `402` with payment requirements and SIWX challenge.

2

Complete payment via any x402-compatible client, or sign the SIWX challenge with your wallet (free for token holders or previous payers).

3

Retry the request with the payment or SIWX header. Server returns cached results immediately, or a `sessionToken` for polling.

4

Poll `GET /x402/reposcan/:sessionToken` (no payment required) until the scan completes.

### Trigger Scan

POST`/x402/reposcan`x402 payment required

# Request

POST https://api.zauth.inc/x402/reposcan

Header: Payment-Signature: <x402 payment>

or Header: Sign-In-With-X: <SIWX signature>
    
    
    // Body
    { "repoUrl": "https://github.com/owner/repo" }

# Response - cached (immediate)
    
    
    {
      "status": "completed",
      "scanId": "clx1abc...",
      "zauthScore": 85,
      "analysisMarkdown": "## Analysis\n...",
      "tldr": "Well-maintained project with...",
      "comparisons": [...],
      "cached": true,
      "scannedAt": "2025-01-15T..."
    }

# Response - new scan (async)
    
    
    {
      "status": "scanning",
      "scanId": "clx2def...",
      "sessionToken": "eyJhbGci..."
    }

### Poll Progress

GET`/x402/reposcan/:sessionToken`No payment required

# Request

GET https://api.zauth.inc/x402/reposcan/eyJhbGci...

# Response - in progress
    
    
    {
      "status": "scanning",
      "scanId": "clx2def...",
      "progress": { "phase": "searching", "current": 5, "total": 20 }
    }

# Response - completed
    
    
    {
      "status": "completed",
      "scanId": "clx2def...",
      "zauthScore": 72,
      "analysisMarkdown": "## Analysis\n...",
      "tldr": "Project shows moderate originality...",
      "comparisons": [
        {
          "targetPath": "src/main.ts",
          "originRepo": "other/repo",
          "originPath": "src/index.ts",
          "scoreApprox": 0.87,
          "snippet": "export function..."
        }
      ],
      "scannedAt": "2025-01-15T..."
    }

### Sign In With X (Free Access)

The x402 endpoint supports [Sign In With X (SIWX)](https://github.com/coinbase/x402/tree/main/examples/typescript/clients/sign-in-with-x) for wallet-based authentication without payment:

**Previous payer:** After your first x402 payment, subsequent requests can use SIWX with the same wallet - no additional payment needed.

When the initial `402` response is returned, it includes a SIWX challenge in the extensions. Your x402 client signs the challenge with your wallet, proving ownership. The server then verifies the signature and checks eligibility before granting access.

### Client Example

TypeScript -@x402/fetch
    
    
    import { x402Client, x402HTTPClient } from "@x402/fetch";
    import { registerExactEvmScheme } from "@x402/evm/exact/client";
    import { registerExactSvmScheme } from "@x402/svm/exact/client";
    import { createSIWxClientHook } from "@x402/extensions/sign-in-with-x";
    import { privateKeyToAccount } from "viem/accounts";
    
    // Set up wallet signer
    const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
    
    // Register payment schemes
    registerExactEvmScheme(x402Client, { account });
    registerExactSvmScheme(x402Client, { /* solana signer */ });
    
    // Create HTTP client with SIWX support
    const client = new x402HTTPClient(x402Client, {
      hooks: [createSIWxClientHook(account)],
    });
    
    // Trigger a scan - handles 402 + payment/SIWX automatically
    const res = await client.fetch(
      "https://api.zauth.inc/x402/reposcan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/owner/repo"
        }),
      }
    );
    
    const data = await res.json();
    
    if (data.status === "scanning") {
      // Poll for results
      const poll = await fetch(
        `https://api.zauth.inc/x402/reposcan/${data.sessionToken}`
      );
      console.log(await poll.json());
    } else {
      // Cached result returned immediately
      console.log(data.zauthScore, data.analysisMarkdown);
    }
