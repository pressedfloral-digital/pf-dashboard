import { Webhook } from "svix";
import { headers } from "next/headers";
import { WebhookEvent } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    return new Response("Missing webhook secret", { status: 500 });
  }

  const headerPayload = await headers();
  const svix_id = headerPayload.get("svix-id");
  const svix_timestamp = headerPayload.get("svix-timestamp");
  const svix_signature = headerPayload.get("svix-signature");

  if (!svix_id || !svix_timestamp || !svix_signature) {
    return new Response("Missing svix headers", { status: 400 });
  }

  const payload = await req.json();
  const body = JSON.stringify(payload);

  const wh = new Webhook(WEBHOOK_SECRET);
  let evt: WebhookEvent;

  try {
    evt = wh.verify(body, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    }) as WebhookEvent;
  } catch (err) {
    console.error("Webhook verification failed:", err);
    return new Response("Invalid webhook signature", { status: 400 });
  }

  if (evt.type === "user.created") {
    const { id, email_addresses, first_name, last_name, public_metadata } = evt.data;

    const email = email_addresses?.[0]?.email_address ?? "";
    const full_name =
      [first_name, last_name].filter(Boolean).join(" ") ||
      (public_metadata?.full_name as string) ||
      (public_metadata?.team_member_name as string) ||
      email;

    // These are set by the admin when sending the invite
    const role = (public_metadata?.role as string) ?? "user";
    const location = (public_metadata?.location as string) ?? null;
    const department = (public_metadata?.department as string) ?? null;
    const team_member_name = (public_metadata?.team_member_name as string) ?? null;
    const manager_id = (public_metadata?.manager_id as string) ?? null;
    const invited_by = (public_metadata?.invited_by as string) ?? null;

    const { error } = await supabase.from("user_profiles").upsert({
      clerk_user_id: id,
      email,
      full_name,
      role,
      location,
      department,
      team_member_name,
      manager_id,
      invited_by,
    });

    if (error) {
      console.error("Failed to create user profile:", error);
      return new Response("Database error", { status: 500 });
    }

    console.log("Created profile for:", email, "role:", role);
  }

  return new Response("OK", { status: 200 });
}
