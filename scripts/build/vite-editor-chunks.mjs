// Keep each dependency family together to preserve module initialization order.
export const editorChunkGroups = [
  { name: "parser-vendor", test: /node_modules[\\/]@lezer[\\/]/, tags: ["$initial"], priority: 2 },
  { name: "editor-vendor", test: /node_modules[\\/]@codemirror[\\/]/, tags: ["$initial"], priority: 1 },
];
