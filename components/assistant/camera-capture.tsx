"use client";

/**
 * Take product photos live from the web chat (owner, 2026-10-11: "let's add
 * a camera icon to the chat to allow users take live photos"), on phones and
 * tablets only ("it should not appear on laptop"). It opens the phone's own
 * camera app (a `capture` file input: full quality, the camera the seller
 * knows); the photos go into the message, like Upload's.
 */

import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";

/** A phone or tablet: a touch screen as the main pointer, or a mobile browser. */
export function isPhoneOrTablet(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.("(pointer: coarse)").matches) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** The camera button beside Upload (or a "Camera" tile on a product card); nothing on a laptop or desktop. */
export function CameraButton({ disabled, room, onPhotos, tile = false, label = "Take a photo", tileLabel = "Camera" }: {
  disabled?: boolean;
  /** How many more photos the message (or the product card) can take. */
  room: number;
  onPhotos: (files: File[]) => void;
  /** The product form's look: a small dashed tile saying "Camera", beside its "Photos" tile. */
  tile?: boolean;
  /** Its words in the chat's language (lib/i18n/chat.ts). */
  label?: string;
  tileLabel?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  // Known only in the browser: drawn after the first render, so the server's page matches.
  const [phone, setPhone] = useState(false);
  useEffect(() => { setPhone(isPhoneOrTablet()); }, []);
  if (!phone) return null;
  return (
    <>
      <input
        ref={input}
        type="file"
        // JPEG/PNG/WebP, as the chat takes: iPhones then hand over a JPEG, not HEIC.
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(e) => { if (e.target.files?.length) onPhotos(Array.from(e.target.files)); e.target.value = ""; }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled || room <= 0}
        className={tile
          ? "flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-zinc-300 text-[11px] font-medium text-zinc-500 hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50"
          : "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 transition-colors hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50"}
        aria-label={label}
        title={label}
      >
        <Camera className="h-5 w-5 text-orange-500" />
        {tile && tileLabel}
      </button>
    </>
  );
}
