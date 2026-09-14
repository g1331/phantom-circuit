import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, unlink, access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Multipart } from '@fastify/multipart';
import sharp from 'sharp';
import { z } from 'zod';
import { Fault, Store, id } from './store.ts';
import type { ImageAttachment, Message } from '../shared/types.ts';

export const imageLimits = {
  files: 4,
  fileSize: 10 * 1024 * 1024,
  fields: 2,
  fieldSize: 120000,
  parts: 6,
};
const formats = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
const messageFields = z
  .object({
    content: z.string().trim().max(30000).default(''),
    intent: z.enum(['discuss', 'implement', 'feedback']),
  })
  .strict();

export class MessageImages {
  private root: string;
  constructor(
    private store: Store,
    dataDir: string,
  ) {
    this.root = resolve(dataDir, 'messages');
  }

  async create(projectId: string, parts: AsyncIterable<Multipart>) {
    this.store.project(projectId);
    const projectDir = join(this.root, projectId);
    await mkdir(projectDir, { recursive: true });
    const staging = await mkdtemp(join(projectDir, '.upload-'));
    const messageId = id();
    const destination = join(projectDir, messageId);
    let promoted = false;
    const iterator = parts[Symbol.asyncIterator]();
    try {
      const fields: Record<string, string> = {};
      const attachments: ImageAttachment[] = [];
      while (true) {
        let item: IteratorResult<Multipart>;
        try {
          item = await iterator.next();
        } catch (error) {
          if ((error as { code?: string }).code?.startsWith('FST_')) throw error;
          throw new Fault('图片上传不完整或字段无效，请重试');
        }
        if (item.done) break;
        const part = item.value;
        if (part.type === 'field') {
          if (
            Object.hasOwn(fields, part.fieldname) ||
            part.valueTruncated ||
            typeof part.value !== 'string'
          )
            throw new Fault('消息字段重复或过长');
          fields[part.fieldname] = part.value;
          continue;
        }
        if (part.fieldname !== 'images') {
          part.file.resume();
          throw new Fault('只允许上传图片字段 images');
        }
        const attachmentId = id();
        const uploaded = join(staging, `${attachmentId}.upload`);
        // Multipart limit handling can close a queued file before the consumer reaches it.
        if (part.file.destroyed)
          throw new Fault('上传中断或超限：最多 4 张图片，每张不超过 10 MiB');
        await pipeline(part.file, createWriteStream(uploaded, { flags: 'wx' }));
        if (part.file.truncated) throw new Fault('每张图片不能超过 10 MiB', 413);
        const decoder = sharp(await readFile(uploaded), {
          limitInputPixels: 25_000_000,
          failOn: 'warning',
        });
        let attachment: ImageAttachment;
        try {
          const metadata = await decoder.metadata();
          const format = metadata.format;
          if (!format || !(format in formats) || (metadata.pages ?? 1) > 1)
            throw new Fault('仅支持静态 PNG、JPEG、WebP 图片');
          const supported = format as keyof typeof formats;
          const output = await decoder
            .rotate()
            .toFormat(supported)
            .toFile(join(staging, `${attachmentId}.${supported}`));
          attachment = {
            id: attachmentId,
            name:
              part.filename
                .replace(/[\\/]/g, '_')
                .replace(/[\u0000-\u001f]/g, '')
                .slice(0, 200) || 'image',
            mediaType: formats[supported],
            size: output.size,
            width: output.width,
            height: output.height,
          };
        } catch (error) {
          if (error instanceof Fault) throw error;
          throw new Fault('图片损坏、格式不支持或超过 2500 万像素限制');
        } finally {
          decoder.destroy();
        }
        await unlink(uploaded);
        attachments.push(attachment);
      }
      const fieldsValue = messageFields.parse(fields);
      if (!fieldsValue.content && !attachments.length) throw new Fault('请输入文字或选择图片');
      await rename(staging, destination);
      promoted = true;
      return this.store.transaction(() =>
        this.store.addMessage(
          projectId,
          'user',
          fieldsValue.content,
          fieldsValue.intent,
          attachments,
          messageId,
        ),
      );
    } catch (error) {
      // Drain remaining bounded parts so a rejected image does not leave unread file streams.
      try {
        for (let item = await iterator.next(); !item.done; item = await iterator.next()) {
          if (item.value.type === 'file') item.value.file.resume();
        }
      } catch {
        // Preserve the original failure if the multipart parser also rejects the remainder.
      }
      await rm(promoted ? destination : staging, { recursive: true, force: true });
      throw error;
    }
  }

  locate(projectId: string, messageId: string, attachmentId: string) {
    const message = this.store.get('message', messageId);
    const attachment = message?.attachments?.find((a) => a.id === attachmentId);
    const format = Object.entries(formats).find(
      ([, mediaType]) => mediaType === attachment?.mediaType,
    )?.[0];
    if (
      !message ||
      message.projectId !== projectId ||
      !attachment ||
      ![projectId, messageId, attachmentId].every((value) => z.uuid().safeParse(value).success) ||
      !format
    )
      throw new Fault('图片不存在', 404);
    return { attachment, path: join(this.root, projectId, messageId, `${attachmentId}.${format}`) };
  }

  async paths(message: Message) {
    return Promise.all(
      (message.attachments ?? []).map(async (attachment) => {
        const { path } = this.locate(message.projectId, message.id, attachment.id);
        try {
          await access(path);
        } catch {
          throw new Fault('消息图片文件不可用', 404);
        }
        return path;
      }),
    );
  }
}
