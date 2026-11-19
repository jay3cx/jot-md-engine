import { EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { resolveOptimisticQuoteEdit } from "../../../src/hosts/live-preview/optimistic-quote.js";

/** A one-row prefix change must not walk every projected quote decoration. */
export function livePreviewQuoteLocalityRegression(): void {
  const row = ">>>> 正文\n", count = 5_000, source = row.repeat(count);
  const ranges: Range<Decoration>[] = [];
  for (let index = 0; index < count; index += 1) {
    const from = index * row.length;
    ranges.push(Decoration.line({ jotLiveNode: "quote-root", jotLiveSourceLine: true,
      class: "jot-live-preview-native-block--block-quote",
      attributes: { "data-jot-quote-depth": "4", "data-jot-quote-open": index === 0 ? "4" : "0",
        "data-jot-quote-close": index === count - 1 ? "4" : "0" },
    }).range(from));
    ranges.push(Decoration.replace({ jotLiveNode: "quote-root", jotLiveStructural: true,
      jotLiveQuotePrefix: true }).range(from, from + 5));
  }
  const decorations = Decoration.set(ranges, true);
  const queries: Array<{ from: number; to: number }> = [];
  const observed = new Proxy(decorations, {
    get(target, key, receiver) {
      if (key === "between") return (from: number, to: number, visit: (start: number, end: number, value: Decoration) => void) => {
        queries.push({ from, to });
        return target.between(from, to, visit);
      };
      return Reflect.get(target, key, receiver);
    },
  }) as DecorationSet;
  const from = Math.floor(count / 2) * row.length;
  const state = EditorState.create({ doc: source });
  const transaction = state.update({ changes: { from: from + 3, to: from + 5, insert: "" } });
  const result = resolveOptimisticQuoteEdit(observed, transaction);
  if (result === undefined) throw new Error("expected the ordinary quote depth change to be locally proven");
  if (queries.length === 0 || queries.length > 8 || queries.some(query => query.from !== query.to)) {
    throw new Error(`quote change must only look up affected row boundaries: ${JSON.stringify(queries)}`);
  }
}
