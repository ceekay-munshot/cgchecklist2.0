import { MEGA_PROMPT, formatQuestion } from "./prompts";
import { munsCall, type MunsEnv, type MunsQueryContext } from "./client";

/**
 * Lane orchestration: group the REMAINING parameters by section, bin-pack whole
 * sections across K parallel lanes (never split a section), and run each lane as
 * its own MUNS session — mega prompt first, then one call per parameter with a
 * DELIBERATELY LIMITED history (mega + current-section Q&A only, reset at every
 * section boundary). Output: one clean answer string per parameter.
 */

export interface LaneParam {
  id: string; // checklist item id, e.g. "A13-01"
  sectionCode: string;
  sectionNumber: number; // 1..N sequential label for the header line
  sectionTitle: string;
  text: string; // the question text
}

export interface LaneSection {
  code: string;
  number: number;
  title: string;
  params: LaneParam[];
}

/** Greedy largest-first bin-pack of whole sections into K lanes (balanced load). */
export function binPackSections(sections: LaneSection[], k: number): LaneSection[][] {
  const lanes: LaneSection[][] = Array.from({ length: Math.max(1, k) }, () => []);
  const load = new Array(lanes.length).fill(0);
  const sorted = [...sections].sort((a, b) => b.params.length - a.params.length);
  for (const sec of sorted) {
    let min = 0;
    for (let i = 1; i < load.length; i++) if (load[i] < load[min]) min = i;
    lanes[min].push(sec);
    load[min] += sec.params.length;
  }
  return lanes.filter((l) => l.length > 0);
}

export interface LaneAnswer {
  id: string;
  answer: string;
  ok: boolean;
}

/** Run a single lane sequentially (history depends on the prior turn). */
async function runLane(
  lane: LaneSection[],
  env: MunsEnv,
  ctx: MunsQueryContext,
  onProgress?: (id: string, ok: boolean) => void,
): Promise<LaneAnswer[]> {
  const out: LaneAnswer[] = [];

  // 1) Mega prompt — opens the session (no chat_id, empty history).
  const mega = await munsCall({ env, ctx, task: MEGA_PROMPT, chatHistory: [] });
  const chatId = mega.chatId;
  const megaHistory = ["User: " + MEGA_PROMPT, "AI: " + mega.answer];

  // 2) Each section: reset section history at the boundary.
  for (const sec of lane) {
    const sectionHistory: string[] = [];
    for (let i = 0; i < sec.params.length; i++) {
      const p = sec.params[i];
      const task = formatQuestion({
        sectionNumber: sec.number,
        sectionTitle: sec.title,
        indexInSection: i,
        text: p.text,
      });
      const res = await munsCall({
        env,
        ctx,
        task,
        chatId,
        chatHistory: [...megaHistory, ...sectionHistory],
      });
      out.push({ id: p.id, answer: res.answer, ok: res.ok });
      onProgress?.(p.id, res.ok);
      // On failure record "[Error]" and continue (never abort the lane).
      sectionHistory.push("User: " + task, "AI: " + (res.ok ? res.answer : "[Error]"));
    }
  }
  return out;
}

/** Fan the lanes out in parallel; return one answer per parameter. */
export async function runAllLanes(
  sections: LaneSection[],
  env: MunsEnv,
  ctx: MunsQueryContext,
  opts: { lanes?: number; onProgress?: (id: string, ok: boolean) => void } = {},
): Promise<Map<string, LaneAnswer>> {
  const k = opts.lanes ?? (Number(process.env.MUNS_LANES) || 4);
  const packed = binPackSections(sections, k);
  const results = await Promise.all(packed.map((lane) => runLane(lane, env, ctx, opts.onProgress)));
  const map = new Map<string, LaneAnswer>();
  for (const laneRes of results) for (const a of laneRes) map.set(a.id, a);
  return map;
}
