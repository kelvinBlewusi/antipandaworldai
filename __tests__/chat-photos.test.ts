/**
 * The web chat's photos and the product form (owner's web chat, 2026-10-11):
 * a sandal photo sent in the chat was answered with the form, the form was
 * closed, and every form opened after it came up empty.
 */

import { chatPhotos, openingCards, type ChatMessage, type FormDraft } from "@/components/assistant/chat-photos";

const at = (hhmm: string) => `2026-10-11T${hhmm}:00.000Z`;
const photo = (hhmm: string, id: string, text: string | null = null): ChatMessage => ({
  direction: "inbound", type: "image", text, at: at(hhmm),
  payload: { imageMediaId: `web:u/assistant/${id}.png`, link: `https://x/${id}.png` },
});
const offer = (hhmm: string, id = "form"): ChatMessage => ({
  direction: "outbound", type: "button", text: "📸 Got your photos. 📝 Your products: …", at: at(hhmm),
  payload: { buttons: [{ id, title: "Open the form" }] },
});
const said = (hhmm: string, text: string, direction: "inbound" | "outbound" = "inbound"): ChatMessage => ({ direction, type: "text", text, at: at(hhmm), payload: null });

// The owner's conversation, as the page has it.
const chat: ChatMessage[] = [
  said("12:08", "i want to list one product"),
  offer("12:08", "form 1"),
  photo("12:36", "sandal"),
  offer("12:36"),
  said("12:55", "let list this product"),
  said("12:55", "Let's list! How many products are you listing today?", "outbound"),
  { direction: "inbound", type: "interactive", text: "1", at: at("12:55"), payload: { label: "1 product" } },
  offer("12:55", "form 1"),
];

describe("photos sent in the chat go in the form", () => {
  // New products reads the chat up to now.
  beforeAll(() => jest.useFakeTimers({ now: new Date(at("13:00")) }));
  afterAll(() => jest.useRealTimers());

  it("the form offered for a photo has it, opened again later too", () => {
    expect(chatPhotos(chat, 3)).toEqual([{ mediaId: "web:u/assistant/sandal.png", preview: "https://x/sandal.png" }]);
    // The form offered after "1", and New products (the whole chat).
    expect(chatPhotos(chat, 7).map((p) => p.mediaId)).toEqual(["web:u/assistant/sandal.png"]);
    expect(chatPhotos(chat, chat.length).map((p) => p.mediaId)).toEqual(["web:u/assistant/sandal.png"]);
    // Before the photo was sent: none.
    expect(chatPhotos(chat, 1)).toEqual([]);
  });

  it("an album's photos all go, in the order sent", () => {
    const album: ChatMessage = {
      direction: "inbound", type: "image", text: null, at: at("12:36"),
      payload: { imageMediaIds: ["web:a", "web:b"], link: "https://x/a", links: ["https://x/a", "https://x/b"] },
    };
    expect(chatPhotos([photo("12:30", "first"), offer("12:30"), album, offer("12:36")], 4).map((p) => p.mediaId))
      .toEqual(["web:u/assistant/first.png", "web:a", "web:b"]);
  });

  it("not photos a form batch took, nor ones the bot answered with something else, nor old ones", () => {
    const drafted: ChatMessage = { ...photo("12:40", "sandal"), text: "🧾 1 product from the form\n1. GHS 120" };
    expect(chatPhotos([...chat.slice(0, 4), drafted, said("12:41", "Drafting…", "outbound"), offer("12:50")], 7)).toEqual([]);
    // "add photos to the kettle": the bot's answer wasn't the form.
    expect(chatPhotos([photo("12:36", "kettle"), said("12:36", "📸 Got 1 photo for the kettle. Send more, or tap Done.", "outbound"), offer("12:40")], 3)).toEqual([]);
    // Seven hours on.
    expect(chatPhotos([photo("05:00", "old"), offer("05:00"), said("12:00", "list", "inbound"), offer("12:00")], 3)).toEqual([]);
  });
});

describe("the form opens as it was closed", () => {
  const card = (over: Partial<FormDraft>): FormDraft => ({ key: "k", photos: [], price: "", quantity: "", sizes: "", colour: "", notes: "", polish: false, ...over });
  const sandal = { mediaId: "web:u/assistant/sandal.png", preview: "https://x/sandal.png" };

  it("a first opening: the chat's photos on card 1, as many cards as asked", () => {
    const cards = openingCards(null, 2, [sandal], 10);
    expect(cards).toHaveLength(2);
    expect(cards[0].photos.map((p) => p.mediaId)).toEqual([sandal.mediaId]);
    expect(cards[1].photos).toEqual([]);
  });

  it("kept work comes back, the chat's photo not added twice, unfinished uploads dropped", () => {
    const kept = [card({
      price: "120", sizes: "40, 41",
      photos: [
        { key: "a", preview: sandal.preview, mediaId: sandal.mediaId, uploading: false },
        { key: "b", preview: "blob:x", uploading: true },
        { key: "c", preview: "blob:y", uploading: false, error: "Didn't upload" },
      ],
    })];
    const cards = openingCards(kept, 1, [sandal], 10);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ price: "120", sizes: "40, 41" });
    expect(cards[0].photos.map((p) => p.key)).toEqual(["a"]);
  });

  it("photos sent after it was closed: on a card without photos, or a new card", () => {
    const later = { mediaId: "web:u/assistant/bag.png", preview: "https://x/bag.png" };
    const withEmpty = openingCards([card({ key: "1", price: "120", photos: [{ key: "a", preview: sandal.preview, mediaId: sandal.mediaId, uploading: false }] }), card({ key: "2" })], 1, [sandal, later], 10);
    expect(withEmpty.map((c) => c.photos.map((p) => p.mediaId))).toEqual([[sandal.mediaId], [later.mediaId]]);
    const full = openingCards([card({ key: "1", photos: [{ key: "a", preview: sandal.preview, mediaId: sandal.mediaId, uploading: false }] })], 1, [later], 10);
    expect(full.map((c) => c.photos.map((p) => p.mediaId))).toEqual([[sandal.mediaId], [later.mediaId]]);
  });
});
