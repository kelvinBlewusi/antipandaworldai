"use client";

/**
 * Take product photos with the device's camera, live, from the web chat
 * (owner, 2026-10-11: "let's add a camera icon to the chat to allow users
 * take live photos"). On a phone the camera button opens the phone's own
 * camera app (CameraButton's `capture` input: full quality, the camera the
 * seller knows). On a laptop or desktop it opens this window with the webcam:
 * each photo taken goes straight into the message being written, and the
 * window stays open for the next one until Done.
 */

import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, SwitchCamera, X } from "lucide-react";

/** A phone or tablet, where the camera app is better than a webcam window. */
function usesCameraApp(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** The camera button beside Upload: the phone's camera app, or the webcam window. */
export function CameraButton({ disabled, room, onPhotos, tile = false }: {
  disabled?: boolean;
  /** How many more photos the message (or the product card) can take. */
  room: number;
  onPhotos: (files: File[]) => void;
  /** The product form's look: a small dashed tile saying "Camera", beside its "Photos" tile. */
  tile?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // The room when the window opened: photos taken there count against it as they're added.
  const [openRoom, setOpenRoom] = useState(0);
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
        onClick={() => { if (usesCameraApp()) input.current?.click(); else { setOpenRoom(room); setOpen(true); } }}
        disabled={disabled || room <= 0}
        className={tile
          ? "flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-zinc-300 text-[11px] font-medium text-zinc-500 hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50"
          : "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 transition-colors hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50"}
        aria-label="Take a photo"
        title="Take a photo"
      >
        <Camera className="h-5 w-5 text-orange-500" />
        {tile && "Camera"}
      </button>
      {open && (
        <CameraWindow
          room={openRoom}
          onPhoto={(file) => onPhotos([file])}
          onClose={() => setOpen(false)}
          onUseFiles={() => { setOpen(false); input.current?.click(); }}
        />
      )}
    </>
  );
}

function CameraWindow({ room, onPhoto, onClose, onUseFiles }: {
  room: number;
  onPhoto: (file: File) => void;
  onClose: () => void;
  /** No camera here, or it was refused: choose photos instead. */
  onUseFiles: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [cameras, setCameras] = useState(0);
  const [state, setState] = useState<"starting" | "ready" | "failed">("starting");
  const [problem, setProblem] = useState("");
  const [taken, setTaken] = useState(0);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setState("starting");
      stream.current?.getTracks().forEach((t) => t.stop());
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem("This browser can't use a camera here.");
        setState("failed");
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => undefined);
        }
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        setCameras(devices.filter((d) => d.kind === "videoinput").length);
        setState("ready");
      } catch (e) {
        const name = (e as { name?: string }).name;
        setProblem(name === "NotAllowedError"
          ? "The camera was blocked. Allow it in your browser's address bar, or choose photos instead."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No camera was found on this device."
            : "The camera couldn't start. Close other apps using it and try again, or choose photos instead.");
        setState("failed");
      }
    }
    void start();
    return () => { cancelled = true; };
  }, [facing]);

  // The camera is let go of when the window closes.
  useEffect(() => () => { stream.current?.getTracks().forEach((t) => t.stop()); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const left = room - taken;

  function shoot() {
    const v = video.current;
    if (!v || !v.videoWidth || left <= 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // The front camera's preview is mirrored; the photo isn't.
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      onPhoto(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
      setTaken((n) => n + 1);
      setFlash(true);
      setTimeout(() => setFlash(false), 150);
    }, "image/jpeg", 0.92);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-0 sm:p-6" role="dialog" aria-modal="true" aria-label="Take a photo">
      <div className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden bg-black sm:h-auto sm:rounded-2xl">
        <div className="flex items-center justify-between px-4 py-3 text-white">
          <span className="text-sm font-medium">
            {taken > 0 ? `${taken} photo${taken === 1 ? "" : "s"} added to your message` : "Point the camera at the product"}
          </span>
          <button type="button" onClick={onClose} aria-label="Close the camera" className="rounded-full p-1.5 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="relative flex min-h-[50vh] flex-1 items-center justify-center bg-black sm:aspect-video sm:min-h-0">
          <video
            ref={video}
            playsInline
            muted
            className={`h-full w-full object-contain ${facing === "user" ? "-scale-x-100" : ""} ${state === "ready" ? "" : "invisible"}`}
          />
          {flash && <div className="pointer-events-none absolute inset-0 bg-white/70" />}
          {state === "starting" && <Loader2 className="absolute h-8 w-8 animate-spin text-white/70" />}
          {state === "failed" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white">
              <p className="max-w-sm text-sm">{problem}</p>
              <button type="button" onClick={onUseFiles} className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-100">
                Choose photos instead
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
            disabled={state !== "ready" || cameras < 2}
            aria-label="Switch camera"
            className="flex h-11 w-11 items-center justify-center rounded-full text-white hover:bg-white/10 disabled:opacity-30"
          >
            <SwitchCamera className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={shoot}
            disabled={state !== "ready" || left <= 0}
            aria-label="Take the photo"
            className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-white bg-white/20 transition-transform active:scale-95 disabled:opacity-40"
          >
            <span className="h-11 w-11 rounded-full bg-white" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-w-11 rounded-xl px-3 py-2 text-sm font-semibold text-white hover:bg-white/10"
          >
            {taken > 0 ? "Done" : "Cancel"}
          </button>
        </div>
        {left <= 0 && <p className="pb-3 text-center text-xs text-white/70">That&apos;s the most for one message. Send these first.</p>}
      </div>
    </div>
  );
}
