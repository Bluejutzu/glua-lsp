// Renders a package CHANGELOG.md as an Update-timeline MDX page — used for
// both docs/changelog.mdx (glua-gmod) and docs/cli-changelog.mdx (glua-cli),
// so neither can drift apart from what actually shipped.

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

export function renderChangelogDocs(
  markdown,
  {
    repoUrl,
    // Called per version to name its git tag. Defaults to the old bare
    // `vX.Y.Z` scheme; a resolver that switches schemes partway through a
    // package's history (e.g. once independent per-package tags were
    // adopted) can check the version and branch accordingly.
    resolveTag = (version) => `v${version}`,
    title = 'Changelog',
    description = 'Notable changes, release by release.',
  },
) {
  const versions = parseSections(markdown).filter((section) => VERSION_HEADING.test(section.title));

  const updates = versions.map((section, i) => {
    const label = i === 0 ? `${section.title} (latest)` : section.title;
    const body = section.body.replace(/^### (.+)$/gm, '**$1**');
    return `<Update label="${label}" description={<a href="${repoUrl}/releases/tag/${resolveTag(section.title)}">View release on GitHub ↗</a>}>\n${body}\n</Update>`;
  });

  return `---
title: "${title}"
description: "${description}"
icon: "clock"
sidebarTitle: "${title}"
---

Each GitHub release lists every commit. This page covers what actually
changed for you — see the [full history on GitHub](${repoUrl}/releases).

${updates.join('\n\n')}
`;
}
