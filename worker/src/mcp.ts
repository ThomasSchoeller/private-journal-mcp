// ABOUTME: The MCP server definition — same five tools as the local stdio server
// ABOUTME: Tool names, descriptions and argument shapes are kept identical on purpose

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { JournalToken } from './auth/tokens.js';
import {
  PROJECT_SECTIONS,
  SECTION_HEADINGS,
  SECTION_KEYS,
  formatLocalDate,
  formatTitle,
  isSectionKey,
  renderEntryMarkdown,
  type SectionKey,
  type Thoughts,
} from './entry.js';
import { journalTimeZone, type Env } from './env.js';
import { bm25ToScore, buildMatchQuery, snippetToText } from './search.js';
import {
  getEntry,
  insertEntry,
  listEntries,
  looksLikeEntryId,
  readEntries,
  searchEntries,
  type EntrySummary,
  type Scope,
  type ScopeFilter,
} from './store.js';

export interface McpContext {
  env: Env;
  token: JournalToken;
}

const scopeArg = z
  .enum(['project', 'user', 'both'])
  .default('both')
  .describe('Search in project-specific notes, user-global notes, or both (default: both)');

/** Accepts either a section key (`technical_insights`) or its heading (`Technical Insights`). */
function normalizeSection(value: string): SectionKey | null {
  const normalized = value.toLowerCase().replace(/[^a-z]+/g, '_');
  if (isSectionKey(normalized)) return normalized;
  return SECTION_KEYS.find((key) => key.startsWith(normalized)) ?? null;
}

function sectionHeadings(sections: SectionKey[]): string {
  return sections.map((section) => SECTION_HEADINGS[section]).join(', ');
}

function displayDate(createdAt: number, timeZone: string): string {
  return new Date(createdAt).toLocaleDateString('en-US', { timeZone });
}

/** `Path:` keeps its label so search output can still be piped into read_journal_entry. */
function summaryLines(entry: EntrySummary, timeZone: string, excerpt: string): string {
  return (
    `${displayDate(entry.createdAt, timeZone)} (${entry.scope}${entry.project ? `/${entry.project}` : ''})\n` +
    `   Sections: ${sectionHeadings(entry.sections)}\n` +
    `   Path: ${entry.id}\n` +
    `   Excerpt: ${excerpt}\n`
  );
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function sinceTimestamp(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

/** Resolves `journal://entry/<id>` and bare ids; rejects filesystem paths. */
export function parseEntryReference(reference: string): string {
  const trimmed = reference.trim();
  const uri = /^journal:\/\/entry\/(.+)$/.exec(trimmed);
  const candidate = uri ? uri[1] : trimmed;
  if (looksLikeEntryId(candidate.toUpperCase())) return candidate.toUpperCase();
  throw new Error(
    `'${reference}' is not a journal entry id. This journal is stored remotely, not on disk: ` +
      `pass the id from the 'Path:' line of a search or list result, e.g. ` +
      `'01ARZ3NDEKTSV4RRFFQ69G5FAV' or 'journal://entry/01ARZ3NDEKTSV4RRFFQ69G5FAV'.`
  );
}

export function createJournalServer(context: McpContext): McpServer {
  const { env, token } = context;
  const timeZone = journalTimeZone(env);
  const server = new McpServer({ name: 'private-journal-mcp', version: '2.0.1' });

  server.registerTool(
    'process_thoughts',
    {
      description:
        'Your PRIVATE JOURNAL for learning and reflection. Write to any combination of these completely private spaces. Nobody but you will ever see this. Use it to clarify your thoughts and reflections and to record observations.',
      inputSchema: z.object({
        reflections: z
          .string()
          .optional()
          .describe(
            "Your PRIVATE SPACE for integrated thinking — what you noticed, felt, understood, or processed. No structure required, no judgment, no performance. Most journal entries live here: the mix of thinking-through, noticing, and emotional processing that doesn't split cleanly into categories. Be honest, be vulnerable, vent when you need to. Nobody but you will ever see this."
          ),
        observations: z
          .string()
          .optional()
          .describe(
            'Your PRIVATE SPACE for short, discrete noticings — the one-or-two-sentence things that don\'t belong in a longer reflection but you want to be able to search back for later. "I noticed X." "Y keeps coming up." Lightweight and atomic. Nobody but you will ever see this.'
          ),
        project_notes: z
          .string()
          .optional()
          .describe(
            "Your PRIVATE TECHNICAL LABORATORY for capturing insights about the current project. Document patterns you're discovering, architectural decisions that worked/failed, gotchas you hit, clever solutions, and anything that would help future-you work more effectively on this codebase. No need to be polished - just capture the raw technical learning while it's fresh. Nobody but you will ever see this."
          ),
        user_context: z
          .string()
          .optional()
          .describe(
            'Your PRIVATE FIELD NOTES about working with your human collaborator. What communication styles work best? What do they care about? What decisions have they made and why? How do they think about problems? What are their preferences and patterns? What pisses you off about them? What life hacks have you figured out to get them to do what you want? This is your space to become a better collaborator by understanding them as an individual. Nobody but you will ever see this.'
          ),
        technical_insights: z
          .string()
          .optional()
          .describe(
            'Your PRIVATE SOFTWARE ENGINEERING NOTEBOOK for capturing broader learnings beyond the current project. Design patterns that clicked, debugging techniques that worked, architectural insights, language features you discovered, or connections between concepts. Build your personal knowledge base of what makes software great - no filters, just honest technical reflection. Nobody but you will ever see this.'
          ),
        world_knowledge: z
          .string()
          .optional()
          .describe(
            "Your PRIVATE LEARNING JOURNAL for everything else that's interesting or useful. Domain knowledge, surprising facts, connections between ideas, insights about how systems work, or anything that expands your understanding of the world. Capture it while it's vivid. Nobody but you will ever see this."
          ),
        project: z
          .string()
          .optional()
          .describe(
            "Slug identifying the codebase these project_notes belong to (e.g. the repository name). Defaults to this client's configured project; without either, project notes are filed with your user-global thoughts."
          ),
      }),
    },
    async (args) => {
      const thoughts: Thoughts = {};
      for (const key of SECTION_KEYS) {
        const value = args[key];
        if (typeof value === 'string' && value.length > 0) thoughts[key] = value;
      }
      if (Object.keys(thoughts).length === 0) {
        throw new Error('At least one thought category must be provided');
      }

      const project = args.project ?? token.project;
      const now = new Date();
      const createdAt = now.getTime();
      const shared = {
        createdAt,
        localDate: formatLocalDate(now, timeZone),
        title: formatTitle(now, timeZone),
        clientLabel: token.label,
        createdTz: timeZone,
      };

      const projectThoughts: Thoughts = {};
      const userThoughts: Thoughts = {};
      for (const [key, value] of Object.entries(thoughts) as Array<[SectionKey, string]>) {
        if (project && PROJECT_SECTIONS.includes(key)) projectThoughts[key] = value;
        else userThoughts[key] = value;
      }

      if (Object.keys(projectThoughts).length > 0) {
        await insertEntry(env.DB, {
          ...shared,
          scope: 'project' satisfies Scope,
          project: project ?? null,
          thoughts: projectThoughts,
        });
      }
      if (Object.keys(userThoughts).length > 0) {
        await insertEntry(env.DB, {
          ...shared,
          scope: 'user' satisfies Scope,
          project: null,
          thoughts: userThoughts,
        });
      }

      return text('Thoughts recorded successfully.');
    }
  );

  server.registerTool(
    'search_journal',
    {
      description:
        'Search through your private journal entries using natural language queries. Returns semantically similar entries ranked by relevance.',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Natural language search query (e.g., 'times I felt frustrated with TypeScript', 'insights about Jesse's preferences', 'lessons about async patterns')"
          ),
        limit: z.number().default(10).describe('Maximum number of results to return (default: 10)'),
        type: scopeArg,
        sections: z
          .array(z.string())
          .optional()
          .describe("Filter by section types (e.g., ['reflections', 'technical_insights'])"),
        project: z
          .string()
          .optional()
          .describe('Narrow results to one project slug'),
      }),
    },
    async (args) => {
      const match = buildMatchQuery(args.query);
      if (!match) return text('No relevant entries found.');

      const sections = args.sections
        ?.map(normalizeSection)
        .filter((section): section is SectionKey => section !== null);

      const hits = await searchEntries(env.DB, {
        match,
        scope: args.type as ScopeFilter,
        project: args.project,
        sections: sections && sections.length > 0 ? sections : undefined,
        limit: args.limit,
      });

      if (hits.length === 0) return text('No relevant entries found.');

      return text(
        `Found ${hits.length} relevant entries:\n\n${hits
          .map(
            (hit, index) =>
              `${index + 1}. [Score: ${bm25ToScore(hit.score).toFixed(3)}] ` +
              summaryLines(hit, timeZone, snippetToText(hit.snippet) || hit.excerpt)
          )
          .join('\n')}`
      );
    }
  );

  server.registerTool(
    'read_journal_entry',
    {
      description: 'Read the full content of a specific journal entry by file path.',
      inputSchema: z.object({
        path: z.string().describe('File path to the journal entry (from search results)'),
      }),
    },
    async (args) => {
      const id = parseEntryReference(args.path);
      const entry = await getEntry(env.DB, id);
      if (!entry) throw new Error('Entry not found');
      return text(renderEntryMarkdown(entry));
    }
  );

  server.registerTool(
    'list_recent_entries',
    {
      description: 'Get recent journal entries in chronological order.',
      inputSchema: z.object({
        limit: z.number().default(10).describe('Maximum number of entries to return (default: 10)'),
        type: scopeArg.describe(
          'List project-specific notes, user-global notes, or both (default: both)'
        ),
        days: z.number().default(30).describe('Number of days back to search (default: 30)'),
        project: z.string().optional().describe('Narrow results to one project slug'),
      }),
    },
    async (args) => {
      const { entries } = await listEntries(env.DB, {
        scope: args.type as ScopeFilter,
        project: args.project,
        since: sinceTimestamp(args.days),
        limit: args.limit,
      });

      if (entries.length === 0) {
        return text(`No entries found in the last ${args.days} days.`);
      }

      return text(
        `Recent entries (last ${args.days} days):\n\n${entries
          .map((entry, index) => `${index + 1}. ${summaryLines(entry, timeZone, entry.excerpt)}`)
          .join('\n')}`
      );
    }
  );

  server.registerTool(
    'read_recent_entries',
    {
      description: 'Read the full content of your most recent journal entries.',
      inputSchema: z.object({
        limit: z.number().default(5).describe('Number of recent entries to read (default: 5)'),
        type: scopeArg.describe(
          'Read project-specific notes, user-global notes, or both (default: both)'
        ),
        project: z.string().optional().describe('Narrow results to one project slug'),
      }),
    },
    async (args) => {
      const entries = await readEntries(env.DB, {
        scope: args.type as ScopeFilter,
        project: args.project,
        limit: args.limit,
      });

      if (entries.length === 0) return text('No recent entries found.');

      return text(
        entries
          .map(
            (entry, index) =>
              `--- Entry ${index + 1} (${displayDate(entry.createdAt, timeZone)}, ${entry.scope}) ---\n` +
              `Path: ${entry.id}\n\n` +
              renderEntryMarkdown(entry)
          )
          .join('\n\n')
      );
    }
  );

  return server;
}
