interface ResumeSection {
  title: string;
  text: string;
  required?: boolean;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

export function clipToTokenBudget(text: string, budget: number): string {
  if (!budget || budget <= 0) {
    return "";
  }

  const maxChars = Math.max(0, budget * 4);
  const value = String(text || "");

  if (value.length <= maxChars) {
    return value;
  }

  const clipped = value.slice(0, maxChars);
  const newline = clipped.lastIndexOf("\n");
  const boundary = newline > maxChars * 0.65 ? newline : maxChars;
  return `${clipped.slice(0, boundary).trimEnd()}\n\n[Truncated to fit budget]`;
}

export interface PackedSections {
  markdown: string;
  omittedSections: string[];
  truncatedSections: string[];
}

export function packSections(header: string, sections: ResumeSection[], budget: number): PackedSections {
  if (!budget) {
    const markdown = [header, ...sections.map((section) => section.text)].join("\n\n").trimEnd();
    return { markdown, omittedSections: [], truncatedSections: [] };
  }

  const omittedSections: string[] = [];
  const truncatedSections: string[] = [];
  let output = header.trimEnd();
  let used = estimateTokens(output);

  for (const section of sections) {
    const sectionTokens = estimateTokens(section.text);
    const remaining = budget - used;

    if (remaining <= 20) {
      omittedSections.push(section.title);
      continue;
    }

    if (sectionTokens <= remaining) {
      output = `${output}\n\n${section.text.trimEnd()}`;
      used += sectionTokens;
      continue;
    }

    if (section.required) {
      output = `${output}\n\n${clipToTokenBudget(section.text, remaining)}`;
      truncatedSections.push(section.title);
      used = estimateTokens(output);
    } else {
      omittedSections.push(section.title);
    }
  }

  if (omittedSections.length > 0) {
    const note = `\n\n## Omitted For Budget\n${omittedSections.map((title) => `- ${title}`).join("\n")}`;
    if (estimateTokens(output + note) <= budget) {
      output += note;
    }
  }

  return { markdown: output.trimEnd(), omittedSections, truncatedSections };
}
