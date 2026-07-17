// Supabase Edge Function: lets a signed-in device send itself one test
// push, so a user can confirm notifications actually work without waiting
// for a real restock. Unlike stripe-webhook, this IS called by a
// Supabase-authenticated browser session, so it's deployed WITH the
// platform's default JWT verification (no --no-verify-jwt flag) — Supabase
// rejects unauthenticated requests before this code even runs.
//
// Deploy with: supabase functions deploy send-test-notification
//
// Required secrets (supabase secrets set ...):
//   VAPID_PRIVATE_KEY_RAW, VAPID_PUBLIC_KEY, VAPID_SUBJECT
// (SUPABASE_URL / SUPABASE_ANON_KEY are auto-injected by Supabase.)
//
// Uses the same VAPID key pair as worker/webpush_client.py — both must be
// generated together via worker/generate_vapid_keys.py so the private key
// used here actually matches the public key the browser subscribed with.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY_RAW")!
);

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "missing_authorization" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("web_push_subscription")
    .eq("id", userData.user.id)
    .single();

  if (deviceError || !device?.web_push_subscription) {
    return new Response(JSON.stringify({ error: "no_subscription" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    await webpush.sendNotification(
      device.web_push_subscription,
      JSON.stringify({
        title: "テスト通知",
        body: "この通知が届いていれば、プッシュ通知は正常に動作しています。",
        url: "./",
      })
    );
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("test notification failed", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
});
