// Supabase Edge Function: receives the Stripe webhook on successful
// checkout and flips devices.is_premium for the paying device.
//
// Deploy with: supabase functions deploy stripe-webhook --no-verify-jwt
// (--no-verify-jwt is required because Stripe calls this endpoint directly
// and cannot send a Supabase auth JWT; constructEventAsync's signature
// check against STRIPE_WEBHOOK_SECRET is the real authentication here.)
//
// Required secrets (supabase secrets set ...):
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.

import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  if (!signature) {
    return new Response("missing signature", { status: 400 });
  }

  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
      undefined,
      cryptoProvider
    );
  } catch (err) {
    console.error("signature verification failed", err);
    return new Response("signature verification failed", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const deviceId = session.client_reference_id;

    if (deviceId) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      const { error } = await supabase
        .from("devices")
        .update({
          is_premium: true,
          premium_product_id: session.id,
          premium_transaction_id: (session.payment_intent as string) ?? session.id,
          premium_purchased_at: new Date().toISOString(),
        })
        .eq("id", deviceId);

      if (error) {
        console.error("failed to update device", error);
        return new Response("db update failed", { status: 500 });
      }
    } else {
      console.warn("checkout.session.completed with no client_reference_id", session.id);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
