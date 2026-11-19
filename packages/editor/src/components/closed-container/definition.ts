import type { MarkdownComponentDefinition } from "../contracts.js";
import { closedContainerInteractionAdapter } from "./interaction.js";
import {
  createClosedContainerModel,
  type ClosedContainerModel,
} from "./model.js";

export const closedContainerComponentDefinition:
MarkdownComponentDefinition<ClosedContainerModel> = {
  id: "markdown-closed-container",
  schemaVersion: 1,
  nodeKinds: ["fenced-code", "math-block"],
  createModel: createClosedContainerModel,
  capabilities: {
    interaction: closedContainerInteractionAdapter,
    inspect: true,
  },
};
