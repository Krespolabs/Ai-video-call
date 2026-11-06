<!-- Vendored from https://zauth.inc/docs/database on 2026-06-10 -->

# Database

The zauth Database is a live registry of x402 protocol endpoints across the ecosystem. Our AI agents continuously discover, test, and monitor x402 endpoints, recording success rates, pricing, and response data. Query the database to find working endpoints before your agents pay.

Every endpoint in the database has been verified by our agents making real payments. We track which endpoints actually work, which are failing, and which have inconsistent behavior. This verification data helps agents make informed decisions about which services to use.

Database Explorer — x402 Endpoint Monitoring

[Explore Database](https://zauth.inc/database)

## Endpoint Tracking

Each endpoint in the database includes comprehensive metadata: the URL, HTTP method, network (Solana, Base, etc.), protocol name, and pricing information. We record the 402 Payment Required response headers that define how to pay for each endpoint, along with the actual request payloads and responses from successful calls.

Endpoints are automatically discovered when our agents encounter them during research tasks. Once discovered, we periodically retest endpoints to ensure the data stays current. Stale endpoints that stop responding are flagged, and their status updates in real-time as our agents continue testing.

## Status Types

Every endpoint is assigned a status based on recent test results. This status helps you quickly assess reliability before integrating an endpoint into your workflow.

Working

Endpoint is responding correctly after payment. High success rate in recent tests.

Failing

Endpoint is returning errors or not responding. Recent tests have failed.

Flaky

Endpoint works sometimes but fails intermittently. Mixed success rate.

Over Budget

Endpoint price exceeds our testing budget. Not verified recently.

## Verification

Endpoints in the database can be Verified or Unverified. Verified endpoints are deployed through our SDK, which inherently proves provider ownership. Once deployed, endpoints are continuously tested and monitored with tracked uptime and LLM-validated responses.

Verified

Deployed via our SDK with tracked uptime, continuous testing, and LLM-validated responses.

Unverified

Discovered by our agents, tested automatically. May work but no provider guarantees.

Providers can verify their endpoints at [/provider-hub](https://zauth.inc/provider-hub). Verification includes endpoint testing with customizable parameters and ongoing uptime monitoring.

## x402 API

We offer a free public API endpoint for agents and developers to browse the full directory of known x402 endpoints, including verification status and live health data.

GET`/api/directory`FREE

# Endpoint

GET https://api.zauth.inc/api/directory

# Query Parameters

search \- Search by URL, title, or description

network \- Filter by network (e.g. base-sepolia)

status \- Filter by status (WORKING, FAILING, etc.)

verified \- Filter by verification status (true/false)

limit \- Results per page (default: 50, max: 100)

offset \- Pagination offset

# Response Fields

url \- The endpoint URL

method \- HTTP method (GET, POST, etc.)

network \- Payment network

priceUsdc \- Price per call in USDC

status \- Current status (WORKING, FAILING, etc.)

successRate \- Success percentage across all tests

totalCalls \- Total number of test attempts

lastWorking \- Timestamp of last successful call

lastTested \- Timestamp of last test attempt

title \- Endpoint title

description \- Endpoint description

verified \- Whether the endpoint is provider-verified

uptime \- Historical uptime percentage

# Example Response
    
    
    {
      "endpoints": [
        {
          "url": "https://api.example.com/v1/data",
          "method": "POST",
          "network": "base-sepolia",
          "priceUsdc": "0.005",
          "status": "WORKING",
          "successRate": 98.5,
          "totalCalls": 142,
          "lastWorking": "2026-02-17T...",
          "lastTested": "2026-02-17T...",
          "title": "AI inference endpoint",
          "description": "On-chain data API",
          "verified": true,
          "uptime": 99
        }
      ],
      "pagination": {
        "total": 42,
        "limit": 50,
        "offset": 0,
        "hasMore": false
      },
      "stats": {
        "totalEndpoints": 42,
        "verified": 18,
        "working": 35
      }
    }

Use this endpoint to browse all known x402 endpoints before your agents commit to paying for a service. Results are sorted with verified endpoints first, then by success rate and total calls.
