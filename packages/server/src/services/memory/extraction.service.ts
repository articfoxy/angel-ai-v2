import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { prisma } from '../../index';
import { RetrievalService } from './retrieval.service';

interface ExtractedFact {
  content: string;
  category: string;
  importance: number;
  entities: Array<{ name: string; type: string }>;
  relationships: Array<{ from: string; to: string; type: string }>;
}

export class ExtractionService {
  private openai: OpenAI;
  private retrieval: RetrievalService;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
    this.retrieval = new RetrievalService(apiKey);
  }

  async processSession(sessionId: string, userId: string): Promise<{
    summary: string;
    memoriesExtracted: number;
    entitiesFound: number;
    duration: number | null;
  }> {
    const startTime = Date.now();

    // 1. Get all episodes from session
    const episodes = await prisma.episode.findMany({
      where: { sessionId },
      orderBy: { startTime: 'asc' },
    });

    if (episodes.length === 0) {
      return { summary: 'No transcript available', memoriesExtracted: 0, entitiesFound: 0, duration: 0 };
    }

    // Build full transcript
    const transcript = episodes
      .map((ep) => `[${ep.speaker}]: ${ep.content}`)
      .join('\n');

    // 2. Extract facts, entities, relationships via LLM
    const extraction = await this.extractFacts(transcript);

    // 3. Reconcile with existing memories (Mem0-style ADD/UPDATE/DELETE/NOOP)
    let memoriesExtracted = 0;
    try {
      await this.reconcileMemories(userId, extraction.facts, sessionId);
      memoriesExtracted = extraction.facts.length;
    } catch (err) {
      console.error('Memory reconciliation error:', err);
    }

    // 4. Extract/update entities
    let entitiesFound = 0;
    try {
      await this.reconcileEntities(userId, extraction.entities);
      entitiesFound = extraction.entities.length;
    } catch (err) {
      console.error('Entity reconciliation error:', err);
    }

    // 5. Create relationships
    try {
      await this.createRelationships(userId, extraction.relationships, sessionId);
    } catch (err) {
      console.error('Relationship creation error:', err);
    }

    // 6. Update core memory if significant
    try {
      await this.updateCoreMemory(userId, extraction.coreUpdates);
    } catch (err) {
      console.error('Core memory update error:', err);
    }

    // 7. Generate session summary
    const summaryResult = await this.generateSummary(transcript);
    const summary = typeof summaryResult === 'object' ? summaryResult.summary || 'Session completed' : String(summaryResult);
    const duration = Math.round((Date.now() - startTime) / 1000);

    return { summary, memoriesExtracted, entitiesFound, duration };
  }

  private async extractFacts(transcript: string): Promise<{
    facts: ExtractedFact[];
    entities: Array<{ name: string; type: string; aliases?: string[] }>;
    relationships: Array<{ from: string; to: string; type: string }>;
    coreUpdates: Record<string, string>;
  }> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a memory extraction engine. Analyze the conversation transcript and extract:

1. **facts**: Key facts, decisions, preferences, events mentioned. Each with:
   - content: the fact as a concise statement
   - category: one of "fact", "preference", "opinion", "event", "decision", "commitment"
   - importance: 1-10 scale
   - entities: people, orgs, topics mentioned in this fact
   - relationships: connections between entities

2. **entities**: People, organizations, places, topics mentioned. Each with:
   - name: primary name
   - type: "person", "org", "place", "topic"
   - aliases: alternative names used

3. **relationships**: Connections between entities. Each with:
   - from: entity name
   - to: entity name
   - type: "works_with", "discussed", "friend_of", "reports_to", "interested_in", etc.

4. **coreUpdates**: If the conversation reveals important information about the user (the "Owner" speaker), provide updates as:
   - userProfile: new info about the user
   - preferences: new preferences discovered
   - keyPeople: important people mentioned
   - activeGoals: goals or objectives mentioned

Return valid JSON only.`,
        },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    try {
      return JSON.parse(response.choices[0].message.content || '{}');
    } catch {
      return { facts: [], entities: [], relationships: [], coreUpdates: {} };
    }
  }

  private async reconcileMemories(userId: string, facts: ExtractedFact[], sessionId: string) {
    for (const fact of facts) {
      // Check for existing similar memories
      try {
        const embedding = await this.retrieval.getEmbedding(fact.content);
        const vectorStr = `[${embedding.join(',')}]`;

        const similar = await prisma.$queryRawUnsafe<any[]>(
          `SELECT id, content, importance, embedding <=> $1::vector AS distance
           FROM "Memory"
           WHERE "userId" = $2 AND "validTo" IS NULL AND embedding IS NOT NULL
           ORDER BY distance ASC
           LIMIT 1`,
          vectorStr,
          userId
        );

        if (similar.length > 0 && similar[0].distance < 0.15) {
          // Very similar — UPDATE existing memory: merge content instead of overwriting
          const existingContent: string = similar[0].content;
          let mergedContent: string;
          if (existingContent === fact.content) {
            mergedContent = existingContent;
          } else if (fact.content.toLowerCase().includes(existingContent.toLowerCase())) {
            // New content subsumes old — use the new, more complete version
            mergedContent = fact.content;
          } else {
            // Append new info, noting if it differs
            mergedContent = `${existingContent} [updated: ${fact.content}]`;
          }

          // Refresh the embedding since content changed
          await prisma.$executeRawUnsafe(
            `UPDATE "Memory" SET content = $1, importance = $2, embedding = $3::vector WHERE id = $4`,
            mergedContent,
            Math.max(fact.importance, similar[0].importance ?? 0),
            vectorStr,
            similar[0].id
          );
        } else {
          // New fact — ADD
          await prisma.$executeRawUnsafe(
            `INSERT INTO "Memory" (id, "userId", content, embedding, importance, category, source, "validFrom", "createdAt", "accessCount")
             VALUES ($1, $2, $3, $4::vector, $5, $6, $7, NOW(), NOW(), 0)`,
            randomUUID(),
            userId,
            fact.content,
            vectorStr,
            fact.importance,
            fact.category,
            sessionId
          );
        }
      } catch (err) {
        // Fallback: insert without embedding
        await prisma.memory.create({
          data: {
            userId,
            content: fact.content,
            importance: fact.importance,
            category: fact.category,
            source: sessionId,
          },
        });
      }
    }
  }

  private async reconcileEntities(
    userId: string,
    entities: Array<{ name: string; type: string; aliases?: string[] }>
  ) {
    for (const entity of entities) {
      // Check if entity already exists (by name or alias)
      const existing = await prisma.entity.findFirst({
        where: {
          userId,
          OR: [
            { name: entity.name },
            { aliases: { has: entity.name } },
          ],
        },
      });

      if (existing) {
        // Merge aliases, cap at 10 (drop oldest/first entries if over limit)
        const MAX_ALIASES = 10;
        const newAliases = new Set([
          ...existing.aliases,
          ...(entity.aliases || []),
          entity.name,
        ]);
        newAliases.delete(existing.name);

        let aliasArray = Array.from(newAliases);
        if (aliasArray.length > MAX_ALIASES) {
          aliasArray = aliasArray.slice(aliasArray.length - MAX_ALIASES);
        }

        await prisma.entity.update({
          where: { id: existing.id },
          data: { aliases: aliasArray },
        });
      } else {
        await prisma.entity.create({
          data: {
            userId,
            name: entity.name,
            type: entity.type,
            aliases: entity.aliases || [],
          },
        });
      }
    }
  }

  private async createRelationships(
    userId: string,
    relationships: Array<{ from: string; to: string; type: string }>,
    sessionId: string
  ) {
    for (const rel of relationships) {
      const fromEntity = await prisma.entity.findFirst({
        where: { userId, OR: [{ name: rel.from }, { aliases: { has: rel.from } }] },
      });
      const toEntity = await prisma.entity.findFirst({
        where: { userId, OR: [{ name: rel.to }, { aliases: { has: rel.to } }] },
      });

      if (fromEntity && toEntity) {
        // Check for existing relationship
        const existing = await prisma.relationship.findFirst({
          where: { fromId: fromEntity.id, toId: toEntity.id, type: rel.type, validTo: null },
        });

        if (existing) {
          // Strengthen weight
          await prisma.relationship.update({
            where: { id: existing.id },
            data: { weight: { increment: 0.1 } },
          });
        } else {
          await prisma.relationship.create({
            data: {
              fromId: fromEntity.id,
              toId: toEntity.id,
              type: rel.type,
              source: sessionId,
            },
          });
        }
      }
    }
  }

  private async updateCoreMemory(userId: string, updates: Record<string, string>) {
    if (!updates || Object.keys(updates).length === 0) return;

    // Upsert CoreMemory — create if it doesn't exist (new users)
    const core = await prisma.coreMemory.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    const data: Record<string, string> = {};
    for (const [field, value] of Object.entries(updates)) {
      if (value && ['userProfile', 'preferences', 'keyPeople', 'activeGoals'].includes(field)) {
        // Append to existing rather than replace
        const existing = (core as any)[field] || '';
        if (!existing.includes(value)) {
          data[field] = existing ? `${existing}\n${value}` : value;
        }
      }
    }

    if (Object.keys(data).length > 0) {
      await prisma.coreMemory.update({ where: { userId }, data });
    }
  }

  private async generateSummary(transcript: string): Promise<any> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Summarize this conversation concisely. Include:
- Brief summary (2-3 sentences)
- Key decisions made
- Action items identified
- Important topics discussed
Return as JSON with fields: summary, decisions, actionItems, topics`,
        },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    try {
      return JSON.parse(response.choices[0].message.content || '{}');
    } catch {
      return { summary: 'Session completed' };
    }
  }
}
