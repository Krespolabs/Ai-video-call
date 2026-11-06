# From Pump.fun to API Payments: How $THREE Became an x402 Payment Option Inside VS Code

A token can launch in minutes. Giving it a useful role inside real software takes longer.

[$THREE began on Pump.fun](https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump), but the latest three.ws release adds something that does not happen automatically when a coin launches: software can now recognize it as a payment asset, select it from an internet payment request, sign the payment on Solana, and return the result with an on-chain receipt.

That payment path now lives inside Visual Studio Code.

Version 0.2.1 of the [x402 Pay-per-call APIs extension](https://marketplace.visualstudio.com/items?itemName=threews.vscode-x402) lets developers and AI agents inspect paid APIs and pay compatible x402 requests with $THREE on Solana. It also supports USDC on Solana and EVM networks, but the $THREE integration is the part that changes the token's role inside the three.ws ecosystem.

This article explains what shipped, how x402 works, what it means for a Pump.fun-launched token to become usable by developer software, and the limits that matter.

**Official $THREE contract address on Solana:**

`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

Always verify the full address. A ticker alone is not enough to identify a token.

## The important change is functional

Most token announcements concern markets: a listing, a pool, a chart, or a new place to trade. This release concerns product behavior.

A compatible API can quote a price in $THREE. The VS Code extension can read that quote, verify that it names the official mint, show the exact token amount and recipient, ask the user to approve it, sign the Solana payment, retry the request, and display the service's response with its settlement receipt.

That does not mean every API accepts $THREE. The seller must explicitly offer it in the endpoint's x402 payment requirements. It means the buyer-side software now understands the asset and can complete the payment flow when that option is available.

That distinction matters. Support in a wallet or payment client creates capability. Actual usage grows as services choose to accept the asset and users choose to pay with it.

## Pump.fun launches tokens. Product integrations give them places to be used

Pump.fun made token creation and market discovery unusually accessible on Solana. A creator can launch a coin, establish an on-chain mint, and let the market discover it without building a custom token contract or negotiating an exchange listing first.

That solves the launch problem. It does not solve the usage problem.

A newly launched token does not automatically become a payment method for software. Applications must know how to identify it. Sellers must be able to quote prices in it. Buyers need wallets and signing software. Both sides must agree on a network, amount, recipient, and settlement format. The transaction needs to be verifiable, and the buyer needs protection from signing an unexpected payment.

The $THREE integration connects those pieces through x402.

The result is a path from a Pump.fun-launched Solana token to a standards-based payment option for APIs and AI tools. Instead of inventing a private checkout format that only three.ws understands, the extension uses an open HTTP payment protocol and the standard Solana payment scheme implemented by the x402 SDK.

## What x402 does

The web already has a status code named `402 Payment Required`. For decades, it had no widely adopted payment flow behind it.

[x402](https://www.x402.org/) turns that status code into a machine-readable exchange:

1. A buyer requests an API, tool, file, model, or other web resource.
2. The server responds with `402 Payment Required` and describes the payment it accepts.
3. The client chooses a compatible option and signs the payment authorization.
4. The client retries the original request with the payment proof.
5. The server verifies and settles the payment, performs the work, and returns the result with a receipt.

The payment requirements can state the network, token, exact amount, recipient, and payment scheme. Because those instructions are structured data, software can handle them without sending a person through a checkout page.

The [official x402 documentation](https://docs.x402.org/introduction) describes the protocol as an open standard for charging for APIs and content directly over HTTP. Its network documentation also supports arbitrary compatible Solana tokens through SPL transfers. That is the protocol opening the $THREE integration uses.

## Why API payments matter to AI agents

Traditional API billing assumes a human organization:

- Create an account.
- Add a card.
- Select a monthly plan.
- Copy an API key.
- Store and rotate the credential.
- Reconcile usage later.

That process works for teams buying software subscriptions. It is awkward for an autonomous program that encounters a useful service during a task and needs one result.

An AI agent may need a single data lookup, model inference, file conversion, security scan, or generated asset. The service may cost a fraction of a dollar. Creating an account and negotiating a subscription for one call makes no sense.

A wallet-based request changes the model. The service states its price in the response. The client pays for that request. The seller returns the result. There is no standing subscription and no API key that grants continuing access.

This does not remove every concern. Agents still need spending limits, approved networks, secure keys, and rules about which services they may call. It does make payment programmable at the same layer where the service request already happens.

## Why put this inside VS Code?

VS Code is where many developers inspect requests, edit server code, run tests, and evaluate API responses. Before this extension, an x402 workflow could involve several disconnected tools:

- A terminal to request the endpoint
- Raw JSON or encoded headers to understand the price
- A wallet or script to sign
- A block explorer to confirm settlement
- A separate template to build a paid endpoint

The three.ws extension places that loop inside the editor.

A developer can browse services in the x402 Bazaar sidebar, inspect a payment challenge without spending anything, open a service, approve a payment, view the result and transaction receipt, and scaffold a paid endpoint of their own.

The goal is not to make every developer think about blockchain infrastructure. It is to make a paid API feel like an API. The network and token remain visible when the user needs to make a decision, while the repetitive payment plumbing stays inside the tool.

## What version 0.2.1 supports

The current Marketplace release provides four main workflows.

### 1. Inspect before paying

A developer can paste an x402 endpoint into the extension and decode its payment requirements.

Inspection is read-only. It shows the accepted networks, tokens, amounts, schemes, and recipient addresses. It also identifies which option the configured wallets can satisfy.

This is useful even without a wallet. A developer can investigate an endpoint before deciding whether to fund anything.

### 2. Pay and call

When the user chooses to continue, the extension selects an eligible payment requirement, displays the details, requests confirmation, signs the payment, and retries the API call.

For Solana, the extension uses the real `@x402/svm` exact-payment scheme. It can select USDC or $THREE when the endpoint advertises either asset.

For $THREE, the mint must match:

`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

The extension does not trust a token name alone.

### 3. Browse paid services

The Bazaar view lists discoverable HTTP APIs and MCP tools. Developers can filter and search services, inspect their payment requirements, and open them without leaving VS Code.

Discovery is optional. Any compatible URL can be inspected directly, even if it is not listed in a bazaar.

### 4. Scaffold a seller endpoint

The extension can generate the starting structure for a paid API endpoint. This gives developers a path to participate on both sides: pay for a service and build a service that others can pay.

Supporting $THREE on the buyer side is only half of an ecosystem. Sellers also need to advertise $THREE in their payment requirements. The scaffolding and three.ws x402 server tooling are designed to make that path easier.

## How the extension chooses $THREE

An x402 endpoint can offer more than one way to pay. A service might accept USDC on Solana, $THREE on Solana, or USDC on another supported network.

The extension exposes a setting named:

`x402.preferToken`

Its available choices are:

- `auto`
- `usdc`
- `three`

Choosing `three` tells the extension to prefer $THREE when a payable requirement advertises the official mint. It does not rewrite the seller's request, swap tokens automatically, or send $THREE to a service that did not ask for it.

The endpoint remains in control of what it accepts. The buyer remains in control of what it signs.

That is a useful property for an open ecosystem. Token support is negotiated through the request rather than imposed by one marketplace, wallet, or platform.

## The payment flow in plain English

Imagine an API that turns a text prompt into a specialized report.

The user requests the report. The server responds that the report costs a stated amount of $THREE and includes its Solana recipient address. The extension checks that the asset is the official $THREE mint and that the user has configured a Solana wallet.

Before signing, the extension shows:

- The amount in $THREE
- The Solana network
- The paying wallet
- The recipient
- The endpoint being called

If the user approves, the extension signs the exact payment through the Solana x402 scheme and retries the request with proof. The server verifies the proof, returns the report, and includes the settlement result. The extension displays both the report and transaction signature.

The payment is part of the API exchange. There is no separate checkout session to match back to the request.

## Security and spending controls

Adding a private-key wallet to an editor deserves more attention than adding another toolbar button.

The extension keeps separate Solana and EVM wallet keys in VS Code SecretStorage, which uses the operating system's credential storage. Keys are not placed in `settings.json` or workspace configuration.

The two rails are independent. A user can configure only Solana, only EVM, or both.

Payments also have visible confirmation. This is especially important for $THREE because it is not a dollar-pegged asset. A 402 challenge tells the extension the requested token quantity, but it does not provide a trusted fiat conversion. The extension therefore presents $THREE in token units and always requires explicit confirmation before signing.

The configured USD cap applies to stablecoin payments. It should not be treated as a fiat-value guarantee for $THREE.

Users should fund a dedicated, low-balance wallet with only the amount they intend to spend on API calls. SecretStorage reduces accidental exposure, but a limited wallet remains the clearest boundary on possible loss.

## What this utility does and does not mean

The word "utility" is often used loosely in crypto. The useful question is simpler: what can the software do today?

Today, the released VS Code client can:

- Recognize the official $THREE mint in a compatible x402 challenge
- Prefer it when the user selects $THREE
- Sign the corresponding Solana payment
- Retry the paid request
- Display the result and settlement receipt

A compatible seller can offer $THREE as one of the payment choices for an API or tool.

This is implemented functionality. It is not a prediction about token price, future demand, or adoption. It does not guarantee that every x402 service will accept $THREE. It does not turn market activity into product usage by itself.

The next measure is straightforward: useful services need to advertise the token, and users need reasons to call them. Those results can be evaluated through working endpoints and verifiable settlement receipts rather than slogans.

## Why this matters for the $THREE community

For holders and community members, the integration expands what the token can represent inside the product.

A user is no longer limited to viewing a balance or trading a market pair. The same asset can be recognized by software as a payment choice for a specific service.

For developers, it provides a new audience and settlement option. A builder can expose a useful API, publish its payment requirements, and allow a compatible wallet to pay without creating a conventional billing account.

For AI agents, it creates a machine-readable path. An agent can discover that a service costs money, identify the accepted token and network, and prepare a payment through the same HTTP interaction it uses to request the service.

For three.ws, it connects several parts of the platform:

- Solana wallets
- x402 payment infrastructure
- MCP and agent tools
- Paid APIs
- Developer tooling
- The $THREE ecosystem

The significance is not that one button mentions a token. It is that the token has entered the request-and-settlement path used by software.

## A practical bridge from Web2 to Web3

Developers do not adopt new infrastructure because it has a larger vocabulary. They adopt it when it removes work or makes a previously difficult capability easier.

The Web2 developer already understands HTTP requests, APIs, status codes, editor commands, and response bodies. x402 keeps those concepts and adds payment instructions to the same exchange.

The extension reduces the new concepts to a manageable set:

- A service can return a price.
- A wallet can authorize that payment.
- The request can be retried with proof.
- The result can include a receipt.

That is a more realistic onboarding path than asking every developer to become a blockchain specialist before making one paid request.

The long-term opportunity is larger than one extension. If agents increasingly choose tools during execution, software needs ways to evaluate price, authorize small payments, and record what was purchased. Open payment requirements give different clients and sellers a common language.

$THREE now has a defined place in that language on Solana when a seller chooses to accept it.

## How to try it

Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=threews.vscode-x402):

`code --install-extension threews.vscode-x402`

Then:

1. Open the Command Palette.
2. Run **x402: Set Solana Wallet Key**.
3. Enter a dedicated, funded Solana secret key in base58 or JSON byte-array form.
4. Set `x402.bazaarUrl` to `https://three.ws` if you want Bazaar discovery.
5. Set `x402.preferToken` to `three`.
6. Inspect a compatible endpoint before paying.
7. Review the amount, network, payer, and recipient.
8. Confirm only when every field is correct.

An endpoint must advertise the official $THREE mint for the extension to select it.

The complete [x402 for VS Code guide](https://github.com/nirholas/three.ws/blob/main/docs/x402-vscode.md) covers setup and payment behavior. The source repository and release history are available at [github.com/nirholas/vscode-x402](https://github.com/nirholas/vscode-x402).

## What comes next

A payment client creates the connection point. The next phase is expanding the number and quality of services on the other side of that connection.

Useful x402 services may include AI inference, data retrieval, 3D generation, validation, media processing, research, security checks, and agent tools. Each service can publish a price and the assets it accepts. Clients can decide whether the result is worth the cost.

That is how utility becomes measurable: a real service, a clear price, an informed approval, a completed result, and an on-chain receipt.

$THREE started as a Solana token launched through Pump.fun. It can now be recognized and spent by a released x402 payment client inside VS Code when a compatible service offers it.

That is one practical step from a token people can trade toward an asset software can use.

**Official $THREE contract address:**

`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

Verify the address, inspect the request, and understand what you are approving before signing any transaction.
