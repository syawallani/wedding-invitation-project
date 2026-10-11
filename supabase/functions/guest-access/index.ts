import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
});

function corsHeaders(origin: string | null): HeadersInit {
    return {
        "Access-Control-Allow-Origin": origin ?? "",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

function reply(body: Record<string, unknown>, status: number, origin: string | null): Response {
    return Response.json(body, {
        status,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
}

async function hashToken(token: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validToken(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

Deno.serve(async (request: Request) => {
    const origin = request.headers.get("Origin");
    if (origin && !allowedOrigins.includes(origin)) {
        return reply({ error: "origin_not_allowed" }, 403, allowedOrigins[0] ?? "");
    }
    if (request.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405, origin);
    if (!origin || allowedOrigins.length === 0) return reply({ error: "origin_not_configured" }, 403, origin);

    let body: Record<string, unknown>;
    try {
        if (Number(request.headers.get("Content-Length") ?? "0") > 8000) {
            return reply({ error: "request_too_large" }, 413, origin);
        }
        body = await request.json();
    } catch {
        return reply({ error: "invalid_json" }, 400, origin);
    }

    if (!validToken(body.token)) return reply({ error: "invalid_token" }, 400, origin);
    const tokenHash = await hashToken(body.token);
    const action = body.action;

    if (action === "lookup") {
        const { data, error } = await admin
            .from("guest_invitations")
            .select("guest_name, max_guests, rsvp_status, rsvp_guest_count, checked_in_count")
            .eq("token_hash", tokenHash)
            .maybeSingle();
        if (error) return reply({ error: "lookup_failed" }, 500, origin);
        if (!data) return reply({ error: "invitation_not_found" }, 404, origin);
        return reply({ invitation: data }, 200, origin);
    }

    if (action === "rsvp") {
        if (typeof body.attending !== "boolean" || !Number.isInteger(body.guest_count)) {
            return reply({ error: "invalid_rsvp" }, 400, origin);
        }
        const { data: invitation, error: lookupError } = await admin
            .from("guest_invitations")
            .select("max_guests, checked_in_count")
            .eq("token_hash", tokenHash)
            .maybeSingle();
        if (lookupError) return reply({ error: "rsvp_failed" }, 500, origin);
        if (!invitation) return reply({ error: "invitation_not_found" }, 404, origin);
        if (invitation.checked_in_count > 0) return reply({ error: "already_checked_in" }, 409, origin);

        const guestCount = body.attending ? Number(body.guest_count) : 0;
        if (body.attending && (guestCount < 1 || guestCount > invitation.max_guests)) {
            return reply({ error: "guest_count_out_of_range", max_guests: invitation.max_guests }, 400, origin);
        }
        if (!body.attending && body.guest_count !== 0) return reply({ error: "invalid_rsvp" }, 400, origin);

        const { data, error } = await admin
            .from("guest_invitations")
            .update({
                rsvp_status: body.attending ? "attending" : "declined",
                rsvp_guest_count: guestCount,
            })
            .eq("token_hash", tokenHash)
            .select("guest_name, max_guests, rsvp_status, rsvp_guest_count")
            .single();
        if (error) return reply({ error: "rsvp_failed" }, 500, origin);
        return reply({ invitation: data }, 200, origin);
    }

    if (action === "checkin") {
        const authorization = request.headers.get("Authorization") ?? "";
        const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
        if (!accessToken) return reply({ error: "staff_login_required" }, 401, origin);

        const staffClient = createClient(supabaseUrl, anonKey, {
            auth: { autoRefreshToken: false, persistSession: false },
            global: { headers: { Authorization: `Bearer ${accessToken}` } },
        });
        const { data: userData, error: authError } = await staffClient.auth.getUser(accessToken);
        if (authError || !userData.user) return reply({ error: "staff_login_required" }, 401, origin);

        const { data: staff, error: staffError } = await admin
            .from("checkin_staff")
            .select("user_id")
            .eq("user_id", userData.user.id)
            .maybeSingle();
        if (staffError) return reply({ error: "staff_verification_failed" }, 500, origin);
        if (!staff) return reply({ error: "staff_not_allowed" }, 403, origin);

        const { data: checkedIn, error: checkinError } = await admin.rpc("check_in_guest", {
            p_token_hash: tokenHash,
            p_checked_in_by: userData.user.id,
        });
        if (checkinError) return reply({ error: "checkin_failed" }, 500, origin);
        if (checkedIn?.length) return reply({ result: "checked_in", invitation: checkedIn[0] }, 200, origin);

        const { data: invitation, error: lookupError } = await admin
            .from("guest_invitations")
            .select("guest_name, max_guests, rsvp_status, rsvp_guest_count, checked_in_count, checked_in_at, checked_in_by")
            .eq("token_hash", tokenHash)
            .maybeSingle();
        if (lookupError) return reply({ error: "checkin_failed" }, 500, origin);
        if (!invitation) return reply({ error: "invitation_not_found" }, 404, origin);
        if (invitation.rsvp_status !== "attending") {
            return reply({ result: "not_attending", invitation }, 409, origin);
        }
        return reply({ result: "already_checked_in", invitation }, 409, origin);
    }

    return reply({ error: "unknown_action" }, 400, origin);
});
