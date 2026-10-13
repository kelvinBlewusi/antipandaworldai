/**
 * app_settings switches for the chat: "all", "admins", or a list of user
 * ids; off without the row or on error. Its own module so the chat's parts
 * (fix-rejected, readiness) read them without importing the assistant.
 */

import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";

/** An app_settings switch: "all", "admins", or a list of user ids. Off without the row or on error. */
export async function switchedOnFor(key: string, userId: string): Promise<boolean> {
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", key).maybeSingle();
    const v = data?.value as unknown;
    if (v === "all") return true;
    if (v === "admins") return isAdmin(userId);
    return Array.isArray(v) && v.includes(userId);
  } catch {
    return false;
  }
}

/**
 * Whether the chat follows up on what Jumia needs (owner, 2026-10-13;
 * docs/plan-2026-10-13-ask-what-jumia-needs.md): a rejected product's
 * question stays open until it's answered, a failed check goes back to the
 * model once, and what a category's quality check needs is asked before a
 * draft is sent. app_settings `assistant_followup`; off without the row.
 */
export async function followupFor(userId: string): Promise<boolean> {
  return switchedOnFor("assistant_followup", userId);
}
