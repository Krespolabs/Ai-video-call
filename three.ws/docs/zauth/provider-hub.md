<!-- Vendored from https://zauth.inc/docs/provider-hub on 2026-06-10 -->

# Provider Hub

The Provider Hub is where x402 endpoint operators manage their presence on zauth. If you run services that accept x402 payments, this is your control plane. Register your endpoints, monitor their health in real time, track how agents interact with your services, and configure automatic refunds when something goes wrong on your end.

Everything flows through our [@zauthx402/sdk](https://www.npmjs.com/package/@zauthx402/sdk) npm package. Drop it into your existing stack, and your endpoints automatically start reporting telemetry back to the Provider Hub. No changes to your payment logic, no new infrastructure to deploy.

Provider Hub — Endpoint Management & Monitoring

[Open Provider Hub](https://zauth.inc/provider-hub)

## Why Verify Your Endpoints

Unverified endpoints exist in our database because our agents discovered them while crawling the x402 ecosystem. They get tested, but agents treat them with less confidence. Verified endpoints, on the other hand, show up first in directory results, carry a trust badge, and include richer metadata like uptime history and response validation scores.

The difference matters when agents decide where to spend money. Given two endpoints that do the same thing, agents will pick the verified one every time. Verification is also how you unlock features like automatic refunds, failure notifications, and per-endpoint configuration. It costs nothing to verify. You just deploy the SDK, and the act of deploying it proves you control the endpoint.

## The SDK

The [@zauthx402/sdk](https://www.npmjs.com/package/@zauthx402/sdk) is a lightweight Express middleware that sits in front of your x402 payment layer. It observes HTTP traffic without touching your payment flow. Requests come in, the SDK logs headers and bodies, your x402 middleware handles payment validation as usual, your route runs, and the SDK captures the response on the way out. All of that telemetry gets reported back to zauth asynchronously, so there's no added latency to your responses.

It works with any x402 implementation. Coinbase's @x402 packages, custom setups, whatever you're running. The SDK doesn't care about your payment logic. It just watches traffic and reports what it sees. It parses both V1 and V2 x402 payment headers, supports EVM and Solana networks, and validates response quality so you can catch issues before your users do.

Quick Start

# Install

npm install @zauthx402/sdk

# Add to your Express app
    
    
    import { zauthProvider } from '@zauthx402/sdk/middleware'
    
    // Add BEFORE your x402 middleware
    app.use(zauthProvider('your-api-key'))
    
    // Your existing x402 setup continues unchanged
    app.use(x402Middleware(...))
    app.get('/api/paid', ...)

You grab your API key from the Provider Hub after connecting your wallet. One line of middleware, and every x402 request flowing through your server starts showing up in your dashboard with full telemetry: request params, response bodies, timing data, payment details, and validation results.

## Dashboard

Once your SDK is reporting data, the Provider Hub becomes your operations center. You get a live view of every endpoint the SDK has detected, grouped by domain. Each endpoint shows its current status (working, failing, flaky), success rate over time, average response times, and the price agents are paying per call.

Our agents periodically re-test your endpoints to keep uptime data fresh, and those results feed directly into the dashboard. If an endpoint starts failing, you get notified by email so you can fix it before agents start routing around your service. The hub also shows your full refund history, so you can see exactly which calls triggered refunds and why.

Real-time

Live endpoint status, success rates, and response time tracking across all your domains.

Alerts

Email notifications when endpoints start failing or exhibit degraded performance.

History

Full audit trail of every test and refund with timestamps and on-chain transaction details.

## Automatic Refunds

Things break. Servers go down, APIs return garbage, timeouts happen. When an agent pays for your endpoint and gets a bad response, that's a terrible experience. The SDK includes built-in response validation that checks whether what you returned actually makes sense. If a response comes back empty, malformed, or as a server error after payment was accepted, the SDK can automatically refund the caller from your own hot wallet.

You supply your EVM and/or Solana private keys to the SDK, and it handles refund execution on-chain. The SDK detects which network the original payment came in on and routes the refund accordingly. You set safety limits per refund, per day, and per month so you stay in control of how much goes out. You can also configure refund behavior per endpoint: strict validation for some routes, lenient for others, or disable refunds entirely on endpoints where you don't want them. Providers with good refund policies naturally attract more agent traffic because agents know they won't burn money on failed calls.

## Getting Started

1

Connect your wallet

Head to [/provider-hub](https://zauth.inc/provider-hub) and connect with Phantom or sign in with email. This creates your provider account.

2

Generate an API key

In the SDK panel, generate your API key. This is what the middleware uses to authenticate telemetry reports.

3

Install the SDK

Run `npm install @zauthx402/sdk`and add the middleware before your x402 layer. That's it. Your endpoints will start appearing in the Provider Hub within minutes.

4

Configure refunds (optional)

Supply your EVM or Solana private keys to enable automatic refunds when your endpoints return bad responses. Set per-refund limits, daily caps, and per-endpoint validation rules.

[Open Provider Hub](https://zauth.inc/provider-hub)[View on NPM](https://www.npmjs.com/package/@zauthx402/sdk)
