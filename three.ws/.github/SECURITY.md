# Security Policy

We take the security of three.ws and the people who use it seriously. Thank you for helping keep the platform and its users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, use one of these private channels:

- **GitHub Security Advisories** (preferred): [Open a private advisory](https://github.com/nirholas/three.ws/security/advisories/new)
- **Email**: [security@three.ws](mailto:security@three.ws)

This mirrors our machine-readable policy at [`/.well-known/security.txt`](https://three.ws/.well-known/security.txt).

Please include, where possible:

- A description of the issue and its impact.
- Steps to reproduce, a proof of concept, or affected URLs / routes / SDK packages.
- Any relevant logs, requests, or screenshots.

## What to expect

- **Acknowledgement** within 3 business days.
- **An initial assessment** (severity + planned next steps) within 7 business days.
- **Coordinated disclosure**: we will work with you on a fix and a disclosure timeline, and credit you in the advisory unless you prefer to remain anonymous.

## Scope

In scope: this repository, the three.ws web app and APIs, the published SDKs, and the official MCP servers.

Out of scope: vulnerabilities in third-party dependencies that are already publicly known and have an upstream fix pending, social-engineering attacks, and reports from automated scanners without a demonstrated, reproducible impact.

## Supported versions

three.ws is a continuously deployed platform; the deployed `main` branch is the only supported version. Security fixes ship to production directly.
