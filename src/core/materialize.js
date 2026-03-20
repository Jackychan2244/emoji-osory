export function materializeCodepoints(codepointSequence) {
  if (!Array.isArray(codepointSequence) || codepointSequence.length === 0) {
    return "";
  }

  const scalarValues = codepointSequence.map((codepoint) =>
    Number.parseInt(String(codepoint), 16),
  );

  return String.fromCodePoint(...scalarValues);
}

export function createEmojiIdentifier(codepointSequence) {
  return Array.isArray(codepointSequence) ? codepointSequence.join("-") : "";
}
