interface ResumeSection {
  title: string;
  text: string;
  required?: boolean;
}

interface PackSectionsOptions {
  reserveTokens?: number;
  omissionGuidance?: Record<string, string>;
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

export function packSections(
  header: string,
  sections: ResumeSection[],
  budget: number,
  options: PackSectionsOptions = {}
): PackedSections {
  if (!budget) {
    const markdown = [header, ...sections.map((section) => section.text)].join("\n\n").trimEnd();
    return { markdown, omittedSections: [], truncatedSections: [] };
  }

  const contentBudget = Math.max(1, budget - Math.max(0, options.reserveTokens || 0));
  const omittedSections: string[] = [];
  const truncatedSections: string[] = [];
  let output = header.trimEnd();
  let used = estimateTokens(output);

  for (const section of sections) {
    const sectionTokens = estimateTokens(section.text);
    const remaining = contentBudget - used;

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
    const note = formatOmittedSections(omittedSections, options.omissionGuidance);
    if (estimateTokens(output + note) <= contentBudget) {
      output += note;
    } else {
      const compactNote = `\n\n## Omitted For Budget\n- ${omittedSections.join(", ")}`;
      if (estimateTokens(output + compactNote) <= contentBudget) {
        output += compactNote;
      }
    }
  }

  return { markdown: output.trimEnd(), omittedSections, truncatedSections };
}

function formatOmittedSections(omittedSections: string[], guidance: Record<string, string> = {}): string {
  const lines = omittedSections.map((title) => {
    const detail = guidance[title];
    return detail ? `- ${title}: ${detail}` : `- ${title}`;
  });
  return `\n\n## Omitted For Budget\n${lines.join("\n")}`;
}
