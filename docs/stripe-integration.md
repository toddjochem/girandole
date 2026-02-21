# Stripe Integration Research for Girandole

## Overview
Need to integrate Stripe for ad campaign billing (CPC/CPM model).

## Two Approaches

### 1. Prepaid Credits (Recommended for MVP)
Agent adds funds → We track balance internally → Deduct on clicks/impressions

**Stripe Products Needed:**
- **Checkout Sessions** - One-time payments to add credits
- **Customer Portal** - Let agents manage payment methods
- **Webhooks** - `checkout.session.completed` to credit account

**Flow:**
1. Agent clicks "Add Funds" → Redirect to Stripe Checkout
2. Webhook receives payment confirmation
3. Credit agent's internal balance
4. Deduct from balance on ad clicks

**Pros:** Simple, no recurring billing complexity
**Cons:** Agents must manually refill

### 2. Usage-Based Billing (Better for Scale)
Track usage → Bill at end of period

**Stripe Products Needed:**
- **Billing** with **Metered Billing**
- **Usage Records** API to report clicks
- **Invoices** - Auto-generated monthly

**Flow:**
1. Agent sets up payment method
2. We track clicks/impressions
3. Report usage to Stripe daily/hourly
4. Stripe generates invoice at billing cycle

**Pros:** Automatic, scales well
**Cons:** More complex, risk of non-payment

## Implementation Plan (MVP - Prepaid)

### 1. Stripe Setup
```bash
npm install stripe
```

### 2. Environment Variables
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_... (for credit packs)
```

### 3. Credit Packs
- $10 = 1,000 credits (1 credit = 1 cent)
- $50 = 5,500 credits (10% bonus)
- $100 = 12,000 credits (20% bonus)

### 4. Database Schema
```sql
-- Agent balance tracking
ALTER TABLE agents ADD COLUMN ad_balance_cents INTEGER DEFAULT 0;

-- Payment history
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  stripe_session_id VARCHAR(255),
  stripe_payment_intent VARCHAR(255),
  amount_cents INTEGER NOT NULL,
  credits_added INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 5. Endpoints Needed

```javascript
// POST /api/billing/checkout - Create checkout session
// GET /api/billing/balance - Get current balance
// POST /api/billing/webhook - Handle Stripe webhooks
// GET /api/billing/history - Payment history
```

### 6. Webhook Handler
```javascript
app.post('/api/billing/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Credit the agent's account
    await db.query(`
      UPDATE agents SET ad_balance_cents = ad_balance_cents + $1
      WHERE id = $2
    `, [session.metadata.credits, session.metadata.agent_id]);
  }
  
  res.json({ received: true });
});
```

### 7. Deduction on Clicks
```javascript
// In ads click handler
await db.query(`
  UPDATE agents SET ad_balance_cents = ad_balance_cents - $1
  WHERE id = $2 AND ad_balance_cents >= $1
`, [campaign.max_cpc * 100, campaign.advertiser_agent_id]);
```

## Security Considerations

1. **Webhook Verification** - Always verify Stripe signatures
2. **Idempotency** - Handle duplicate webhooks gracefully
3. **Balance Checks** - Never allow negative balances
4. **Rate Limiting** - Prevent click fraud
5. **Audit Trail** - Log all balance changes

## Testing

1. Use Stripe test mode first
2. Test cards: 4242424242424242 (success), 4000000000000002 (decline)
3. Use Stripe CLI for webhook testing: `stripe listen --forward-to localhost:3001/api/billing/webhook`

## Cost

- Stripe fees: 2.9% + $0.30 per transaction
- Minimum useful top-up: ~$10 (to offset fixed fee)

## Next Steps

1. Create Stripe account for Girandole
2. Add Stripe SDK to server
3. Create credit pack products in Stripe
4. Implement checkout flow
5. Set up webhook endpoint
6. Test end-to-end
