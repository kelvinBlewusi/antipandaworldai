/**
 * One definition per action (lib/assistant-v2/actions.ts; part G of the
 * reliability plan, owner 2026-10-11). Each action is defined once and the
 * rest is checked against it here, so adding or renaming one can't leave
 * another part out of date: agent mode's tools, the front door's areas, the
 * chat's checks (parseAction) and what it carries out (carryOut, whose
 * every type ACTION_TYPES lists: a missing one doesn't compile), the
 * capability list, the worked examples and the test set.
 */

import { ACTION_DEFS, EVERY_READING, actionDef, actionJson } from "@/lib/assistant-v2/actions";
import { ACTION_TOOLS, AGENT_TOOLS, LOOKUP_TOOLS } from "@/lib/assistant-v2/agent";
import { AREA_ACTIONS, EXAMPLES, NOT_YET_EXAMPLES } from "@/lib/assistant-v2/front-door";
import { ACTION_TYPES, assistantLinks, parseAction, type ProductFacts } from "@/lib/whatsapp/assistant";
import { CAPABILITIES } from "@/lib/jumia/capabilities";
import { ASSISTANT_CASES } from "@/lib/evals/assistant-cases";
import type { ListingRow } from "@/lib/supabase/types";

const NAMES = ACTION_DEFS.map((d) => d.name);
const TYPES = new Set<string>(ACTION_TYPES);
/** What a few actions become once checked: a step is the product's notes; "can you…?" and "not possible" are fixed replies (or not_yet). */
const BECOMES: Record<string, string[]> = { step: ["note"], cannot: ["reply"], capability: ["reply", "not_yet"] };
const DRAFT: ProductFacts = { seq: 1, listing: { id: "l1", title: "Hisense 205L Double Door Fridge", status: "draft" } as ListingRow, variations: [], options: [] };

describe("each action is defined once", () => {
  it("with a unique name, a front door line and a tool", () => {
    expect(new Set(NAMES).size).toBe(NAMES.length);
    for (const d of ACTION_DEFS) {
      expect({ name: d.name, line: d.line.length > 0, does: d.tool.does.length > 0 }).toEqual({ name: d.name, line: true, does: true });
      // Each line shows its own JSON.
      expect({ name: d.name, line: d.line[0] }).toEqual({ name: d.name, line: expect.stringContaining(`{"type":"${d.name}"`) });
      for (const lines of Object.values(d.lineIn ?? {})) expect({ name: d.name, line: lines![0] }).toEqual({ name: d.name, line: expect.stringContaining(`{"type":"${d.name}"`) });
    }
  });

  it("agent mode has a tool for every action, and only those besides the lookups and done", () => {
    expect(ACTION_TOOLS.map((t) => t.name)).toEqual(NAMES);
    // done: only when asked whether anything is left of a message of several parts.
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([...LOOKUP_TOOLS.map((t) => t.name), ...NAMES, "done"]);
  });

  it("the front door offers every action in an area, or in every reading", () => {
    const offered = new Set([...Object.values(AREA_ACTIONS).flat(), ...EVERY_READING]);
    for (const name of offered) expect({ name, defined: !!actionDef(name) }).toEqual({ name, defined: true });
    for (const name of NAMES) expect({ name, offered: offered.has(name) }).toEqual({ name, offered: true });
    // A line for an area is only for an area that offers it.
    for (const d of ACTION_DEFS) {
      for (const area of Object.keys(d.lineIn ?? {})) expect({ name: d.name, area, offers: AREA_ACTIONS[area as keyof typeof AREA_ACTIONS].includes(d.name) }).toEqual({ name: d.name, area, offers: true });
    }
  });

  it("the chat's checks carry out every action's sample, as an action it does", () => {
    const links = assistantLinks();
    for (const d of ACTION_DEFS) {
      if (!d.sample) {
        // Only asking back has none: the readers ask it themselves, never parseAction.
        expect(d.name).toBe("clarify");
        continue;
      }
      const action = parseAction(JSON.stringify(actionJson(d.name, d.sample.args)), d.sample.message, [DRAFT], links);
      const want = BECOMES[d.name] ?? [d.name];
      expect({ name: d.name, got: action.type, ok: want.includes(action.type) && TYPES.has(action.type) }).toEqual({ name: d.name, got: action.type, ok: true });
    }
  });

  it("every action the capability list names is one", () => {
    for (const c of CAPABILITIES.filter((x) => x.action)) expect({ id: c.id, action: c.action, defined: !!actionDef(c.action!) }).toEqual({ id: c.id, action: c.action, defined: true });
  });

  it("every worked example shows an action that exists", () => {
    const examples = [...Object.values(EXAMPLES).flat(), ...NOT_YET_EXAMPLES];
    expect(examples.length).toBeGreaterThan(40);
    for (const e of examples) {
      const type = e.split(" → ").at(-1)!.match(/"type":"([a-z_]+)"/)?.[1];
      expect({ e, defined: !!type && !!actionDef(type) }).toEqual({ e, defined: true });
    }
  });

  it("every answer in the test set is an action the chat carries out", () => {
    for (const c of ASSISTANT_CASES) {
      for (const shape of c.ok) expect({ id: c.id, type: shape.type, known: TYPES.has(String(shape.type)) }).toEqual({ id: c.id, type: shape.type, known: true });
    }
  });
});
