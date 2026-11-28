import { environmentSecrets, redactOutboundText } from './privacy.mjs';
import { SKILL_SLUG_RE } from './skills.mjs';

const PREFERENCE_PATTERNS = [
  /\b(?:always|please always|make sure to always)\s+([^.!?\n]{8,180})/i,
  /\b(?:never|do not ever|don't ever|please never)\s+([^.!?\n]{8,180})/i,
  /\b(?:i prefer|we prefer|prefer using|prefer to)\s+([^.!?\n]{8,180})/i,
  /\b(?:remember that|note that|for future reference[,:]?)\s+([^.!?\n]{8,180})/i,
];

function scrub(text, extraSecrets) {
  const base = redactOutboundText(String(text || ''), extraSecrets || environmentSecrets()).text;
  return base
    .replace(/(\b(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)['"]?[^\s'"]{4,}['"]?/gi, '$1[redacted secret]')
    .replace(/((?:^|\s)(?:-p|--password(?:=|\s+)|-u\s+[^\s:]+:))['"]?[^\s'"]{4,}['"]?/gi, '$1[redacted secret]')
    .trim();
}

function stripUntrustedBlocks(text) {
  return String(text || '')
    .replace(/<attached_file\b[^>]*>[\s\S]*?<\/attached_file>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
}

export function slugifySkillName(raw, fallback = 'saved-workflow') {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/^✦\s*conclave\s*:\s*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (cleaned && SKILL_SLUG_RE.test(cleaned)) return cleaned;
  return fallback;
}

/**
 * Deterministic, 0ms, zero-token episodic memory extractor.
 * Extracts durable user preferences, verified coding recipes, and Conclave council decisions
 * without storing noisy one-off chatter or any secrets.
 */
export function extractEpisodicMemories(task, events = [], { extraSecrets = null } = {}) {
  if (!task || task.fixtureId || task.crewMember) return [];
  const list = Array.isArray(events) ? events : [];
  const scope = task.sourcePath ? `project:${task.sourcePath}` : 'global';
  const results = [];
  const seenTitles = new Set();

  const add = (item) => {
    const title = scrub(item.title, extraSecrets).replace(/[\r\n]+/g, ' ').slice(0, 118);
    const content = scrub(item.content, extraSecrets).slice(0, 1400);
    if (!title || content.length < 16) return;
    const key = title.toLowerCase();
    if (seenTitles.has(key)) return;
    seenTitles.add(key);
    results.push({
      scope: item.scope || scope,
      title,
      content,
      tags: item.tags || ['auto-learned'],
    });
  };

  // 1. Durable user preferences / conventions stated in objective or follow-ups (strip attached files & code blocks first!)
  const userTexts = [
    stripUntrustedBlocks(task.objective || ''),
    ...(Array.isArray(task.followups) ? task.followups.map(f => stripUntrustedBlocks(f?.message || '')) : []),
  ].filter(Boolean);
  for (const raw of userTexts) {
    const cleanRaw = scrub(raw, extraSecrets);
    for (const re of PREFERENCE_PATTERNS) {
      const m = re.exec(cleanRaw);
      if (!m) continue;
      const statement = m[0].trim();
      if (statement.length < 14 || statement.length > 220) continue;
      // Skip ephemeral references like "always return JSON" from internal prompts
      if (/planner|decision envelope|agent\.spawn/i.test(statement)) continue;
      const shortTopic = m[1].trim().split(/\s+/).slice(0, 6).join(' ');
      add({
        scope,
        title: `Preference: ${shortTopic}`,
        content: `Owner preference observed in "${task.title || 'session'}": ${statement}.`,
        tags: ['auto-learned', 'preference'],
      });
      break;
    }
  }

  // 2. Conclave 2.0 Council Decision / Verdict episode
  const conclaveDone = [...list].reverse().find(e => e.type === 'conclave.completed');
  if (conclaveDone?.data) {
    const lastReply = [...list].reverse().find(e => e.type === 'model.response' && typeof e.data?.response?.text === 'string');
    const verdictExcerpt = scrub(String(lastReply?.data?.response?.text || ''), extraSecrets).replace(/\s+/g, ' ').trim().slice(0, 700);
    const specs = (conclaveDone.data.specialists || []).map(s => s.name || s.slug).join(', ');
    if (verdictExcerpt.length >= 40) {
      add({
        scope,
        title: `Conclave Verdict: ${scrub(task.title || task.objective || 'Council', extraSecrets).replace(/^✦\s*Conclave:\s*/i, '').slice(0, 80)}`,
        content: `Mode: ${conclaveDone.data.modeLabel || conclaveDone.data.mode} (${conclaveDone.data.rounds || 2} rounds${specs ? ` · ${specs}` : ''}).\nSummary: ${verdictExcerpt}`,
        tags: ['auto-learned', 'conclave'],
      });
    }
  }

  // 3. Verified Coding / Project Episode (files modified + tests/checks passed or completed cleanly)
  const modifiedFiles = new Set();
  const passedChecks = [];
  for (const ev of list) {
    if (ev.type === 'tool.completed' && ev.data?.status === 'succeeded') {
      if (['repo.write', 'repo.patch', 'repo.delete', 'repo.move'].includes(ev.data.name) && ev.data?.result?.path) {
        modifiedFiles.add(ev.data.result.path);
      }
      if (ev.data.name === 'process.run' && ev.data?.result?.exitCode === 0 && ev.data?.args?.command) {
        const cmd = scrub(String(ev.data.args.command), extraSecrets).slice(0, 120);
        if (!passedChecks.includes(cmd)) passedChecks.push(cmd);
      }
    }
  }
  if (modifiedFiles.size > 0 && task.status === 'completed') {
    const lastReply = [...list].reverse().find(e => e.type === 'model.response' && typeof e.data?.response?.text === 'string');
    const summaryLine = scrub(String(lastReply?.data?.response?.text || ''), extraSecrets).replace(/\s+/g, ' ').trim().slice(0, 480);
    const filesLine = [...modifiedFiles].slice(0, 10).join(', ');
    const checksLine = passedChecks.slice(0, 4).join(' ; ');
    add({
      scope,
      title: `Episode: ${scrub(task.title || task.objective || 'Workspace task', extraSecrets).slice(0, 88)}`,
      content: [
        `Objective: ${scrub(String(task.objective || ''), extraSecrets).slice(0, 240)}`,
        `Modified files: ${filesLine}`,
        ...(checksLine ? [`Verified commands: ${checksLine}`] : []),
        ...(summaryLine ? [`Outcome: ${summaryLine}`] : []),
      ].join('\n'),
      tags: ['auto-learned', 'episode'],
    });
  }

  return results.slice(0, 3);
}

/**
 * Distills a completed task or Conclave run into a clean, reusable slash-command Skill (`/<slug>`).
 */
export function distillTaskToSkill({ task, events = [], name = '', description = '', mode = null, extraSecrets = null } = {}) {
  if (!task) throw Object.assign(new Error('Task is required to create a skill.'), { code: 'INVALID_SKILL', status: 400 });
  const list = Array.isArray(events) ? events : [];
  const slug = slugifySkillName(name || task.title || task.objective || 'custom-workflow');
  const rawDesc = String(description || task.title || task.objective || '').replace(/\s+/g, ' ').trim();
  const cleanDesc = scrub(rawDesc, extraSecrets).slice(0, 180) || `Reusable workflow distilled from ${slug}`;

  const toolsUsed = [...new Set(
    list
      .filter(e => e.type === 'tool.completed' && e.data?.status === 'succeeded' && e.data?.name)
      .map(e => e.data.name)
  )].slice(0, 12);

  const passedCommands = [...new Set(
    list
      .filter(e => e.type === 'tool.completed' && e.data?.name === 'process.run' && e.data?.result?.exitCode === 0 && e.data?.args?.command)
      .map(e => scrub(String(e.data.args.command), extraSecrets).slice(0, 140))
  )].slice(0, 5);

  const conclaveDone = [...list].reverse().find(e => e.type === 'conclave.completed');
  const lastReply = [...list].reverse().find(e => e.type === 'model.response' && typeof e.data?.response?.text === 'string');
  const outcomePreview = scrub(String(lastReply?.data?.response?.text || ''), extraSecrets).slice(0, 900).replace(/```/g, '``\u200b`');

  const lines = [
    `# ${scrub(task.title || slug, extraSecrets)}`,
    '',
    '## Target Input',
    '$ARGUMENTS',
    '',
    '## Reusable Playbook',
    scrub(String(task.objective || ''), extraSecrets).slice(0, 1200) || 'Apply this workflow to the target input above.',
  ];

  if (conclaveDone?.data) {
    const specs = (conclaveDone.data.specialists || []).map(s => `- \`${s.slug}\` (${s.name || s.slug})`).join('\n');
    lines.push(
      '',
      `## Conclave Council Pattern (${conclaveDone.data.modeLabel || conclaveDone.data.mode}, ${conclaveDone.data.rounds || 2} rounds)`,
      specs || '- Parallel multi-specialist synthesis',
      'Coordinate these specialists concurrently, cross-check assumptions, and synthesize a single verified deliverable.'
    );
  }

  if (toolsUsed.length) {
    lines.push('', '## Proven Tools & Steps', `Use these verified capabilities as needed: ${toolsUsed.map(t => `\`${t}\``).join(', ')}.`);
  }

  if (passedCommands.length) {
    lines.push('', '## Verification Checks', ...passedCommands.map(cmd => `- Run \`${scrub(cmd, extraSecrets)}\``));
  }

  if (outcomePreview) {
    lines.push('', '## Reference Output Standard (Excerpt)', '```markdown', outcomePreview, '```');
  }

  const effectiveMode = mode || (task.planMode ? 'plan' : (task.workspaceKind === 'conversation' ? 'any' : 'build'));
  return {
    name: slug,
    description: cleanDesc,
    mode: effectiveMode,
    body: lines.join('\n').trim(),
  };
}
