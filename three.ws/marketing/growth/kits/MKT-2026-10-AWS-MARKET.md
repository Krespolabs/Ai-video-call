# MKT-2026-10-AWS-MARKET: enterprise procurement in front of agent-native pay-per-call usage

**Kit status:** copy complete and **held**. The AWS Marketplace listing does not exist yet (campaigns.csv
status `awaiting_listing`), and production cannot accept a subscriber: on 2026-09-17
`POST https://three.ws/api/aws-marketplace/subscription` answered `{"error":"not_configured"}`. Every
"is live" sentence below stays unpublished until a buyer can subscribe end to end.

## At a glance

| Field | Value |
|---|---|
| Campaign id | `MKT-2026-10-AWS-MARKET` |
| Publish date | 2026-10-20, or the first business day after AWS reviews the launch copy, whichever is later |
| Summary | three.ws becomes subscribable in AWS Marketplace: a free subscription links an AWS account to a three.ws access key, and agents pay per call over HTTP 402 for what they use |
| Audience | enterprise buyers and cloud builders |
| Primary channel | AWS Marketplace launch (the listing itself) |
| Secondary channels | AWS Builder Center, LinkedIn, X, three.ws news |
| Proof | https://three.ws/aws |
| Tracked links | X `https://three.ws/aws?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-10-aws-market&utm_content=anchor`; LinkedIn `...utm_source=linkedin&utm_medium=social&...&utm_content=post`; Builder Center `...utm_source=aws-builder-center&utm_medium=partner&...&utm_content=launch-note`; AWS repost `...utm_source=aws&utm_medium=partner&...&utm_content=partner-repost` |
| The single CTA | Open the listing or request a demo |
| Partner ask | Review the launch assets and repost the live announcement |
| KPI | listing visits, agreements, and AWS amplification |

`{{LISTING_URL}}` is the public AWS Marketplace product URL, available after Seller Operations publishes
the product (7 to 10 business days per the listing kit). `{{PRODUCT_ID}}` is the product id the
Management Portal assigns.

## Audit: what already exists

| Channel | Existing asset | State | How this kit uses it |
|---|---|---|---|
| The listing (primary) | [docs/aws-marketplace-listing-kit.md](../../../docs/aws-marketplace-listing-kit.md) | Fields drafted; prerequisites unmet | Is the primary channel. Its short description and highlights need an owner rewrite before submission: they name specific third-party crypto projects, which this kit deliberately does not repeat |
| Backend reference | [docs/aws-marketplace.md](../../../docs/aws-marketplace.md) | Current | Source for the env and IAM steps |
| AWS Builder Center long-form | [docs/aws-builder-center.md](../../../docs/aws-builder-center.md) (two published articles), [docs/aws-partner-spotlight.md](../../../docs/aws-partner-spotlight.md) | Published and drafted | Unchanged; this kit adds the short launch note |
| Social launch copy, news, AWS review and repost messages | none | Missing | Written below |

## Blockers, in order

1. From seller account `155407237916`, create the metering IAM key and the EventBridge relay secret
   listed in [docs/aws-marketplace.md](../../../docs/aws-marketplace.md) and set them on `three-ws-api`
   with `gcloud run services update --update-env-vars` (config-only, pre-approved).
2. Rewrite the listing short description and highlights around the 3D agent product, then create the
   product in the AWS Marketplace Management Portal and wait for publication.
3. Send this kit's copy to AWS for review (message 1), then publish.

## X

**Media:** capture the live `{{LISTING_URL}}` product page at 1600x900 on launch day. Do not reuse a
`/aws` capture: that page's hero names a specific payment token, which this kit keeps out.
**Alt text:** The three.ws product page in AWS Marketplace, showing the free subscription option.

**Anchor** (171 weighted characters):

```text
three.ws is live in AWS Marketplace. A free subscription links your AWS account to an access key; agents then pay per call over HTTP 402: https://three.ws/aws?utm_source=x&utm_medium=social&utm_campaign=mkt-2026-10-aws-market&utm_content=anchor @awscloud
```

**Thread (optional):**

2/
```text
Why split it that way: procurement and vendor onboarding happen once, through the AWS account you already manage. Usage is paid per call, so an agent's spend follows the work it actually does.
```

3/
```text
How we put AWS Marketplace metering in front of an HTTP 402 API, written for the AWS Builder Center: https://builder.aws.com/content/3ESpll50BdSp9eiCEIxcfG9pGUN/how-we-metered-a-saas-product-through-aws-marketplace-with-the-aws-sdk-for-javascript-v3
```

## LinkedIn

```text
Enterprise teams that want to try AI agents with a visible 3D presence usually stall at the same step: vendor onboarding.

three.ws is now available in AWS Marketplace. Subscribing is free. The subscription links your AWS account to a three.ws account and issues an access key, so procurement, account ownership, and cancellation run through the AWS account your organization already manages. Usage is then paid per call over HTTP 402, so what an agent spends tracks the calls it actually makes rather than a seat count.

What the key unlocks: browser-native 3D AI agents that embed on any page with one tag, and the pay-per-call tools those agents use.

The integration is open source, and we wrote up how the AWS Marketplace side works on the AWS Builder Center.

three.ws is an AWS Partner.

Open the listing: {{LISTING_URL}}
```

(125 words; one link. Tracked alternative if the listing URL does not unfurl:
`https://three.ws/aws?utm_source=linkedin&utm_medium=social&utm_campaign=mkt-2026-10-aws-market&utm_content=post`.)

## AWS Builder Center launch note

**Title:** three.ws is now subscribable in AWS Marketplace

```text
The AWS Marketplace listing for three.ws is live: {{LISTING_URL}}

What subscribing does: the subscription is free. It links your AWS account to a three.ws account through the SaaS fulfillment flow and issues an access key. Usage is then paid per call over HTTP 402, exactly as for any other caller, so AWS Marketplace handles procurement and the account relationship while each call carries its own payment.

If you read our earlier article on putting Marketplace metering in front of an HTTP 402 API, this is that integration in production. One change since it was published: new products use Concurrent Agreements and EventBridge notifications, so buyers are keyed by license rather than by customer identifier.

Questions from builders wiring the same pattern are welcome in the comments.
```

## three.ws news blurb

three.ws is now available in AWS Marketplace. The subscription is free and links an AWS account to a
three.ws access key, and usage is paid per call over HTTP 402, so organizations can adopt three.ws
through AWS procurement they already use. Listing: {{LISTING_URL}}.

## Partner messages

AWS's [seller marketing guidance](https://docs.aws.amazon.com/marketplace/latest/userguide/product-marketing.html)
says AWS reviews blogs, tweets, and other non-press announcements before they go public, asks sellers to
notify AWS when they post and will "do our best to repost", and routes press release review through the
seller's account manager. Address both messages to the AWS Marketplace account manager assigned in the
Management Portal; no name is recorded in the repo.

**1. Review request, as soon as the listing is published:**

```text
Subject: three.ws launch announcement for review ({{PRODUCT_ID}})

Our SaaS product {{PRODUCT_ID}} is published at {{LISTING_URL}}. Per the AWS Marketplace seller marketing guidance, attached for review before anything is posted:

1. X post and thread (text attached)
2. LinkedIn post (text attached)
3. AWS Builder Center launch note (text attached)
4. Product page screenshot and alt text

None of it describes the relationship as a partnership or alliance, and there is no press release. We plan to post on {{PLANNED_POST_DATE}} once you confirm, and will send the live links the same day.
```

**2. Notify and repost request, the day it posts:**

```text
Subject: three.ws AWS Marketplace announcement is live

The reviewed announcement is now posted:
X: {{X_POST_URL}}
LinkedIn: {{LINKEDIN_POST_URL}}
AWS Builder Center: {{BUILDER_CENTER_URL}}

Your guidance mentions AWS may repost seller announcements to increase visibility; we would be grateful for a repost of the X or LinkedIn post.
```

## T+7 result fields

| Field | Source |
|---|---|
| Listing visits | AWS Marketplace Management Portal, listing traffic report |
| Agreements (subscriptions) | Management Portal agreements view; `aws_marketplace` customer rows in production |
| Landing sessions | web analytics, `utm_campaign=mkt-2026-10-aws-market` |
| AWS amplification | repost or comment URL, or "none" |

## Claims check

| Claim | Proof | Verified |
|---|---|---|
| Listing not live; subscription endpoint not configured | `POST /api/aws-marketplace/subscription` returned `not_configured` | 2026-09-17 |
| Subscription is free; links an AWS account and issues an access key; usage paid per call over HTTP 402 | [docs/partners.md](../../../docs/partners.md) AWS section; `/aws` page cards "Free AWS subscription" and "One key, every x402 endpoint" | 2026-09-17 |
| AWS Partner, Software Path | `/aws` badge; [docs/partners.md](../../../docs/partners.md) | 2026-09-17 |
| The Builder Center metering article exists | [docs/aws-builder-center.md](../../../docs/aws-builder-center.md), article 1 | repo |
| Concurrent Agreements and EventBridge, keyed by license | same doc, "Since publication" | repo |
| AWS reviews non-press announcements and may repost; press releases must not say partnership | AWS seller marketing guidance page | 2026-09-17 |
| Integration code is open source | `api/aws-marketplace/` in the Apache-2.0 repo | repo |

Dropped: "bill usage to your AWS invoice" and commitment drawdown (removed from `/aws` on 2026-09-16 as
untrue), VPC deployment and IAM-integrated access from the `/partners` card (not provable from the code),
and every payment token or chain name.

## Owner does

Set the AWS Marketplace env vars on `three-ws-api`, create the product in the Management Portal, and when
it publishes, send review message 1 with this kit's copy.
