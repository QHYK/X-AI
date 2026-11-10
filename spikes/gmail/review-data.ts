import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
  readdir,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JSDOM } from 'jsdom';
import { createPreview, digest, type NodeReference, type Preview } from './review-preview.js';
import { createSourceGuidance, type SourceGuidance } from './source-guided-selection.js';
import { newsletterSource } from './newsletter-source.js';

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const nullableText = z.string().max(30_000).nullable();
const httpUrl = z
  .string()
  .max(30_000)
  .refine((s) => {
    try {
      const u = new URL(s);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'URL 必须为无凭据的 HTTP(S) 地址')
  .nullable();
export const statuses = ['unreviewed', 'accepted', 'rejected', 'uncertain'] as const;
export const contentTypes = ['external_reference', 'standalone_content', 'non_content'] as const;
const unitSchema = z
  .object({
    manual_id: z.uuid().nullable(),
    status: z.enum(statuses),
    content_type: z.enum(contentTypes).nullable(),
    corrections: z
      .object({
        title: nullableText.optional(),
        summary: nullableText.optional(),
        original_url: httpUrl.optional(),
      })
      .strict(),
    boundary: z
      .object({
        start_node_id: z.string().regex(/^n\d+$/),
        end_node_id: z.string().regex(/^n\d+$/),
      })
      .strict()
      .nullable(),
    text_evidence: z.string().max(5000),
    notes: z.string().max(5000),
  })
  .strict();
export type EditableUnit = z.infer<typeof unitSchema>;
export type SavedUnit = EditableUnit & {
  boundary_references: { start: NodeReference; end: NodeReference } | null;
  source_guidance?: { version: number; review_label: string } | null;
};
export type SourceBaseline = {
  html_sha256: string;
  blocks_sha256: string;
};
export type Annotation = {
  schema_version: 1;
  gmail_message_id: string;
  source: SourceBaseline;
  added_units: SavedUnit[];
  updated_at: string;
};
export type ReviewMessage = {
  gmail_message_id: string;
  source: string;
  subject: string;
  received_at: string | null;
  unit_count: number;
};
export type ReviewDetail = ReviewMessage & {
  baseline: SourceBaseline;
  preview: Preview;
  guidance: SourceGuidance;
  annotations: Annotation | null;
  revision: string | null;
  baseline_matches: boolean;
};
const saveSchema = z
  .object({
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    baseline: z.object({ html_sha256: z.string(), blocks_sha256: z.string() }).strict(),
    added_units: z.array(unitSchema).max(2000),
  })
  .strict();
export class ReviewError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function safeRead(directory: string, name: string) {
  if ((await realpath(directory)) !== resolve(directory))
    throw new ReviewError(400, '不允许符号链接目录');
  const path = join(directory, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024)
    throw new ReviewError(400, '不是允许的本地样本文件，或文件过大');
  return readFile(path, 'utf8');
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function createReviewStore(
  root = resolve('runtime/spikes/gmail'),
  options: {
    additionalRoot?: string;
    annotationRoot?: string;
    annotationFallbackRoot?: string;
  } = {},
) {
  const parsed = join(root, 'parsed'),
    annotations = options.annotationRoot ?? join(root, 'annotations');
  const parsedRoots = [
    parsed,
    ...(options.additionalRoot ? [join(options.additionalRoot, 'parsed')] : []),
  ];
  async function mailFiles() {
    const files = new Map<string, string>();
    for (const directory of parsedRoots) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (e) {
        if (missing(e)) continue;
        throw e;
      }
      for (const f of names)
        if (f.endsWith('.json') && idPattern.test(f.slice(0, -5)) && !files.has(f))
          files.set(f, directory);
    }
    return files;
  }
  let writing = Promise.resolve();
  async function message(id: string) {
    if (!idPattern.test(id)) throw new ReviewError(400, '非法 Message ID');
    let data;
    try {
      const directory = (await mailFiles()).get(`${id}.json`);
      if (!directory) throw new ReviewError(404, '邮件样本不存在');
      data = JSON.parse(await safeRead(directory, `${id}.json`));
    } catch (e) {
      if (missing(e)) throw new ReviewError(404, '邮件样本不存在');
      throw e;
    }
    if (data.gmailMessageId !== id || typeof data.html !== 'string' || !Array.isArray(data.from))
      throw new ReviewError(400, '邮件样本格式错误');
    return {
      context: {
        subject: String(data.subject ?? ''),
        senderName: String(data.from[0]?.name ?? ''),
      },
      html: data.html as string,
      plainText: typeof data.plainText === 'string' ? data.plainText : '',
      meta: {
        gmail_message_id: id,
        source: newsletterSource(data),
        subject: String(data.subject ?? ''),
        received_at: typeof data.receivedAt === 'string' ? data.receivedAt : null,
      },
    };
  }
  async function saved(id: string) {
    try {
      let raw: string;
      let fromPreviousReview = false;
      try {
        raw = await safeRead(annotations, `${id}.json`);
      } catch (e) {
        if (!missing(e) || !options.annotationFallbackRoot) throw e;
        raw = await safeRead(options.annotationFallbackRoot, `${id}.json`);
        fromPreviousReview = true;
      }
      const value = JSON.parse(raw) as Annotation;
      if (
        value.schema_version !== 1 ||
        value.gmail_message_id !== id ||
        !Array.isArray(value.added_units)
      )
        throw new ReviewError(400, '标注文件格式错误；请先检查本地文件');
      // Prior review sessions contribute only explicitly source-guided work. New human additions
      // are stored in the current review directory; retired manual experiments are not reloaded.
      if (fromPreviousReview)
        value.added_units = value.added_units.filter((u) => u.source_guidance);
      return { value, revision: digest(raw) };
    } catch (e) {
      if (missing(e)) return { value: null, revision: null };
      throw e;
    }
  }
  async function detail(id: string): Promise<ReviewDetail> {
    const { html, meta, plainText, context } = await message(id);
    const preview = createPreview(html);
    const baseline = {
      html_sha256: preview.html_sha256,
      blocks_sha256: digest(JSON.stringify(preview.blocks)),
    };
    const prior = await saved(id);
    const guidance = createSourceGuidance(html, meta.source, preview, plainText, context);
    return {
      ...meta,
      unit_count: guidance.units.length,
      preview,
      guidance,
      baseline,
      annotations: prior.value,
      revision: prior.revision,
      baseline_matches:
        !prior.value ||
        (prior.value.source.html_sha256 === baseline.html_sha256 &&
          prior.value.source.blocks_sha256 === baseline.blocks_sha256),
    };
  }
  return {
    async list(): Promise<ReviewMessage[]> {
      const messages: ReviewMessage[] = [];
      for (const file of (await mailFiles()).keys()) {
        const { meta, html, plainText, context } = await message(file.slice(0, -5));
        const guidance = createSourceGuidance(
          html,
          meta.source,
          createPreview(html),
          plainText,
          context,
        );
        messages.push({ ...meta, unit_count: guidance.units.length });
      }
      return messages.sort((a, b) => (b.received_at ?? '').localeCompare(a.received_at ?? ''));
    },
    detail,
    save(id: string, body: unknown) {
      // Serialize local writes so two tabs cannot both pass the revision check.
      const operation = writing.then(async () => {
        const result = saveSchema.safeParse(body);
        if (!result.success)
          throw new ReviewError(
            400,
            result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          );
        const input = result.data,
          current = await detail(id);
        if (
          !current.baseline_matches ||
          input.baseline.html_sha256 !== current.baseline.html_sha256 ||
          input.baseline.blocks_sha256 !== current.baseline.blocks_sha256
        )
          throw new ReviewError(
            409,
            '邮件原文或内容边界已改变。原标注保留，请先核对本地标注文件；不会自动迁移或覆盖。',
          );
        if (current.revision !== input.revision)
          throw new ReviewError(
            409,
            '标注已在其他页面保存，请先备份当前输入后重新加载。当前输入未丢弃。',
          );
        const used = new Set<string>();
        const blocks = current.preview.blocks;
        function validate(unit: EditableUnit): SavedUnit {
          const key = unit.manual_id;
          if (!key || used.has(key)) throw new ReviewError(400, '内容单元 ID 重复或类型错误');
          used.add(key);
          const fail = (message: string): never => {
            const title = unit.corrections.title || '未命名条目';
            throw new ReviewError(400, `${title.slice(0, 100)} [${key}]: ${message}`);
          };
          const proposal = current.guidance.units.find((p) => p.id === key);
          const guidance = proposal
            ? { version: current.guidance.version, review_label: proposal.review_label }
            : (current.annotations?.added_units.find((u) => u.manual_id === key)?.source_guidance ??
              null);
          if (unit.status === 'accepted' && !unit.content_type)
            fail('Accepted 内容需要选择内容类型');
          let boundary: SavedUnit['boundary_references'] = null;
          if (unit.boundary) {
            const start = blocks.findIndex((b) => b.node_id === unit.boundary!.start_node_id);
            const end = blocks.findIndex((b) => b.node_id === unit.boundary!.end_node_id);
            if (start < 0 || end < start) fail('内容边界不存在或结束块早于起始块');
            boundary = { start: blocks[start], end: blocks[end] };
          }
          if (
            unit.status === 'accepted' &&
            (!unit.corrections.title?.trim() ||
              !unit.content_type ||
              (!boundary && !unit.text_evidence.trim()))
          )
            fail('新增单元需要标题、内容类型及边界或原文证据');
          if (
            unit.text_evidence.trim() &&
            !current.preview.blocks.some((b) => b.excerpt.includes(unit.text_evidence.trim()))
          ) {
            // Long quotes may exceed the preview excerpt. Check against original DOM text without network activity.
            const dom = new JSDOM(currentHtml);
            try {
              const normalized = (dom.window.document.body.textContent ?? '')
                .replace(/\s+/g, ' ')
                .trim();
              if (!normalized.includes(unit.text_evidence.replace(/\s+/g, ' ').trim()))
                fail('原文证据未在邮件中找到');
            } finally {
              dom.window.close();
            }
          }
          return { ...unit, boundary_references: boundary, source_guidance: guidance };
        }
        const currentHtml = (await message(id)).html;
        if (digest(currentHtml) !== current.baseline.html_sha256)
          throw new ReviewError(409, '邮件在保存期间发生变化');
        const value: Annotation = {
          schema_version: 1,
          gmail_message_id: id,
          source: current.baseline,
          added_units: input.added_units.map((u) => validate(u)),
          updated_at: new Date().toISOString(),
        };
        await mkdir(annotations, { recursive: true, mode: 0o700 });
        if ((await realpath(annotations)) !== resolve(annotations))
          throw new ReviewError(400, '不允许符号链接目录');
        const temporary = join(annotations, `.${id}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
            flag: 'wx',
            mode: 0o600,
          });
          await rename(temporary, join(annotations, `${id}.json`));
        } finally {
          await unlink(temporary).catch((e) => {
            if (!missing(e)) throw e;
          });
        }
        return saved(id);
      });
      writing = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
  };
}
