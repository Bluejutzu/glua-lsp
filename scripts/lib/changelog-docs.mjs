// Renders packages/glua-lsp/CHANGELOG.md as the Update-timeline MDX page at
// docs/changelog.mdx, so the two can't drift apart after a release.

const VERSION_HEADING = /^\d+\.\d+\.\d+/;

function parseSections(markdown) {
  const headingRe = /^## (.+)$/gm;
  const heads = [];
  let match;
  while ((match = headingRe.exec(markdown))) {
    heads.push({ title: match[1].trim(), matchStart: match.index, bodyStart: match.index + match[0].length });
  }
  return heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].matchStart : markdown.length;
    return { title: head.title, body: markdown.slice(head.bodyStart, end).trim() };
  });
}

export function renderChangelogDocs(markdown, { repoUrl }) {
  const versions = parseSections(markdown).filter((section) => VERSION_HEADING.test(section.title));

  const updates = versions.map((section, i) => {
    const label = i === 0 ? `${section.title} (latest)` : section.title;
    const body = section.body.replace(/^### (.+)$/gm, '**$1**');
    return `<Update label="${label}" description={<a href="${repoUrl}/releases/tag/v${section.title}">View release on GitHub ↗</a>}>\n${body}\n</Update>`;
  });

  return `---
title: "Changelog"
description: "Notable changes to GLua for Garry's Mod, release by release."
icon: "clock"
sidebarTitle: "Changelog"
---

Each GitHub release lists every commit. This page covers what actually
changed for you — see the [full history on GitHub](${repoUrl}/releases).

${updates.join('\n\n')}
`;
}
