# $THREE Is Now a Payment Option for x402 APIs Inside VS Code

Most tokens begin in the same place: a launch, a market, and a community.

The harder step is giving software a reason to recognize the asset.

[$THREE launched through Pump.fun on Solana](https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump). It can now move through a different kind of rail: a developer can install the three.ws x402 extension for Visual Studio Code, inspect a compatible paid API, choose $THREE when the service accepts it, approve the payment, and receive the result with an on-chain receipt.

That feature is live in version 0.2.1 on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=threews.vscode-x402).

Official $THREE contract address:

`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

## From a coin people trade to an asset software can use

Pump.fun solves a specific problem. It gives a token an on-chain identity and a path into a market.

It does not automatically make that token useful inside applications.

For an API to accept a token, the seller has to describe the price, network, asset, and recipient in a form the buyer understands. The buyer needs a compatible wallet and a safe way to sign. The seller must verify the payment and connect it to the exact request that purchased the service.

That is what x402 coordinates.

The protocol activates HTTP's long-reserved `402 Payment Required` status code. A server can respond to an unpaid request with structured payment instructions. A compatible client signs the requested payment and retries. The server verifies it, performs the work, and returns the result.

The payment becomes part of the web request instead of a separate checkout.

## What the VS Code extension changes

The three.ws extension brings that entire flow into the place where developers already build and test APIs.

A user can:

- Browse discoverable x402 services
- Inspect an endpoint without spending anything
- See its accepted networks, tokens, amount, and recipient
- Pay a compatible service from a Solana or EVM wallet
- Read the API response and settlement receipt together
- Scaffold a paid endpoint of their own

Version 0.2.1 adds a dedicated Solana wallet and recognizes $THREE as a supported payment choice.

When an endpoint advertises the official $THREE mint, the user can set `x402.preferToken` to `three`. The extension verifies the mint, displays the token amount and recipient, requests confirmation, signs through the standard `@x402/svm` exact scheme, and retries the call with payment proof.

The extension cannot force a service to accept $THREE. The seller must offer it. That keeps the system open and explicit: sellers choose what they accept, and buyers choose what they sign.

## Why this matters to people who do not write code

APIs are how software buys capabilities from other software.

A weather application uses an API to retrieve a forecast. An AI agent uses APIs to search data, generate media, analyze contracts, or call a model. A game uses APIs for storage, identity, and live services.

Traditionally, paying for those capabilities means an account, a card, a subscription, and an API key.

x402 offers another model: quote the price when the request arrives and pay for that individual result.

A person may never read the payment header or write the request. Their application or AI agent can handle the protocol. The person still defines the wallet, limits, and approval rules.

That is why developer tooling matters to a token community. Developers decide which assets software can accept. An integration inside a widely used editor lowers the amount of custom work required to add that payment path.

## What "utility" means here

It does not mean a prediction about price.

It does not mean every service suddenly accepts $THREE.

It means a released payment client can perform a specific function with the asset:

1. Detect an x402 request offering $THREE
2. Verify the official mint
3. Select it as the preferred token
4. Sign the Solana payment
5. Retry the API request
6. Return the work and its receipt

That function is visible in the product and inspectable in the source repository.

Adoption is the next question. More sellers need to offer useful services, and users need to decide those services are worth calling. The evidence should be working endpoints and settlement receipts.

## Security comes before convenience

A wallet inside an editor can spend real funds, so the extension treats signing as a security boundary.

Solana and EVM keys are stored separately in VS Code SecretStorage, backed by the operating system's credential manager. They do not belong in workspace settings or a committed environment file.

For $THREE payments, the extension shows the amount in token units and requires explicit confirmation. A 402 challenge does not provide a trusted dollar conversion for a non-stable asset, so the normal USD spending cap cannot be treated as a valuation guard.

The safest setup is a dedicated, low-balance wallet funded only for API calls.

## One step toward easier Web3 onboarding

The best bridge from Web2 to Web3 may be a familiar workflow with one new capability.

Developers already understand HTTP. They already understand status codes, APIs, and response bodies. They already spend much of their day in VS Code.

With x402, payment becomes another machine-readable part of the request:

Request the service. Read the price. Approve the payment. Receive the result.

The blockchain is still there. The user can inspect the network, token, recipient, and receipt. But developers do not need to build a new checkout system just to charge for one API call.

That is the direction three.ws is pursuing: make on-chain tools usable inside workflows people already know.

## Try it

Install the extension:

`code --install-extension threews.vscode-x402`

Marketplace:

https://marketplace.visualstudio.com/items?itemName=threews.vscode-x402

Guide:

https://github.com/nirholas/three.ws/blob/main/docs/x402-vscode.md

Source:

https://github.com/nirholas/vscode-x402

To prefer $THREE, configure a dedicated Solana wallet and set:

`x402.preferToken: three`

The endpoint must advertise the official mint:

`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

$THREE began on Pump.fun. It now has a defined path through a live developer payment client.

The next milestone is not a slogan. It is more useful services, more informed payments, and more receipts proving that software used the rail.
