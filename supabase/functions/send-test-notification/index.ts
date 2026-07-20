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

// Called directly from the browser (docs/app.js via supabase.functions.invoke),
// which means the browser sends a CORS preflight (OPTIONS) request first
// because it includes an Authorization header. Without these headers on
// every response, the browser blocks the request before it ever reaches
// this code, surfacing as a generic "FunctionsFetchError" / net::ERR_FAILED
// with no useful detail on the client side.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY_RAW")!
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "missing_authorization" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("web_push_subscription")
    .eq("id", userData.user.id)
    .single();

  if (deviceError || !device?.web_push_subscription) {
    return jsonResponse({ error: "no_subscription" }, 400);
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
    return jsonResponse({ ok: true }, 200);
  } catch (err) {
    console.error("test notification failed", err);
    return jsonResponse({ ok: false, error: String(err) }, 502);
  }
});
