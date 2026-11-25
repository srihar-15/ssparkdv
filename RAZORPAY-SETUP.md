# SPARK-DV Razorpay order flow

Every submitted order is persisted before the provider checkout loads. The full UUID is the database primary key; the displayed reference is `SDV-` followed by the entire UUID. Retrying a saved order keeps that ID. Each checkout attempt has its own UUID and each provider payment has its own Razorpay payment ID.

Payment state is separate from delivery state. Only a verified captured payment matching the saved provider order, exact amount in paise and INR can mark an order paid. Closing checkout is a customer-reported event, not proof of failure. Customer and Pipeline sessions and ownership checks remain separate.

## Activate provider delivery (dashboard step)

In the Razorpay account that owns the configured **test** API keys, add a webhook:

- URL: `https://sparkdv-admin-cart.dealatecorp.chatgpt.site/api/payments/webhook`
- Secret: the `RAZORPAY_WEBHOOK_SECRET` value in the original project's ignored `.env.local`. This same value is configured as a production runtime secret in Sites. Do not use the API key secret or commit this value.
- Events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`.
- Enable the webhook in test mode. Configure the live-mode webhook separately when live keys are supplied.

The endpoint validates HMAC-SHA256 over the original bytes before parsing JSON, atomically records payment events and payment completion, deduplicates identical payloads, and does not downgrade paid orders when failures arrive late. An unmatched order returns 503 so a notification that races database persistence can retry. Unsupported event types are acknowledged without changing the order.

Razorpay setup documentation: https://razorpay.com/docs/webhooks/setup-edit-payments/
Validation documentation: https://github.com/razorpay/markdown-docs/blob/master/webhooks/validate-test.md

## Recovery and boundaries

Opening or refreshing an order reconciles its status against Razorpay's API. A provider outage still displays the saved order with a warning. Customers can retry an unpaid order from its detail screen. No background reconciliation schedule has been configured. Refunds, disputes, wallet/reward workflows and WhatsApp notifications from the Asquare app are not part of this product checkout change.

Payment history shows up to the latest 100 events; all events remain stored. The webhook secret is configured, but provider delivery is not active until the dashboard subscription is enabled. No real funds were charged during verification.

## Checks

`node --test scripts/payment-webhook.test.mjs`

`node scripts/order-lifecycle.test.mjs`

Tests cover invalid signatures, amount/currency mismatch, authorized versus captured status, duplicate and late notifications, storage errors, unique full references, retry idempotency, failed-order retention, server-side pricing and customer ownership.
