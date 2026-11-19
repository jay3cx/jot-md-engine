import { type Text } from "@codemirror/state";
import { type Decoration, type DecorationSet } from "@codemirror/view";
import { quotePrefix } from "../../components/common/quote-prefix.js";

export interface QuotedCodeLine {
  readonly from: number;
  readonly to: number;
  readonly physicalLine: number;
  readonly codeOwner: string;
  readonly quoteOwner: string;
  readonly depth: number;
  readonly prefix: string;
  readonly prefixTo: number;
  readonly marker: Decoration;
}

/** Resolve only a painted Rust-confirmed quoted code body, not a fence line. */
export function quotedCodeLineAt(decorations: DecorationSet, doc: Text, position: number): QuotedCodeLine | undefined {
  const line = doc.lineAt(position);
  let codeOwner: string | undefined, depth: number | undefined, quoteOwner: string | undefined;
  let marker: { to: number; decoration: Decoration } | undefined;
  decorations.between(line.from, line.to, (from, to, decoration) => {
    const spec = decoration.spec;
    if (from === line.from && spec.jotLiveSourceLine === true) {
      const attributes = spec.attributes as Record<string, string> | undefined;
      const value = Number(attributes?.["data-jot-quote-depth"]);
      if (typeof attributes?.["data-jot-code-owner"] === "string" &&
          Number.isSafeInteger(value) && value > 0 &&
          attributes?.["data-jot-line-number"] !== undefined) {
        codeOwner = attributes["data-jot-code-owner"];
        depth = value;
      }
    }
    if (from === line.from && to > from && to <= line.to &&
        spec.jotLiveQuotePrefix === true && typeof spec.jotLiveNode === "string") {
      quoteOwner = spec.jotLiveNode;
      marker = { to, decoration };
    }
  });
  if (codeOwner === undefined || depth === undefined || quoteOwner === undefined || marker === undefined ||
      marker.to - line.from > 512) return undefined;
  const prefix = doc.sliceString(line.from, marker.to), parsed = quotePrefix(prefix, 0, depth);
  if (parsed?.depth !== depth || parsed.to !== prefix.length) return undefined;
  return { from: line.from, to: line.to, physicalLine: line.number, codeOwner, quoteOwner, depth,
    prefix, prefixTo: marker.to, marker: marker.decoration };
}
